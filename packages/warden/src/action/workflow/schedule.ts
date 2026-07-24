/**
 * Schedule Workflow
 *
 * Handles schedule and workflow_dispatch events.
 */

import type { Octokit } from '@octokit/rest';
import {
  buildSkillRootsByName,
  loadLayeredWardenConfig,
  resolveLayeredSkillConfigs,
  ConfigLoadError,
} from '../../config/loader.js';
import type { LayeredSkillRootsByName, ResolvedTrigger } from '../../config/loader.js';
import type { ScheduleConfig } from '../../config/schema.js';
import { buildScheduleEventContext } from '../../event/schedule-context.js';
import { runSkill } from '../../sdk/runner.js';
import { assertValidPiModelSelectors } from '../../sdk/runtimes/model-selectors.js';
import { createOrUpdateIssue, type IssueResult } from '../../output/github-issues.js';
import { shouldFail, countFindingsAtOrAbove, countSeverity } from '../../triggers/matcher.js';
import { resolveSkillAsync } from '../../skills/loader.js';
import { filterFindings } from '../../types/index.js';
import type { EventContext, SkillReport } from '../../types/index.js';
import { Sentry, logger, setRepositoryScope, emitRunMetric } from '../../sentry.js';
import type { ActionInputs } from '../inputs.js';
import {
  setOutput,
  setFailed,
  ActionFailedError,
  logGroup,
  logGroupEnd,
  prepareRuntimeEnvironment,
  handleTriggerErrors,
  getDefaultBranchFromAPI,
  writeFindingsOutput,
  writeFindingsOutputs,
  writeSchemaV2Output,
  writeSchemaV2OutputLive,
  buildV2WriteOptions,
} from './base.js';
import type { TriggerResult } from '../triggers/executor.js';
import type { FindingProcessingEvent } from '../../sdk/types.js';
import { buildConfiguredSkillsList } from '../reporting/output.js';
import { captureActionTriggerError } from '../error-reporting.js';

// -----------------------------------------------------------------------------
// Main Schedule Workflow
// -----------------------------------------------------------------------------

interface WorkflowSpan {
  setAttribute(key: string, value: string | number | boolean): void;
  spanContext?: () => { traceId: string };
}

function writeSchemaV2ScheduleOutputs(
  inputs: ActionInputs,
  context: EventContext,
  resolvedTriggers: ResolvedTrigger[],
  matchedTriggers: ResolvedTrigger[],
  results: TriggerResult[]
): void {
  if (inputs.outputSchemaVersion !== '2') return;

  try {
    const { metadataPath, findingsPath } = writeSchemaV2Output(
      context, resolvedTriggers, matchedTriggers, results, [],
      buildV2WriteOptions(inputs)
    );
    console.log(`Metadata written to ${metadataPath}`);
    console.log(`Findings (v2) written to ${findingsPath}`);
  } catch (error) {
    console.error(`::warning::Failed to write schema-v2 output: ${error}`);
  }
}

/**
 * Live counterpart of {@link writeSchemaV2ScheduleOutputs}, fired after each
 * trigger completes. Unlike `pr-workflow.ts`, `matchedTriggers` here grows
 * incrementally inside the same sequential loop this is called from, so a
 * trigger this loop simply hasn't reached yet must be reported as `'pending'`
 * rather than a guessed skip reason.
 */
function writeSchemaV2ScheduleOutputsLive(
  inputs: ActionInputs,
  context: EventContext,
  resolvedTriggers: ResolvedTrigger[],
  matchedTriggers: ResolvedTrigger[],
  results: TriggerResult[],
  processedTriggerIds: Set<string>
): void {
  if (inputs.outputSchemaVersion !== '2') return;
  const pendingTriggerIds = new Set(
    resolvedTriggers
      .filter((t) => t.type === 'schedule' && !processedTriggerIds.has(t.id))
      .map((t) => t.id)
  );
  writeSchemaV2OutputLive(context, resolvedTriggers, matchedTriggers, results, [], {
    ...buildV2WriteOptions(inputs),
    pendingTriggerIds,
  });
}

export async function runScheduleWorkflow(
  octokit: Octokit,
  inputs: ActionInputs,
  repoPath: string
): Promise<void> {
  return Sentry.startSpan(
    { op: 'workflow.run', name: 'review schedule' },
    (span) => runScheduleWorkflowInner(octokit, inputs, repoPath, span),
  );
}

async function runScheduleWorkflowInner(
  octokit: Octokit,
  inputs: ActionInputs,
  repoPath: string,
  workflowSpan: WorkflowSpan
): Promise<void> {
  const githubRepository = process.env['GITHUB_REPOSITORY'];
  setRepositoryScope(githubRepository);

  logGroup('Loading configuration');
  if (inputs.baseConfigPath) {
    console.log(`Base config path: ${inputs.baseConfigPath}`);
  }
  if (inputs.baseSkillRoot) {
    console.log(`Base skill root: ${inputs.baseSkillRoot}`);
  }
  console.log(`Repo config path: ${inputs.configPath}`);
  logGroupEnd();

  let scheduleTriggers: ResolvedTrigger[];
  let allResolvedTriggers: ResolvedTrigger[];
  let skillRootsByName: LayeredSkillRootsByName | undefined;
  try {
    const layered = loadLayeredWardenConfig(repoPath, {
      baseConfigPath: inputs.baseConfigPath,
      configPath: inputs.configPath,
      onWarning: (message) => console.log(`::warning::${message}`),
    });
    skillRootsByName = buildSkillRootsByName(repoPath, layered, inputs.baseSkillRoot);
    allResolvedTriggers = resolveLayeredSkillConfigs(layered, undefined, skillRootsByName);
    scheduleTriggers = allResolvedTriggers.filter((t) => t.type === 'schedule');
  } catch (error) {
    if (
      error instanceof ConfigLoadError &&
      error.message.includes('not found') &&
      !inputs.baseConfigPath
    ) {
      console.log('::warning::No warden.toml found. Skipping analysis.');
      setOutput('findings-count', 0);
      setOutput('high-count', 0);
      setOutput('summary', 'No warden.toml found');
      const fullName = process.env['GITHUB_REPOSITORY'] ?? '';
      const [o = '', n = ''] = fullName.split('/');
      workflowSpan.setAttribute('warden.trigger.count', 0);
      workflowSpan.setAttribute('warden.finding.count', 0);
      const emptyContext: EventContext = {
        eventType: 'schedule',
        action: 'scheduled',
        repository: { owner: o, name: n, fullName, defaultBranch: '' },
        repoPath,
      };
      writeFindingsOutputs(
        () => writeFindingsOutput([], emptyContext, [], { configuredSkills: [] }),
        () => writeSchemaV2ScheduleOutputs(inputs, emptyContext, [], [], []),
        (message) => console.error(`::warning::${message}`)
      );
      return;
    }
    throw error;
  }

  workflowSpan.setAttribute('warden.trigger.count', scheduleTriggers.length);
  emitRunMetric();
  const traceId = workflowSpan.spanContext?.().traceId;
  logger.info('Workflow initialized', {
    'warden.trigger.count': scheduleTriggers.length,
    ...(traceId ? { 'trace.id': traceId } : {}),
  });

  if (scheduleTriggers.length === 0) {
    console.log('No schedule triggers configured');
    setOutput('findings-count', 0);
    setOutput('high-count', 0);
    setOutput('summary', 'No schedule triggers configured');
    workflowSpan.setAttribute('warden.finding.count', 0);
    const fullName = process.env['GITHUB_REPOSITORY'] ?? '';
    const [o = '', n = ''] = fullName.split('/');
    const emptyContext: EventContext = {
      eventType: 'schedule',
      action: 'scheduled',
      repository: { owner: o, name: n, fullName, defaultBranch: '' },
      repoPath,
    };
    writeFindingsOutputs(
      () => writeFindingsOutput([], emptyContext, [], {
        configuredSkills: buildConfiguredSkillsList({ allTriggers: allResolvedTriggers, matchedTriggers: [] }),
      }),
      () => writeSchemaV2ScheduleOutputs(inputs, emptyContext, allResolvedTriggers, [], []),
      (message) => console.error(`::warning::${message}`)
    );
    return;
  }

  // Get repo info from environment
  if (!githubRepository) {
    setFailed('GITHUB_REPOSITORY environment variable not set');
  }
  const [owner, repo] = githubRepository.split('/');
  if (!owner || !repo) {
    setFailed('Invalid GITHUB_REPOSITORY format');
  }

  const headSha = process.env['GITHUB_SHA'] ?? '';
  if (!headSha) {
    setFailed('GITHUB_SHA environment variable not set');
  }

  const defaultBranch = await getDefaultBranchFromAPI(octokit, owner, repo);

  // Hoisted above the trigger loop so the live-write path can use it as each trigger completes.
  const scheduleContext: EventContext = {
    eventType: 'schedule',
    action: 'scheduled',
    repository: { owner, name: repo, fullName: `${owner}/${repo}`, defaultBranch },
    repoPath,
  };

  logGroup('Processing schedule triggers');
  for (const trigger of scheduleTriggers) {
    console.log(`- ${trigger.name}: ${trigger.skill}`);
  }
  logGroupEnd();

  const allReports: SkillReport[] = [];
  const matchedTriggers: ResolvedTrigger[] = [];
  const results: TriggerResult[] = [];
  const processedTriggerIds = new Set<string>();
  let totalFindings = 0;
  const failureReasons: string[] = [];
  const triggerErrors: string[] = [];
  let shouldFailAction = false;

  // Process each schedule trigger
  for (const resolved of scheduleTriggers) {
    processedTriggerIds.add(resolved.id);
    logGroup(`Running trigger: ${resolved.name} (skill: ${resolved.skill})`);

    try {
      assertValidPiModelSelectors([resolved]);

      // Build context from paths filter
      const patterns = resolved.filters?.paths ?? ['**/*'];
      const ignorePatterns = resolved.filters?.ignorePaths;

      const context = await buildScheduleEventContext({
        patterns,
        ignorePatterns,
        ignore: resolved.ignore,
        scan: resolved.scan,
        repoPath,
        owner,
        name: repo,
        defaultBranch,
        headSha,
      });

      // Skip if no matching files
      if (!context.pullRequest?.files.length) {
        console.log(`No files match trigger ${resolved.name}`);
        logGroupEnd();
        continue;
      }

      console.log(`Found ${context.pullRequest.files.length} files matching patterns`);

      // Run skill
      const skillRoot = resolved.useBuiltinSkill ? undefined : (resolved.skillRoot ?? repoPath);
      const skill = await resolveSkillAsync(resolved.skill, skillRoot, {
        remote: resolved.remote,
      });
      const runtimeEnv = await prepareRuntimeEnvironment([resolved], inputs);
      const findingProcessingEvents: FindingProcessingEvent[] = [];
      const report = await runSkill(skill, context, {
        apiKey: inputs.anthropicApiKey,
        model: resolved.model,
        runtime: resolved.runtime,
        effort: resolved.effort,
        auxiliaryModel: resolved.auxiliaryModel,
        synthesisModel: resolved.synthesisModel,
        maxTurns: resolved.maxTurns,
        batchDelayMs: resolved.batchDelayMs,
        maxContextFiles: resolved.maxContextFiles,
        ignore: resolved.ignore,
        scan: resolved.scan,
        chunking: resolved.chunking,
        auxiliaryMaxRetries: resolved.auxiliaryMaxRetries,
        verifyFindings: resolved.verifyFindings,
        triggerName: resolved.name,
        pathToClaudeCodeExecutable: runtimeEnv.pathToClaudeCodeExecutable,
        callbacks: {
          onFindingProcessing: (event) => findingProcessingEvents.push(event),
        },
      });
      console.log(`Found ${report.findings.length} findings`);

      allReports.push(report);
      matchedTriggers.push(resolved);

      // Create/update issue with findings. Failures here are logged but must
      // not drop the trigger's own successful report/findings from `results`
      // - that would desync the v2 output (which reads from `results`) from
      // `allReports`/`totalFindings` (which already counted this report).
      const scheduleConfig: Partial<ScheduleConfig> = resolved.schedule ?? {};
      const issueTitle = scheduleConfig.issueTitle ?? `Warden: ${resolved.name}`;

      let issueResult: IssueResult | null = null;
      try {
        issueResult = await createOrUpdateIssue(octokit, owner, repo, [report], {
          title: issueTitle,
          commitSha: headSha,
        });
      } catch (error) {
        console.error(`::warning::Failed to create/update issue for ${resolved.name}: ${error}`);
      }

      if (issueResult) {
        console.log(`${issueResult.created ? 'Created' : 'Updated'} issue #${issueResult.issueNumber}`);
        console.log(`Issue URL: ${issueResult.issueUrl}`);
      }

      results.push({
        triggerId: resolved.id,
        triggerName: resolved.name,
        skillName: resolved.skill,
        skillExecutionId: resolved.skillExecutionId,
        report,
        findingProcessingEvents,
        issueNumber: issueResult?.issueNumber,
        issueUrl: issueResult?.issueUrl,
      });
      writeSchemaV2ScheduleOutputsLive(
        inputs, scheduleContext, allResolvedTriggers, matchedTriggers, results, processedTriggerIds
      );
      totalFindings += report.findings.length;

      // Check failure condition
      // Filter by confidence first so low-confidence findings don't cause failure
      const failOn = resolved.failOn ?? inputs.failOn;
      const failCheck = resolved.failCheck ?? inputs.failCheck ?? false;
      const reportForFail = { ...report, findings: filterFindings(report.findings, undefined, resolved.minConfidence ?? 'medium') };
      if (failCheck && failOn && shouldFail(reportForFail, failOn)) {
        shouldFailAction = true;
        const count = countFindingsAtOrAbove(reportForFail, failOn);
        failureReasons.push(`${resolved.name}: Found ${count} ${failOn}+ severity issues`);
      }

      logGroupEnd();
    } catch (error) {
      if (error instanceof ActionFailedError) throw error;
      captureActionTriggerError(error, {
        triggerName: resolved.name,
        skillName: resolved.skill,
      });
      const errorMessage = error instanceof Error ? error.message : String(error);
      triggerErrors.push(`${resolved.name}: ${errorMessage}`);
      matchedTriggers.push(resolved);
      results.push({
        triggerId: resolved.id,
        triggerName: resolved.name,
        skillName: resolved.skill,
        skillExecutionId: resolved.skillExecutionId,
        error,
      });
      writeSchemaV2ScheduleOutputsLive(
        inputs, scheduleContext, allResolvedTriggers, matchedTriggers, results, processedTriggerIds
      );
      console.error(`::warning::Trigger ${resolved.name} failed: ${error}`);
      logGroupEnd();
    }
  }

  // Set outputs
  const highCount = countSeverity(allReports, 'high');
  workflowSpan.setAttribute('warden.finding.count', totalFindings);

  setOutput('findings-count', totalFindings);
  setOutput('high-count', highCount);
  setOutput('summary', allReports.map((r) => r.summary).join('\n') || 'Scheduled analysis complete');

  // Write structured findings to file for external export (GCS, S3, etc.)
  writeFindingsOutputs(
    () => writeFindingsOutput(allReports, scheduleContext, [], {
      configuredSkills: buildConfiguredSkillsList({ allTriggers: allResolvedTriggers, matchedTriggers }),
    }),
    () => writeSchemaV2ScheduleOutputs(inputs, scheduleContext, allResolvedTriggers, matchedTriggers, results),
    (message) => console.error(`::warning::${message}`),
    (path) => console.log(`Findings written to ${path}`)
  );

  // Both outputs are written above, so a total-failure or threshold exit below
  // never discards artifacts that already reflect this run's results.
  handleTriggerErrors(triggerErrors, scheduleTriggers.length);

  if (shouldFailAction) {
    setFailed(failureReasons.join('; '));
  }

  console.log(`\nScheduled analysis complete: ${totalFindings} total findings`);
}
