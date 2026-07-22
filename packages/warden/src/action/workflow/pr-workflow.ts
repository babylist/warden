/**
 * PR Workflow
 *
 * Handles pull_request and push events. PR runs may execute in legacy `run`
 * mode or the split `analyze`/`report` flow: analyze owns skill execution and
 * artifact creation, while report owns GitHub writes and must only replay an
 * artifact that matches the current PR context.
 */

import { readFileSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';
import type { Octokit } from '@octokit/rest';
import { Sentry, logger, emitStaleResolutionMetric, setRepositoryScope, emitRunMetric } from '../../sentry.js';
import {
  buildSkillRootsByName,
  loadLayeredWardenConfig,
  resolveLayeredSkillConfigs,
  ConfigLoadError,
  emptyToUndefined,
} from '../../config/loader.js';
import type {
  LayeredSkillRootsByName,
  LoadedLayeredConfig,
  ResolvedTrigger,
} from '../../config/loader.js';
import { buildEventContext } from '../../event/context.js';
import { matchTrigger, shouldFail, countFindingsAtOrAbove } from '../../triggers/matcher.js';
import { fetchExistingComments } from '../../output/dedup.js';
import type { ExistingComment } from '../../output/dedup.js';
import { buildAnalyzedScope, findStaleComments, resolveStaleComments } from '../../output/stale.js';
import { filterFindings } from '../../types/index.js';
import type { EventContext, SkillReport, Finding } from '../../types/index.js';
import { runPool, Semaphore } from '../../utils/index.js';
import { evaluateFixAttempts, postThreadReply } from '../fix-evaluation/index.js';
import type { EvaluateFixAttemptsResult, FixEvaluation } from '../fix-evaluation/index.js';
import { aggregateUsage } from '../../sdk/usage.js';
import { logAction, warnAction } from '../../cli/output/tty.js';
import { formatCost, formatTokens, formatDuration } from '../../cli/output/formatters.js';
import { findBotReviewState } from '../review-state.js';
import type { BotReviewInfo } from '../review-state.js';
import type { ActionInputs } from '../inputs.js';
import { executeTrigger } from '../triggers/executor.js';
import type { TriggerCheckReporter, TriggerResult } from '../triggers/executor.js';
import { postTriggerReview } from '../review/poster.js';
import { shouldResolveStaleComments } from '../review/coordination.js';
import { ReviewFeedbackGate } from '../review/review-feedback-gate.js';
import type { ReviewFeedbackWritability } from '../review/review-feedback-gate.js';
import type { FindingObservation } from '../reporting/outcomes.js';
import type { RuntimeName } from '../../sdk/runtimes/index.js';
import { canUseRuntimeAuth } from '../../sdk/extract.js';
import { ProviderFailureCircuitBreaker } from '../../sdk/circuit-breaker.js';
import {
  createCoreCheck,
  createCompletedCoreCheck,
  createCompletedSkillCheck,
  createSkillCheck,
  createFailedSkillCheck,
  failSkillCheck,
  updateCoreCheck,
  updateSkillCheck,
  buildCoreSummaryData,
  determineCoreConclusion,
  type CheckOptions,
  type CoreCheckSummaryData,
} from '../checks/manager.js';
import {
  setOutput,
  setFailed,
  ActionFailedError,
  ensureClaudeAuth,
  logGroup,
  logGroupEnd,
  prepareRuntimeEnvironment,
  handleTriggerErrors,
  collectTriggerErrors,
  computeWorkflowOutputs,
  setWorkflowOutputs,
  getAuthenticatedBotLogin,
  writeFindingsOutput,
  writeMetadataOutput,
  writeMetadataOutputObject,
  writeFindingsOutputV2,
  writeFindingsOutputV2Object,
} from './base.js';
import { renderSkillReport } from '../../output/renderer.js';
import {
  FindingsOutputSchema,
  buildConfiguredSkillsList,
  type FindingsOutput,
  type ReplayTriggerResult,
} from '../reporting/output.js';
import {
  WardenMetadataSchema,
  WardenFindingsSchemaV2,
  patchFindingsOutputV2Observations,
  fromAuxiliaryUsageEntries,
  skillExecutionIdByNameFrom,
  type WardenMetadata,
  type WardenFindingsV2,
  type ExportedFindingV2,
} from '../reporting/output-v2.js';

// -----------------------------------------------------------------------------
// Phase Result Types
// -----------------------------------------------------------------------------

interface InitResult {
  context: EventContext;
  runnerConcurrency?: number;
  auxiliaryOptions: AuxiliaryWorkflowOptions;
  resolvedTriggers: ResolvedTrigger[];
  matchedTriggers: ResolvedTrigger[];
  skippedTriggers: ResolvedTrigger[];
  skipCoreCheck?: SkippedCoreCheck;
}

interface GitHubSetupResult {
  coreCheckId?: number;
  previousReviewInfo: BotReviewInfo | null;
}

interface ReviewPhaseResult {
  reports: SkillReport[];
  fetchedComments: ExistingComment[];
  existingComments: ExistingComment[];
  activeWardenCommentIds: Set<number>;
  findingObservations: FindingObservation[];
  shouldFailAction: boolean;
  failureReasons: string[];
}

interface FixEvaluationCommentGroups {
  groups: Map<string, ExistingComment[]>;
  currentHeadCount: number;
  missingOriginalCommitCount: number;
}

interface AuxiliaryWorkflowOptions {
  runtime?: RuntimeName;
  model?: string;
  maxRetries?: number;
}

interface SkippedCoreCheck {
  title: string;
  message: string;
}

class ReportWriteError extends Error {
  constructor(operation: string, error: unknown) {
    super(`${operation}: ${error instanceof Error ? error.message : String(error)}`);
    this.name = 'ReportWriteError';
  }
}

function existingCommentToFinding(comment: ExistingComment): Finding {
  const location = comment.path && comment.line > 0
    ? {
        path: comment.path,
        startLine: comment.line,
        endLine: comment.line,
      }
    : undefined;

  return {
    id: comment.findingId ?? `comment-${comment.id}`,
    severity: comment.severity ?? 'low',
    title: comment.title,
    description: comment.description,
    ...(comment.confidence ? { confidence: comment.confidence } : {}),
    ...(location ? { location } : {}),
  };
}

function reportsPullRequestCheck(trigger: ResolvedTrigger, context: EventContext): boolean {
  return (
    Boolean(context.pullRequest) &&
    (trigger.type === 'pull_request' || trigger.type === '*')
  );
}

function checkOptionsForPullRequest(context: EventContext): CheckOptions | undefined {
  if (!context.pullRequest) {
    return undefined;
  }

  return {
    owner: context.repository.owner,
    repo: context.repository.name,
    headSha: context.pullRequest.headSha,
  };
}

function resolveWorkflowAuxiliaryOptions(layered: LoadedLayeredConfig): AuxiliaryWorkflowOptions {
  const baseDefaults = layered.baseConfig?.defaults;
  const repoDefaults = layered.repoConfig?.defaults ?? layered.config.defaults;

  return {
    // These workflow-scoped auxiliary calls are not tied to an individual
    // trigger, so the org base config remains the enforced baseline and the
    // repo layer only fills fields the base omits.
    runtime: baseDefaults?.runtime ?? repoDefaults?.runtime ?? 'pi',
    model:
      emptyToUndefined(baseDefaults?.auxiliary?.model) ??
      emptyToUndefined(repoDefaults?.auxiliary?.model),
    maxRetries:
      baseDefaults?.auxiliary?.maxRetries ??
      baseDefaults?.auxiliaryMaxRetries ??
      repoDefaults?.auxiliary?.maxRetries ??
      repoDefaults?.auxiliaryMaxRetries,
  };
}

// -----------------------------------------------------------------------------
// Fix Evaluation Logging
// -----------------------------------------------------------------------------

function logFixEvaluation(ev: FixEvaluation, index: number, total: number): void {
  const totalTokens = ev.usage.inputTokens + ev.usage.outputTokens;
  const costStr = ev.usage.costUSD > 0 ? `, ${formatCost(ev.usage.costUSD)}` : '';
  const idPrefix = ev.findingId ? `${ev.findingId} ` : '';
  const verdict = ev.verdict;

  const line = `  [${index + 1}/${total}] ${idPrefix}${ev.path}:${ev.line} → ${verdict} (${formatDuration(ev.durationMs)}, ${formatTokens(totalTokens)} tok${costStr})`;

  if (ev.usedFallback) {
    warnAction(line);
  } else {
    logAction(line);
  }

  if (ev.verdict === 'attempted_failed' && ev.reasoning) {
    logAction(`        reason: "${ev.reasoning}"`);
  }
}

function groupCommentsForFixEvaluation(
  comments: ExistingComment[],
  headSha: string
): FixEvaluationCommentGroups {
  const groups = new Map<string, ExistingComment[]>();
  let currentHeadCount = 0;
  let missingOriginalCommitCount = 0;

  for (const comment of comments) {
    const originalCommitSha = comment.originalCommitSha;
    if (!originalCommitSha) {
      missingOriginalCommitCount++;
      continue;
    }
    if (originalCommitSha === headSha) {
      currentHeadCount++;
      continue;
    }

    const group = groups.get(originalCommitSha);
    if (group) {
      group.push(comment);
    } else {
      groups.set(originalCommitSha, [comment]);
    }
  }

  return { groups, currentHeadCount, missingOriginalCommitCount };
}

function mergeFixEvaluationResults(
  results: EvaluateFixAttemptsResult[]
): EvaluateFixAttemptsResult {
  return {
    toResolve: results.flatMap((result) => result.toResolve),
    toReply: results.flatMap((result) => result.toReply),
    skipped: results.reduce((total, result) => total + result.skipped, 0),
    evaluated: results.reduce((total, result) => total + result.evaluated, 0),
    failedEvaluations: results.reduce((total, result) => total + result.failedEvaluations, 0),
    uniqueFindingsEvaluated: results.reduce((total, result) => total + result.uniqueFindingsEvaluated, 0),
    uniqueFindingsCodeChanged: results.reduce((total, result) => total + result.uniqueFindingsCodeChanged, 0),
    uniqueFindingsResolved: results.reduce((total, result) => total + result.uniqueFindingsResolved, 0),
    usage: aggregateUsage(results.map((result) => result.usage)),
    evaluations: results.flatMap((result) => result.evaluations),
  };
}

// -----------------------------------------------------------------------------
// Phase Functions
// -----------------------------------------------------------------------------

/**
 * Parse event payload, build context, load config, match triggers.
 */
async function initializeWorkflow(
  octokit: Octokit,
  inputs: ActionInputs,
  eventName: string,
  eventPath: string,
  repoPath: string
): Promise<InitResult> {
  let eventPayload: unknown;
  try {
    eventPayload = JSON.parse(readFileSync(eventPath, 'utf-8'));
  } catch (error) {
    Sentry.captureException(error, { tags: { operation: 'read_event_payload' } });
    setFailed(`Failed to read event payload: ${error}`);
  }

  logGroup('Building event context');
  console.log(`Event: ${eventName}`);
  console.log(`Workspace: ${repoPath}`);
  logGroupEnd();

  let context: EventContext;
  try {
    context = await buildEventContext(eventName, eventPayload, repoPath, octokit);
  } catch (error) {
    Sentry.captureException(error, { tags: { operation: 'build_event_context' } });
    setFailed(`Failed to build event context: ${error}`);
  }
  setRepositoryScope(context.repository.fullName);

  logGroup('Loading configuration');
  if (inputs.baseConfigPath) {
    console.log(`Base config path: ${inputs.baseConfigPath}`);
  }
  if (inputs.baseSkillRoot) {
    console.log(`Base skill root: ${inputs.baseSkillRoot}`);
  }
  console.log(`Repo config path: ${inputs.configPath}`);
  logGroupEnd();

  let runnerConcurrency: number | undefined;
  let auxiliaryOptions: AuxiliaryWorkflowOptions = { runtime: 'pi' };
  let skillRootsByName: LayeredSkillRootsByName | undefined;
  try {
    const layered = loadLayeredWardenConfig(repoPath, {
      baseConfigPath: inputs.baseConfigPath,
      configPath: inputs.configPath,
      onWarning: (message) => console.log(`::warning::${message}`),
    });
    // The org base config is an enforced baseline. Repo config extends the run
    // with additional repo-local triggers, but does not override these
    // action-level settings for the global workflow.
    runnerConcurrency =
      layered.baseConfig?.runner?.concurrency ??
      layered.repoConfig?.runner?.concurrency ??
      layered.config.runner?.concurrency;
    auxiliaryOptions = resolveWorkflowAuxiliaryOptions(layered);
    skillRootsByName = buildSkillRootsByName(repoPath, layered, inputs.baseSkillRoot);
    const resolvedTriggers = resolveLayeredSkillConfigs(layered, undefined, skillRootsByName);
    const matchedTriggers = resolvedTriggers.filter((t) => matchTrigger(t, context, 'github'));
    const skippedTriggers = resolvedTriggers.filter(
      (t) => reportsPullRequestCheck(t, context) && !matchedTriggers.includes(t)
    );

    if (matchedTriggers.length > 0) {
      logGroup('Matched triggers');
      for (const trigger of matchedTriggers) {
        console.log(`- ${trigger.name}: ${trigger.skill}`);
      }
      logGroupEnd();
    } else {
      console.log('No triggers matched for this event');
    }

    return {
      context,
      runnerConcurrency,
      auxiliaryOptions,
      resolvedTriggers,
      matchedTriggers,
      skippedTriggers,
    };
  } catch (error) {
    if (
      error instanceof ConfigLoadError &&
      error.message.includes('not found') &&
      !inputs.baseConfigPath
    ) {
      const message = 'No warden.toml found. Skipping analysis.';
      console.log(`::warning::${message}`);
      return {
        context,
        runnerConcurrency,
        auxiliaryOptions,
        resolvedTriggers: [],
        matchedTriggers: [],
        skippedTriggers: [],
        skipCoreCheck: {
          title: 'No warden.toml found',
          message,
        },
      };
    }
    throw error;
  }
}

/**
 * Fetch the bot's previous review state on a PR.
 * Returns null if the bot has no actionable reviews or identity cannot be determined.
 */
async function fetchPreviousReviewInfo(
  octokit: Octokit,
  context: EventContext
): Promise<BotReviewInfo | null> {
  if (!context.pullRequest) {
    return null;
  }

  try {
    const botLogin = await getAuthenticatedBotLogin(octokit);

    if (!botLogin) {
      logAction(
        'Skipping dismiss flow: cannot identify bot (using PAT or GITHUB_TOKEN instead of GitHub App)'
      );
      return null;
    }

    // Note: No pagination. PRs with 100+ reviews are rare; if Warden's review
    // is beyond page 1, user can manually dismiss. Not worth the complexity.
    const { data: reviews } = await octokit.pulls.listReviews({
      owner: context.repository.owner,
      repo: context.repository.name,
      pull_number: context.pullRequest.number,
      per_page: 100,
    });

    return findBotReviewState(reviews, botLogin);
  } catch (error) {
    warnAction(`Failed to fetch previous review info: ${error}`);
    return null;
  }
}

/**
 * Create core check and fetch previous review info. PR-only.
 */
async function setupGitHubState(
  octokit: Octokit,
  context: EventContext
): Promise<GitHubSetupResult> {
  if (!context.pullRequest) {
    return { previousReviewInfo: null };
  }

  let coreCheckId: number | undefined;
  let previousReviewInfo: BotReviewInfo | null = null;

  // Create core warden check
  try {
    const coreCheck = await createCoreCheck(octokit, {
      owner: context.repository.owner,
      repo: context.repository.name,
      headSha: context.pullRequest.headSha,
    });
    coreCheckId = coreCheck.checkRunId;
    logAction(`Created core check: ${coreCheck.url}`);
  } catch (error) {
    Sentry.captureException(error, { tags: { operation: 'create_core_check' } });
    warnAction(`Failed to create core check: ${error}`);
  }

  previousReviewInfo = await fetchPreviousReviewInfo(octokit, context);

  if (previousReviewInfo) {
    logAction(`Previous Warden review state: ${previousReviewInfo.state}`);
  }

  return { coreCheckId, previousReviewInfo };
}

/**
 * Build the context-bound check lifecycle used by legacy run mode.
 * Analyze mode omits this capability so trigger execution cannot write checks.
 */
function createTriggerCheckReporter(
  octokit: Octokit,
  context: EventContext
): TriggerCheckReporter | undefined {
  const checkOptions = checkOptionsForPullRequest(context);
  if (!checkOptions) {
    return undefined;
  }

  return {
    async start(skillName) {
      const check = await createSkillCheck(octokit, skillName, checkOptions);
      return {
        url: check.url,
        complete: (report, options) =>
          updateSkillCheck(octokit, check.checkRunId, report, {
            ...checkOptions,
            ...options,
          }),
        fail: (error) => failSkillCheck(octokit, check.checkRunId, error, checkOptions),
      };
    },
  };
}

async function executeAllTriggers(
  matchedTriggers: ResolvedTrigger[],
  context: EventContext,
  runnerConcurrency: number | undefined,
  inputs: ActionInputs,
  options: { checks?: TriggerCheckReporter } = {}
): Promise<TriggerResult[]> {
  const concurrency = runnerConcurrency ?? inputs.parallel;
  const runtimeEnv = await prepareRuntimeEnvironment(matchedTriggers, inputs);

  const semaphore = new Semaphore(concurrency);
  const abortController = new AbortController();
  const circuitBreaker = new ProviderFailureCircuitBreaker({ abortController });

  // Limit trigger dispatch too; the semaphore only gates work after a trigger starts.
  return runPool(
    matchedTriggers,
    concurrency,
    (trigger) =>
      executeTrigger(trigger, {
        context,
        anthropicApiKey: inputs.anthropicApiKey,
        claudePath: runtimeEnv.pathToClaudeCodeExecutable,
        globalFailOn: inputs.failOn,
        globalReportOn: inputs.reportOn,
        globalMaxFindings: inputs.maxFindings,
        globalRequestChanges: inputs.requestChanges,
        globalFailCheck: inputs.failCheck,
        semaphore,
        abortController,
        circuitBreaker,
        checks: options.checks,
      }),
    { shouldAbort: () => abortController.signal.aborted },
  );
}

/**
 * Fetch existing comments, post reviews with cross-trigger dedup, accumulate failure state.
 */
async function postReviewsAndTrackFailures(
  octokit: Octokit,
  context: EventContext,
  results: TriggerResult[],
  inputs: ActionInputs,
  auxiliaryOptions: AuxiliaryWorkflowOptions,
  gate: ReviewFeedbackGate,
  options: { failOnPostError?: boolean } = {}
): Promise<ReviewPhaseResult> {
  // Skip the comment fetch only when the head has definitively advanced; on an
  // unverifiable head the fetch is a harmless read and keeps later phases able
  // to resolve comments once the API recovers.
  // Keep original list separate for stale detection (modified list includes newly posted comments)
  let fetchedComments: ExistingComment[] = [];
  let existingComments: ExistingComment[] = [];
  let writability = await gate.check();
  if (writability !== 'blocked' && context.pullRequest) {
    try {
      fetchedComments = await fetchExistingComments(
        octokit,
        context.repository.owner,
        context.repository.name,
        context.pullRequest.number
      );
      existingComments = [...fetchedComments];
      if (fetchedComments.length > 0) {
        const wardenCount = fetchedComments.filter((c) => c.isWarden).length;
        const externalCount = fetchedComments.length - wardenCount;
        logAction(
          `Found ${fetchedComments.length} existing comments for deduplication (${wardenCount} Warden, ${externalCount} external)`
        );
      }
    } catch (error) {
      Sentry.captureException(error, { tags: { operation: 'fetch_existing_comments' } });
      warnAction(`Failed to fetch existing comments for deduplication: ${error}`);
    }
  }

  // Post reviews to GitHub (sequentially to avoid rate limits)
  const reports: SkillReport[] = [];
  const activeWardenCommentIds = new Set<number>();
  const findingObservations: FindingObservation[] = [];
  let shouldFailAction = false;
  const failureReasons: string[] = [];

  for (const result of results) {
    if (result.report) {
      reports.push(result.report);

      // Post review. The gate memoizes briefly, so this stays cheap between
      // writes but re-verifies after slow phases (LLM dedup, consolidation).
      if (writability !== 'blocked') {
        writability = await gate.check();
      }
      let reviewPosted = false;
      if (writability === 'writable') {
        const postResult = await postTriggerReview(
          {
            result,
            existingComments,
            apiKey: inputs.anthropicApiKey,
            runtime: auxiliaryOptions.runtime,
            model: auxiliaryOptions.model,
            maxRetries: auxiliaryOptions.maxRetries,
            failOnPostError: options.failOnPostError,
          },
          { octokit, context, feedbackGate: gate }
        );

        // Add newly posted comments to existing comments for cross-trigger deduplication
        existingComments.push(...postResult.newComments);
        postResult.activeWardenCommentIds.forEach((id) => activeWardenCommentIds.add(id));
        findingObservations.push(...postResult.findingObservations);
        reviewPosted = postResult.posted;
      }
      // A stale head skips silently (the newer run owns feedback), but an
      // unverifiable head must not silently swallow a blocking review.
      // Evaluated after the post attempt so a head that becomes unverifiable
      // during the poster's own LLM phases is escalated too.
      if (!reviewPosted && wouldPostBlockingReview(result) && (await gate.check()) === 'unknown') {
        shouldFailAction = true;
        failureReasons.push(
          `${result.triggerName}: Could not verify the PR head; blocking review was not posted`
        );
      }

      // Check if we should fail based on this trigger's config
      // Filter by confidence first so low-confidence findings don't cause failure
      const failCheck = result.failCheck ?? false;
      const reportForFail = { ...result.report, findings: filterFindings(result.report.findings, undefined, result.minConfidence) };
      if (failCheck && result.failOn && shouldFail(reportForFail, result.failOn)) {
        shouldFailAction = true;
        const count = countFindingsAtOrAbove(reportForFail, result.failOn);
        failureReasons.push(`${result.triggerName}: Found ${count} ${result.failOn}+ severity issues`);
      }
    }
  }

  return {
    reports,
    fetchedComments,
    existingComments,
    activeWardenCommentIds,
    findingObservations,
    shouldFailAction,
    failureReasons,
  };
}

/**
 * Whether posting this trigger's review would produce a blocking
 * REQUEST_CHANGES review. Mirrors the poster's posting predicate: the
 * renderer can emit a REQUEST_CHANGES render result with zero reportable
 * findings (reportOn stricter than failOn), which the poster never posts —
 * its reportOn early return runs before the needsRequestChanges branch, so
 * that branch is only reachable when this predicate is already true (the
 * pre-dedup filtered set was non-empty or reportOnSuccess is set).
 */
function wouldPostBlockingReview(result: TriggerResult): boolean {
  if (!result.report || result.renderResult?.review?.event !== 'REQUEST_CHANGES') {
    return false;
  }
  const filteredFindings = filterFindings(result.report.findings, result.reportOn, result.minConfidence);
  return filteredFindings.length > 0 || (result.reportOnSuccess ?? false);
}

/**
 * Evaluate fix attempts on unresolved comments and resolve stale comments.
 *
 * Returns whether all Warden comments are resolved after evaluation.
 * Report mode passes failOnWriteError so GitHub write failures abort delivery.
 */
async function evaluateFixesAndResolveStale(
  octokit: Octokit,
  context: EventContext,
  fetchedComments: ExistingComment[],
  allFindings: Finding[],
  activeWardenCommentIds: ReadonlySet<number>,
  canResolveStale: boolean,
  anthropicApiKey: string,
  auxiliaryOptions: AuxiliaryWorkflowOptions,
  gate: ReviewFeedbackGate,
  matchedTriggers: ResolvedTrigger[],
  options: { failOnWriteError?: boolean } = {}
): Promise<{
  allResolved: boolean;
  autoResolvedByFixEvaluation: number;
  autoResolvedByStaleCheck: number;
  findingObservations: FindingObservation[];
}> {
  const skillExecutionIdByName = skillExecutionIdByNameFrom(matchedTriggers);
  const wardenComments = fetchedComments.filter((c) => c.isWarden);
  const commentsResolvedByFixEval = new Set<number>();
  const commentsEvaluatedByFixEval = new Set<number>();
  const commentsResolvedByStale = new Set<number>();
  const findingObservations: FindingObservation[] = [];
  const blockedReviewFeedbackWriteResult = () => ({
    allResolved: false,
    autoResolvedByFixEvaluation: commentsResolvedByFixEval.size,
    autoResolvedByStaleCheck: commentsResolvedByStale.size,
    findingObservations,
  });
  const commentsForFixEvaluation = wardenComments.filter(
    (c) => !activeWardenCommentIds.has(c.id)
  );
  const fixEvaluationRuntime = auxiliaryOptions.runtime ?? 'pi';
  const canUseFixEvaluationRuntime = canUseRuntimeAuth({
    apiKey: anthropicApiKey,
    runtime: fixEvaluationRuntime,
  });

  // Check head freshness up front so a stale or unverifiable run skips the
  // LLM fix evaluation entirely, not just the writes it would produce.
  let writability: ReviewFeedbackWritability = 'blocked';
  if (wardenComments.length > 0) {
    if (!canResolveStale) {
      logAction('Skipping stale comment resolution due to trigger failures');
    } else if (context.pullRequest) {
      writability = await gate.check();
      if (writability === 'blocked') {
        logAction('Skipping stale comment resolution because this run is no longer analyzing the current PR head');
      } else if (writability === 'unknown') {
        logAction('Skipping stale comment resolution because the current PR head could not be verified');
      }
    }
  }
  const canMutateFeedback = writability === 'writable';

  // Evaluate follow-up commit fix attempts
  if (
    context.pullRequest &&
    commentsForFixEvaluation.length > 0 &&
    canMutateFeedback &&
    canUseFixEvaluationRuntime
  ) {
    try {
      logGroup('Fix evaluation');

      // Only evaluate comments that were posted on an earlier commit. If a comment was
      // posted on the current headSha there are no follow-up changes to evaluate yet, and
      // running fix evaluation would compare the entire PR diff (PR base to head) against a
      // finding from this same run, producing spurious "Fix attempt detected" replies.
      const headSha = context.pullRequest.headSha;
      const {
        groups: commentsByOriginalCommit,
        currentHeadCount,
        missingOriginalCommitCount,
      } = groupCommentsForFixEvaluation(commentsForFixEvaluation, headSha);

      const unresolvedCount = [...commentsByOriginalCommit.values()]
        .flat()
        .filter((c) => !c.isResolved && c.threadId).length;
      if (unresolvedCount > 0) {
        logAction(`Fix evaluation: evaluating ${unresolvedCount} unresolved comments`);
      } else {
        logAction(
          `Fix evaluation: no eligible comments (${currentHeadCount} current head, ` +
            `${missingOriginalCommitCount} missing original commit)`
        );
      }

      const groupResults: EvaluateFixAttemptsResult[] = [];
      for (const [commentBaseSha, groupComments] of commentsByOriginalCommit) {
        groupResults.push(
          await evaluateFixAttempts(
            octokit,
            groupComments,
            {
              owner: context.repository.owner,
              repo: context.repository.name,
              baseSha: commentBaseSha,
              headSha,
            },
            allFindings,
            anthropicApiKey,
            { ...auxiliaryOptions, runtime: fixEvaluationRuntime }
          )
        );
      }
      const fixEvaluation = mergeFixEvaluationResults(groupResults);

      // Log per-evaluation details
      fixEvaluation.evaluations.forEach((ev, i) =>
        logFixEvaluation(ev, i, fixEvaluation.evaluations.length)
      );

      // Resolve successful fixes
      if (fixEvaluation.toResolve.length > 0) {
        if (!await gate.canWrite()) {
          logGroupEnd();
          return blockedReviewFeedbackWriteResult();
        }

        const { resolvedCount, resolvedIds } = await resolveStaleComments(
          octokit,
          fixEvaluation.toResolve,
          { failOnError: options.failOnWriteError }
        ).catch((error: unknown) => {
          if (options.failOnWriteError) {
            throw new ReportWriteError('Failed to resolve comments via fix evaluation', error);
          }
          throw error;
        });
        if (resolvedCount > 0) {
          logAction(`Resolved ${resolvedCount} comments via fix evaluation`);
        }
        // Track only actually resolved comments for allResolved check
        resolvedIds.forEach((id) => commentsResolvedByFixEval.add(id));
        for (const comment of fixEvaluation.toResolve) {
          if (!resolvedIds.has(comment.id)) continue;
          findingObservations.push({
            outcome: 'resolved',
            finding: existingCommentToFinding(comment),
            skill: comment.skills?.[0],
            skillExecutionId: skillExecutionIdByName.get(comment.skills?.[0] ?? ''),
            resolvedReason: 'fix_evaluation',
          });
        }
      }

      // Post replies for failed fixes and track them so stale pass doesn't override
      if (fixEvaluation.toReply.length > 0 && !await gate.canWrite()) {
        logGroupEnd();
        return blockedReviewFeedbackWriteResult();
      }
      for (const reply of fixEvaluation.toReply) {
        commentsEvaluatedByFixEval.add(reply.comment.id);
        if (reply.comment.threadId) {
          try {
            await postThreadReply(octokit, reply.comment.threadId, reply.replyBody);
          } catch (error) {
            Sentry.captureException(error, { tags: { operation: 'post_thread_reply' } });
            if (options.failOnWriteError) {
              throw new ReportWriteError('Failed to post fix evaluation reply', error);
            }
          }
        }
      }

      if (fixEvaluation.evaluated > 0) {
        const totalTokens = fixEvaluation.usage.inputTokens + fixEvaluation.usage.outputTokens;
        let usageStr = '';
        if (totalTokens > 0) {
          usageStr = `, ${formatTokens(totalTokens)} tok, ${formatCost(fixEvaluation.usage.costUSD)}`;
        }
        logAction(
          `Fix evaluation: ${fixEvaluation.toResolve.length} resolved, ` +
            `${fixEvaluation.toReply.length} need attention, ` +
            `${fixEvaluation.skipped} skipped` +
            usageStr
        );
      }
      logGroupEnd();
    } catch (error) {
      Sentry.captureException(error, { tags: { operation: 'evaluate_fix_attempts' } });
      if (error instanceof ReportWriteError) {
        logGroupEnd();
        throw error;
      }
      warnAction(`Failed to evaluate fix attempts: ${error}`);
      logGroupEnd();
    }
  }

  // Resolve stale Warden comments (comments that no longer have matching findings)
  // Exclude comments already handled by fix evaluation (resolved or flagged as needing attention)
  if (context.pullRequest && wardenComments.length > 0 && canMutateFeedback) {
    try {
      const scope = buildAnalyzedScope(context.pullRequest.files);
      const commentsForStaleCheck = wardenComments.filter(
        (c) =>
          !activeWardenCommentIds.has(c.id) &&
          !commentsResolvedByFixEval.has(c.id) &&
          !commentsEvaluatedByFixEval.has(c.id)
      );
      const staleComments = findStaleComments(commentsForStaleCheck, allFindings, scope);

      if (staleComments.length > 0) {
        if (!await gate.canWrite()) {
          return blockedReviewFeedbackWriteResult();
        }

        const { resolvedCount, resolvedIds } = await resolveStaleComments(
          octokit,
          staleComments,
          { failOnError: options.failOnWriteError }
        ).catch((error: unknown) => {
          if (options.failOnWriteError) {
            throw new ReportWriteError('Failed to resolve stale comments', error);
          }
          throw error;
        });
        if (resolvedCount > 0) {
          logAction(`Resolved ${resolvedCount} stale Warden comments`);
          emitStaleResolutionMetric(resolvedCount);
          // Emit per-skill breakdown (only count actually resolved comments)
          const bySkill = new Map<string, number>();
          for (const c of staleComments) {
            if (!resolvedIds.has(c.id)) continue;
            const skill = c.skills?.[0];
            if (skill) {
              bySkill.set(skill, (bySkill.get(skill) ?? 0) + 1);
            }
          }
          for (const [skill, count] of bySkill) {
            emitStaleResolutionMetric(count, skill);
          }
        }
        resolvedIds.forEach((id) => commentsResolvedByStale.add(id));
        for (const comment of staleComments) {
          if (!resolvedIds.has(comment.id)) continue;
          findingObservations.push({
            outcome: 'resolved',
            finding: existingCommentToFinding(comment),
            skill: comment.skills?.[0],
            skillExecutionId: skillExecutionIdByName.get(comment.skills?.[0] ?? ''),
            resolvedReason: 'stale_check',
          });
        }
      }
    } catch (error) {
      Sentry.captureException(error, { tags: { operation: 'resolve_stale_comments' } });
      if (error instanceof ReportWriteError) {
        throw error;
      }
      warnAction(`Failed to resolve stale comments: ${error}`);
    }
  }

  // Determine if all unresolved Warden comments were resolved during this run
  const unresolvedBefore = wardenComments.filter((c) => !c.isResolved);
  const allResolved = unresolvedBefore.every(
    (c) => commentsResolvedByFixEval.has(c.id) || commentsResolvedByStale.has(c.id)
  );

  return {
    allResolved,
    autoResolvedByFixEvaluation: commentsResolvedByFixEval.size,
    autoResolvedByStaleCheck: commentsResolvedByStale.size,
    findingObservations,
  };
}

/**
 * Dismiss a prior blocking Warden review only when current results prove it is clear.
 * Report mode sets failOnWriteError so dismissal write failures fail delivery.
 */
async function dismissPreviousReviewIfResolved(
  octokit: Octokit,
  context: EventContext,
  previousReviewInfo: BotReviewInfo | null,
  results: TriggerResult[],
  canResolveStale: boolean,
  gate: ReviewFeedbackGate,
  options: { failOnWriteError?: boolean } = {}
): Promise<void> {
  // Dismiss previous CHANGES_REQUESTED if all blocking issues are resolved.
  // Requires: all triggers succeeded, current run would not request changes,
  // and at least one trigger has an active failOn (prevents accidental dismiss when config changes).
  const wouldRequestChanges = results.some((r) => {
    if (!r.failOn || r.failOn === 'off' || !(r.requestChanges ?? false) || !r.report) return false;
    const filtered = { ...r.report, findings: filterFindings(r.report.findings, undefined, r.minConfidence) };
    return shouldFail(filtered, r.failOn);
  });
  const hasActiveFailOn = results.some((r) => r.failOn && r.failOn !== 'off');
  if (
    context.pullRequest &&
    previousReviewInfo?.state === 'CHANGES_REQUESTED' &&
    canResolveStale &&
    !wouldRequestChanges &&
    hasActiveFailOn
  ) {
    if (!await gate.canWrite()) {
      return;
    }

    try {
      await octokit.pulls.dismissReview({
        owner: context.repository.owner,
        repo: context.repository.name,
        pull_number: context.pullRequest.number,
        review_id: previousReviewInfo.reviewId,
        message: 'All previously reported issues have been resolved.',
      });
      logAction('Dismissed previous CHANGES_REQUESTED review');
    } catch (error) {
      Sentry.captureException(error, { tags: { operation: 'dismiss_review' } });
      if (options.failOnWriteError) {
        throw new ReportWriteError('Failed to dismiss previous review', error);
      }
      warnAction(`Failed to dismiss previous review: ${error}`);
    }
  }
}

/**
 * Write the schema-v2 metadata/findings pair when opted in. Called from every
 * v1 findings-file write site, including early-return "no triggers matched"
 * paths, so v2 consumers never see a missing pair when v1 output exists.
 */
function writeSchemaV2Outputs(
  inputs: ActionInputs,
  context: EventContext,
  resolvedTriggers: ResolvedTrigger[],
  matchedTriggers: ResolvedTrigger[],
  results: TriggerResult[],
  findingObservations: FindingObservation[],
  onError: (message: string) => void
): void {
  if (inputs.outputSchemaVersion !== '2') return;

  const runId = process.env['GITHUB_RUN_ID'] ?? '';
  const runAttempt = process.env['GITHUB_RUN_ATTEMPT'];
  try {
    const metadataPath = writeMetadataOutput(context, resolvedTriggers, matchedTriggers, results, {
      runId,
      runAttempt,
      actionRef: inputs.actionRef,
      failOn: inputs.failOn,
      reportOn: inputs.reportOn,
    });
    logAction(`Metadata written to ${metadataPath}`);
    const findingsV2Path = writeFindingsOutputV2(results, matchedTriggers, findingObservations, context, { runId });
    logAction(`Findings (v2) written to ${findingsV2Path}`);
  } catch (error) {
    onError(`Failed to write schema-v2 output: ${error}`);
  }
}

/**
 * Report mode's v2 write: unlike analyze mode or single-run mode, report mode
 * only has TriggerResults replayed from ExportedFindingV2 (no
 * findingProcessingEvents), so a full rebuild here would silently wipe the
 * analyze-phase `provenance`/`discardedFindings`. Instead, write the
 * unmodified analyze-phase metadata and patch only `findingObservations` /
 * `summary.byOutcome` onto the analyze-phase findings payload.
 */
function writeSchemaV2ReportOutputs(
  metadataOutputV2: WardenMetadata | undefined,
  findingsOutputV2: WardenFindingsV2 | undefined,
  context: EventContext,
  matchedTriggers: ResolvedTrigger[],
  findingObservations: FindingObservation[],
  onError: (message: string) => void
): void {
  if (!metadataOutputV2 || !findingsOutputV2) return;

  try {
    const metadataPath = writeMetadataOutputObject(metadataOutputV2, context);
    logAction(`Metadata written to ${metadataPath}`);
    const patched = patchFindingsOutputV2Observations(findingsOutputV2, matchedTriggers, findingObservations);
    const findingsV2Path = writeFindingsOutputV2Object(patched, context);
    logAction(`Findings (v2) written to ${findingsV2Path}`);
  } catch (error) {
    onError(`Failed to write schema-v2 output: ${error}`);
  }
}

/**
 * Dismiss review, set outputs, update core check, fail action.
 */
async function finalizeWorkflow(
  octokit: Octokit,
  context: EventContext,
  previousReviewInfo: BotReviewInfo | null,
  coreCheckId: number | undefined,
  results: TriggerResult[],
  reports: SkillReport[],
  findingObservations: FindingObservation[],
  shouldFailAction: boolean,
  failureReasons: string[],
  canResolveStale: boolean,
  gate: ReviewFeedbackGate,
  triggerErrors: string[],
  matchedTriggers: ResolvedTrigger[],
  resolvedTriggers: ResolvedTrigger[],
  inputs: ActionInputs
): Promise<void> {
  await dismissPreviousReviewIfResolved(
    octokit,
    context,
    previousReviewInfo,
    results,
    canResolveStale,
    gate
  );

  // Set outputs
  const outputs = computeWorkflowOutputs(reports);
  setWorkflowOutputs(outputs);

  // Write structured findings to file for external export (GCS, S3, etc.)
  try {
    const findingsPath = writeFindingsOutput(reports, context, findingObservations, {
      triggerResults: toReplayTriggerResults(results),
      configuredSkills: buildConfiguredSkillsList({ allTriggers: resolvedTriggers, matchedTriggers }),
    });
    logAction(`Findings written to ${findingsPath}`);
  } catch (error) {
    warnAction(`Failed to write findings output: ${error}`);
  }

  writeSchemaV2Outputs(inputs, context, resolvedTriggers, matchedTriggers, results, findingObservations, warnAction);

  // Update core check with overall summary
  if (coreCheckId && context.pullRequest) {
    try {
      const summaryData = buildCoreSummaryData(results, reports);
      const coreConclusion = determineCoreConclusion(
        shouldFailAction || triggerErrors.length > 0,
        outputs.findingsCount
      );

      await updateCoreCheck(octokit, coreCheckId, summaryData, coreConclusion, {
        owner: context.repository.owner,
        repo: context.repository.name,
      });
    } catch (error) {
      Sentry.captureException(error, { tags: { operation: 'update_core_check' } });
      warnAction(`Failed to update core check: ${error}`);
    }
  }

  if (shouldFailAction) {
    setFailed(failureReasons.join('; '));
  }

  logAction(`Analysis complete: ${outputs.findingsCount} total findings`);
}

/** Complete the core check for a PR run that intentionally skipped analysis. */
async function completeSkippedCoreCheck(
  octokit: Octokit,
  context: EventContext,
  coreCheckId: number | undefined,
  skipped: SkippedCoreCheck
): Promise<void> {
  const options = checkOptionsForPullRequest(context);
  if (!coreCheckId || !options) {
    return;
  }

  try {
    await updateCoreCheck(
      octokit,
      coreCheckId,
      {
        ...buildCoreSummaryData([], []),
        title: skipped.title,
        message: skipped.message,
      },
      'neutral',
      options
    );
  } catch (error) {
    Sentry.captureException(error, { tags: { operation: 'update_core_check_skipped' } });
    warnAction(`Failed to update core check: ${error}`);
  }
}

/** Complete per-skill checks for configured PR triggers that did not run. */
async function completeSkippedSkillChecks(
  octokit: Octokit,
  context: EventContext,
  skippedTriggers: ResolvedTrigger[]
): Promise<void> {
  const options = checkOptionsForPullRequest(context);
  if (!options || skippedTriggers.length === 0) {
    return;
  }

  for (const trigger of skippedTriggers) {
    try {
      const skillCheck = await createSkillCheck(octokit, trigger.skill, options);

      await updateSkillCheck(
        octokit,
        skillCheck.checkRunId,
        {
          skill: trigger.skill,
          summary: 'Trigger did not run for this event.',
          findings: [],
        },
        {
          ...options,
          failOn: trigger.failOn,
          reportOn: trigger.reportOn,
          minConfidence: trigger.minConfidence ?? 'medium',
          failCheck: trigger.failCheck,
          conclusion: 'neutral',
          title: 'Skipped',
        }
      );
    } catch (error) {
      Sentry.captureException(error, {
        tags: {
          operation: 'update_skipped_skill_check',
          trigger_name: trigger.name,
          skill_name: trigger.skill,
        },
      });
      warnAction(`Failed to update skipped skill check for ${trigger.skill}: ${error}`);
    }
  }
}

/**
 * Fail per-skill checks when workflow setup fails before triggers are dispatched.
 */
async function failUndispatchedSkillChecks(
  octokit: Octokit,
  context: EventContext,
  triggers: ResolvedTrigger[],
  error: unknown
): Promise<void> {
  const options = checkOptionsForPullRequest(context);
  if (!options || triggers.length === 0) {
    return;
  }

  for (const trigger of triggers) {
    try {
      const skillCheck = await createSkillCheck(octokit, trigger.skill, options);

      await failSkillCheck(octokit, skillCheck.checkRunId, error, options);
    } catch (checkError) {
      Sentry.captureException(checkError, {
        tags: {
          operation: 'fail_undispatched_skill_check',
          trigger_name: trigger.name,
          skill_name: trigger.skill,
        },
      });
      warnAction(`Failed to mark skill check as failed for ${trigger.skill}: ${checkError}`);
    }
  }
}

/**
 * Mark the core check failed when an early PR workflow phase fails after check creation.
 */
async function failCoreCheck(
  octokit: Octokit,
  context: EventContext,
  coreCheckId: number | undefined,
  error: unknown
): Promise<void> {
  const options = checkOptionsForPullRequest(context);
  if (!coreCheckId || !options) {
    return;
  }

  const errorMessage = error instanceof Error ? error.message : String(error);

  try {
    await updateCoreCheck(
      octokit,
      coreCheckId,
      {
        ...buildCoreSummaryData([], []),
        title: 'Warden failed',
        message: `Error: ${errorMessage}`,
      },
      'failure',
      options
    );
  } catch (checkError) {
    Sentry.captureException(checkError, { tags: { operation: 'fail_core_check' } });
    warnAction(`Failed to mark core check as failed: ${checkError}`);
  }
}

async function runOrFailCore<T>(
  octokit: Octokit,
  context: EventContext,
  coreCheckId: number | undefined,
  operation: () => Promise<T>
): Promise<T> {
  try {
    return await operation();
  } catch (error) {
    await failCoreCheck(octokit, context, coreCheckId, error);
    throw error;
  }
}

function resolveFindingsFilePath(
  inputPath: string | undefined,
  repoPath: string,
  missingMessage = 'findings-file is required when mode is report'
): string {
  if (!inputPath) {
    setFailed(missingMessage);
  }
  return isAbsolute(inputPath) ? inputPath : join(repoPath, inputPath);
}

/**
 * Reads the analyze-mode findings artifact that report mode replays.
 */
function readFindingsFile(inputPath: string | undefined, repoPath: string): FindingsOutput {
  const filePath = resolveFindingsFilePath(inputPath, repoPath);

  try {
    return FindingsOutputSchema.parse(JSON.parse(readFileSync(filePath, 'utf-8')));
  } catch (error) {
    setFailed(`Failed to read findings file ${filePath}: ${error}`);
  }
}

/**
 * Ensures a replay artifact was produced for the same repository, event, PR,
 * and head SHA before report mode performs GitHub writes.
 */
function validateFindingsMatchContext(output: FindingsOutput, context: EventContext): void {
  if (output.repository.fullName !== context.repository.fullName) {
    setFailed(
      `Findings file is for ${output.repository.fullName}, but this workflow is for ${context.repository.fullName}`
    );
  }

  if (output.event !== context.eventType) {
    setFailed(`Findings file event ${output.event} does not match ${context.eventType}`);
  }

  if (!context.pullRequest) {
    return;
  }

  if (!output.pullRequest) {
    setFailed('Findings file is missing pull request metadata');
  }

  if (output.pullRequest.number !== context.pullRequest.number) {
    setFailed(
      `Findings file is for PR #${output.pullRequest.number}, but this workflow is for PR #${context.pullRequest.number}`
    );
  }

  if (output.pullRequest.headSha !== context.pullRequest.headSha) {
    setFailed(
      `Findings file head SHA ${output.pullRequest.headSha} does not match current head SHA ${context.pullRequest.headSha}`
    );
  }
}

function deserializeTriggerError(
  error: NonNullable<FindingsOutput['triggerResults']>[number]['error'],
  fallback: string
): Error {
  const deserialized = new Error(error?.message ?? fallback);
  if (error?.name) {
    deserialized.name = error.name;
  }
  return deserialized;
}

function resultKey(triggerName: string, skillName: string): string {
  return `${triggerName}\0${skillName}`;
}

function replayKey(result: { triggerId?: string; triggerName: string; skillName: string }): string {
  return result.triggerId ?? resultKey(result.triggerName, result.skillName);
}

function triggerReplayKey(trigger: ResolvedTrigger): string {
  return trigger.id;
}

function describeResultKey(result: { triggerName: string; skillName: string }): string {
  return `${result.triggerName} (${result.skillName})`;
}

function toReplayTriggerResults(results: TriggerResult[]): ReplayTriggerResult[] {
  return results.map((result) => ({
    triggerId: result.triggerId,
    triggerName: result.triggerName,
    skillName: result.skillName,
    report: result.report,
    error: result.error,
  }));
}

/**
 * Rebuild report-mode trigger results by joining artifact rows to the current
 * configured trigger name and skill identity.
 */
function buildReportModeResults(
  output: FindingsOutput,
  matchedTriggers: ResolvedTrigger[],
  inputs: ActionInputs
): TriggerResult[] {
  if (!output.triggerResults) {
    setFailed('Findings file was not produced by mode: analyze; missing triggerResults');
  }

  const outputResults = new Map<string, typeof output.triggerResults>();
  for (const result of output.triggerResults) {
    const key = replayKey(result);
    const existing = outputResults.get(key);
    if (existing) {
      existing.push(result);
    } else {
      outputResults.set(key, [result]);
    }
  }

  const duplicateConfiguredResults = new Map<string, ResolvedTrigger[]>();
  for (const trigger of matchedTriggers) {
    const key = triggerReplayKey(trigger);
    const existing = duplicateConfiguredResults.get(key);
    if (existing) {
      existing.push(trigger);
    } else {
      duplicateConfiguredResults.set(key, [trigger]);
    }
  }

  const ambiguousKeys = [
    ...new Set([
      ...[...outputResults.entries()]
        .filter(([, results]) => results.length > 1)
        .map(([key]) => key),
      ...[...duplicateConfiguredResults.entries()]
        .filter(([, triggers]) => triggers.length > 1)
        .map(([key]) => key),
    ]),
  ];

  if (ambiguousKeys.length > 0) {
    const triggerList = ambiguousKeys
      .map((key) => {
        const result = outputResults.get(key)?.[0];
        const trigger = duplicateConfiguredResults.get(key)?.[0];
        return result
          ? describeResultKey(result)
          : `${trigger?.name ?? 'unknown'} (${trigger?.skill ?? 'unknown'})`;
      })
      .join(', ');

    throw new Error(
      `Findings file contains ambiguous duplicate trigger result(s): ${triggerList}`
    );
  }

  const results = matchedTriggers.map((trigger) => {
    const failOn = trigger.failOn ?? inputs.failOn;
    const reportOn = trigger.reportOn ?? inputs.reportOn;
    const minConfidence = trigger.minConfidence ?? 'medium';
    const requestChanges = trigger.requestChanges ?? inputs.requestChanges;
    const failCheck = trigger.failCheck ?? inputs.failCheck;
    const maxFindings = trigger.maxFindings ?? inputs.maxFindings;
    const baseResult = {
      triggerId: trigger.id,
      triggerName: trigger.name,
      skillName: trigger.skill,
      skillExecutionId: trigger.skillExecutionId,
      failOn,
      reportOn,
      minConfidence,
      reportOnSuccess: trigger.reportOnSuccess,
      requestChanges,
      failCheck,
      maxFindings,
    };
    const outputResult =
      outputResults.get(triggerReplayKey(trigger))?.shift() ??
      outputResults.get(resultKey(trigger.name, trigger.skill))?.shift();

    if (!outputResult) {
      return {
        ...baseResult,
        error: new Error(`Findings file has no result for trigger ${trigger.name} (${trigger.skill})`),
      };
    }

    if (outputResult.status === 'error' || !outputResult.report) {
      return {
        ...baseResult,
        error: deserializeTriggerError(
          outputResult.error,
          `Trigger ${trigger.name} (${trigger.skill}) failed during analysis`
        ),
      };
    }

    return {
      ...baseResult,
      report: outputResult.report,
    };
  });

  const unreportedResults = [...outputResults.values()].flat();
  if (unreportedResults.length > 0) {
    const triggerList = unreportedResults
      .map(describeResultKey)
      .join(', ');
    throw new Error(
      `Findings file contains ${unreportedResults.length} result(s) that do not match current config: ${triggerList}`
    );
  }

  return results;
}

function withRenderedReviewResult(result: TriggerResult): TriggerResult {
  if (!result.report) {
    return result;
  }

  return {
    ...result,
    renderResult:
      result.reportOn !== 'off'
        ? renderSkillReport(result.report, {
            maxFindings: result.maxFindings,
            reportOn: result.reportOn,
            minConfidence: result.minConfidence,
            failOn: result.failOn,
            requestChanges: result.requestChanges,
            checkRunUrl: result.checkRunUrl,
            totalFindings: result.report.findings.length,
          })
        : undefined,
  };
}

/**
 * Create report-mode skill checks directly as completed check runs.
 */
async function createCompletedSkillChecksForReport(
  octokit: Octokit,
  context: EventContext,
  results: TriggerResult[]
): Promise<TriggerResult[]> {
  const options = checkOptionsForPullRequest(context);
  if (!options) {
    return results.map(withRenderedReviewResult);
  }

  const updatedResults: TriggerResult[] = [];
  for (const result of results) {
    if (result.report) {
      const check = await createCompletedSkillCheck(octokit, result.report, {
        ...options,
        checkName: result.skillName,
        failOn: result.failOn,
        reportOn: result.reportOn,
        minConfidence: result.minConfidence,
        failCheck: result.failCheck,
      });
      updatedResults.push(withRenderedReviewResult({ ...result, checkRunUrl: check.url }));
      continue;
    }

    await createFailedSkillCheck(
      octokit,
      result.skillName,
      result.error ?? new Error('Trigger did not produce a report'),
      options
    );
    updatedResults.push(result);
  }

  return updatedResults;
}

/**
 * Create neutral completed checks for triggers report mode intentionally skipped.
 */
async function createCompletedSkippedSkillChecks(
  octokit: Octokit,
  context: EventContext,
  skippedTriggers: ResolvedTrigger[]
): Promise<void> {
  const options = checkOptionsForPullRequest(context);
  if (!options || skippedTriggers.length === 0) {
    return;
  }

  for (const trigger of skippedTriggers) {
    await createCompletedSkillCheck(
      octokit,
      {
        skill: trigger.skill,
        summary: 'Trigger did not run for this event.',
        findings: [],
      },
      {
        ...options,
        failOn: trigger.failOn,
        reportOn: trigger.reportOn,
        minConfidence: trigger.minConfidence ?? 'medium',
        failCheck: trigger.failCheck,
        conclusion: 'neutral',
        title: 'Skipped',
      }
    );
  }
}

/**
 * Create the report-mode core check directly as a completed check run.
 */
async function createCompletedCoreCheckForReport(
  octokit: Octokit,
  context: EventContext,
  results: TriggerResult[],
  reports: SkillReport[],
  shouldFailAction: boolean,
  outputs: { findingsCount: number },
  overrides: Partial<CoreCheckSummaryData> = {},
  conclusion?: 'success' | 'failure' | 'neutral'
): Promise<void> {
  const options = checkOptionsForPullRequest(context);
  if (!options) {
    return;
  }

  await createCompletedCoreCheck(
    octokit,
    {
      ...buildCoreSummaryData(results, reports),
      ...overrides,
    },
    conclusion ?? determineCoreConclusion(shouldFailAction, outputs.findingsCount),
    options
  );
}

/**
 * Create the report-mode core failure check directly as a completed check run.
 */
async function createFailedCoreCheckForReport(
  octokit: Octokit,
  context: EventContext,
  error: unknown
): Promise<void> {
  const errorMessage = error instanceof Error ? error.message : String(error);

  try {
    await createCompletedCoreCheckForReport(
      octokit,
      context,
      [],
      [],
      true,
      { findingsCount: 0 },
      {
        title: 'Warden failed',
        message: `Error: ${errorMessage}`,
      },
      'failure'
    );
  } catch (checkError) {
    Sentry.captureException(checkError, { tags: { operation: 'create_failed_core_check_report' } });
    warnAction(`Failed to create failed core check: ${checkError}`);
  }
}

/**
 * Finalize report mode after replay: write outputs, handle review dismissal,
 * create direct completed checks, and fail the action when policy requires it.
 */
async function finalizeReportWorkflow(
  octokit: Octokit,
  context: EventContext,
  previousReviewInfo: BotReviewInfo | null,
  results: TriggerResult[],
  reports: SkillReport[],
  findingObservations: FindingObservation[],
  shouldFailAction: boolean,
  failureReasons: string[],
  canResolveStale: boolean,
  gate: ReviewFeedbackGate,
  triggerErrors: string[],
  options: {
    failOnWriteError?: boolean;
    matchedTriggers: ResolvedTrigger[];
    resolvedTriggers: ResolvedTrigger[];
    inputs: ActionInputs;
    metadataOutputV2?: WardenMetadata;
    findingsOutputV2?: WardenFindingsV2;
  }
): Promise<void> {
  await dismissPreviousReviewIfResolved(
    octokit,
    context,
    previousReviewInfo,
    results,
    canResolveStale,
    gate,
    { failOnWriteError: options.failOnWriteError }
  );

  const outputs = computeWorkflowOutputs(reports);
  setWorkflowOutputs(outputs);

  try {
    const findingsPath = writeFindingsOutput(reports, context, findingObservations, {
      triggerResults: toReplayTriggerResults(results),
      configuredSkills: buildConfiguredSkillsList({
        allTriggers: options.resolvedTriggers ?? [],
        matchedTriggers: options.matchedTriggers ?? [],
      }),
    });
    logAction(`Findings written to ${findingsPath}`);
  } catch (error) {
    warnAction(`Failed to write findings output: ${error}`);
  }

  writeSchemaV2ReportOutputs(
    options.metadataOutputV2, options.findingsOutputV2, context,
    options.matchedTriggers, findingObservations, warnAction
  );

  await createCompletedCoreCheckForReport(
    octokit,
    context,
    results,
    reports,
    shouldFailAction || triggerErrors.length > 0,
    outputs
  );

  if (shouldFailAction) {
    setFailed(failureReasons.join('; '));
  }

  logAction(`Analysis complete: ${outputs.findingsCount} total findings`);
}

/**
 * Clean up orphaned Warden comments when no triggers matched.
 *
 * Runs fix evaluation and stale resolution on existing comments so that
 * comments from earlier pushes get resolved even when the current push
 * only touches files outside all skills' paths filters.
 * Skips cleanup when this run is no longer analyzing the current PR head.
 */
async function cleanupOrphanedComments(
  octokit: Octokit,
  context: EventContext,
  inputs: ActionInputs,
  auxiliaryOptions: AuxiliaryWorkflowOptions,
  options: { failOnWriteError?: boolean } = {}
): Promise<FindingObservation[]> {
  if (!context.pullRequest) {
    return [];
  }

  const gate = new ReviewFeedbackGate(octokit, context);

  if (!await gate.canWrite()) {
    return [];
  }

  let existingComments: ExistingComment[];
  try {
    existingComments = await fetchExistingComments(
      octokit,
      context.repository.owner,
      context.repository.name,
      context.pullRequest.number
    );
  } catch (error) {
    warnAction(`Failed to fetch existing comments for cleanup: ${error}`);
    return [];
  }

  const wardenComments = existingComments.filter((c) => c.isWarden);
  if (wardenComments.length === 0) {
    return [];
  }

  if ((auxiliaryOptions.runtime ?? 'pi') === 'claude') {
    ensureClaudeAuth(inputs);
  }

  logAction(`No triggers matched, but found ${wardenComments.length} existing Warden comments. Running cleanup.`);

  const { allResolved, autoResolvedByFixEvaluation, autoResolvedByStaleCheck, findingObservations } =
    await evaluateFixesAndResolveStale(
      octokit, context, existingComments, [], new Set(), true, inputs.anthropicApiKey, auxiliaryOptions, gate, [], {
        failOnWriteError: options.failOnWriteError,
      }
    );
  const activeSpan = Sentry.getActiveSpan();
  activeSpan?.setAttribute('warden.feedback.auto_resolve.fix_eval_count', autoResolvedByFixEvaluation);
  activeSpan?.setAttribute('warden.feedback.auto_resolve.stale_count', autoResolvedByStaleCheck);

  // Dismiss CHANGES_REQUESTED only if every unresolved comment was resolved
  if (allResolved) {
    const previousReviewInfo = await fetchPreviousReviewInfo(octokit, context);
    if (previousReviewInfo?.state === 'CHANGES_REQUESTED') {
      if (!await gate.canWrite()) {
        return findingObservations;
      }

      try {
        await octokit.pulls.dismissReview({
          owner: context.repository.owner,
          repo: context.repository.name,
          pull_number: context.pullRequest.number,
          review_id: previousReviewInfo.reviewId,
          message: 'All previously reported issues have been resolved.',
        });
        logAction('Dismissed previous CHANGES_REQUESTED review');
      } catch (error) {
        warnAction(`Failed to dismiss previous review: ${error}`);
        if (options.failOnWriteError) {
          throw new ReportWriteError('Failed to dismiss previous review', error);
        }
      }
    }
  }

  return findingObservations;
}

/**
 * Run the analysis phase without GitHub reporting writes.
 * It executes matched triggers and writes the replay artifact for report mode.
 */
async function runAnalyzeMode(
  inputs: ActionInputs,
  initResult: InitResult,
  span: { setAttribute: (name: string, value: number) => void }
): Promise<void> {
  const {
    context,
    runnerConcurrency,
    resolvedTriggers,
    matchedTriggers,
    skipCoreCheck,
  } = initResult;

  if (skipCoreCheck || matchedTriggers.length === 0) {
    setOutput('findings-count', 0);
    setOutput('high-count', 0);
    setOutput('summary', skipCoreCheck?.title ?? 'No triggers matched');
    try {
      const findingsPath = writeFindingsOutput([], context, [], {
        triggerResults: [],
        configuredSkills: buildConfiguredSkillsList({ allTriggers: resolvedTriggers, matchedTriggers }),
      });
      logAction(`Findings written to ${findingsPath}`);
    } catch (error) {
      setFailed(`Failed to write findings output: ${error}`);
    }
    writeSchemaV2Outputs(inputs, context, resolvedTriggers, matchedTriggers, [], [], setFailed);
    logAction('Analysis complete: 0 total findings');
    return;
  }

  const results = await Sentry.startSpan(
    {
      op: 'workflow.execute',
      name: 'execute triggers',
      attributes: { 'warden.trigger.count': matchedTriggers.length },
    },
    () => executeAllTriggers(matchedTriggers, context, runnerConcurrency, inputs),
  );

  const reports = results.flatMap((result) => (result.report ? [result.report] : []));
  const outputs = computeWorkflowOutputs(reports);
  setWorkflowOutputs(outputs);
  span.setAttribute('warden.finding.count', reports.flatMap((r) => r.findings).length);

  try {
    const findingsPath = writeFindingsOutput(reports, context, [], {
      triggerResults: toReplayTriggerResults(results),
      configuredSkills: buildConfiguredSkillsList({ allTriggers: resolvedTriggers, matchedTriggers }),
    });
    logAction(`Findings written to ${findingsPath}`);
  } catch (error) {
    setFailed(`Failed to write findings output: ${error}`);
  }

  writeSchemaV2Outputs(inputs, context, resolvedTriggers, matchedTriggers, results, [], setFailed);

  handleTriggerErrors(collectTriggerErrors(results), matchedTriggers.length, { failAll: false });
  logAction(`Analysis complete: ${outputs.findingsCount} total findings`);
}

function readMetadataFileV2(inputPath: string | undefined, repoPath: string): WardenMetadata {
  const filePath = resolveFindingsFilePath(
    inputPath, repoPath,
    'metadata-file is required when mode is report and output-schema-version is \'2\''
  );

  try {
    return WardenMetadataSchema.parse(JSON.parse(readFileSync(filePath, 'utf-8')));
  } catch (error) {
    setFailed(`Failed to read metadata file ${filePath}: ${error}`);
  }
}

function readFindingsFileV2(inputPath: string | undefined, repoPath: string): WardenFindingsV2 {
  const filePath = resolveFindingsFilePath(inputPath, repoPath);

  try {
    return WardenFindingsSchemaV2.parse(JSON.parse(readFileSync(filePath, 'utf-8')));
  } catch (error) {
    setFailed(`Failed to read findings file ${filePath}: ${error}`);
  }
}

function validateV2OutputsMatchContext(
  metadata: WardenMetadata,
  findings: WardenFindingsV2,
  context: EventContext
): void {
  if (metadata.runId !== findings.runId || metadata.schemaVersion !== findings.schemaVersion) {
    setFailed('Metadata file and findings file do not share the same runId/schemaVersion');
  }

  if (metadata.repository.fullName !== context.repository.fullName) {
    setFailed(
      `Metadata file is for ${metadata.repository.fullName}, but this workflow is for ${context.repository.fullName}`
    );
  }

  if (metadata.event !== context.eventType) {
    setFailed(`Metadata file event ${metadata.event} does not match ${context.eventType}`);
  }

  if (!context.pullRequest) {
    return;
  }

  if (!metadata.pullRequest) {
    setFailed('Metadata file is missing pull request metadata');
  }

  if (metadata.pullRequest.number !== context.pullRequest.number) {
    setFailed(
      `Metadata file is for PR #${metadata.pullRequest.number}, but this workflow is for PR #${context.pullRequest.number}`
    );
  }

  if (metadata.pullRequest.headSha !== context.pullRequest.headSha) {
    setFailed(
      `Metadata file head SHA ${metadata.pullRequest.headSha} does not match current head SHA ${context.pullRequest.headSha}`
    );
  }
}

function toFindingFromV2(finding: ExportedFindingV2): Finding {
  return {
    id: finding.id,
    severity: finding.severity,
    confidence: finding.confidence,
    title: finding.title,
    description: finding.description,
    verification: finding.verification,
    location: finding.location,
    additionalLocations: finding.additionalLocations,
    sourceSnippet: finding.sourceSnippet,
  };
}

/**
 * Rebuild report-mode trigger results from schema-v2 metadata/findings artifacts,
 * mirroring buildReportModeResults's v1 join-by-trigger-identity behavior.
 */
function buildReportModeResultsV2(
  metadata: WardenMetadata,
  findingsOutput: WardenFindingsV2,
  matchedTriggers: ResolvedTrigger[],
  inputs: ActionInputs
): TriggerResult[] {
  const executionsWithTriggerId = findingsOutput.skillExecutions.filter((execution) => execution.triggerId);
  const duplicateExecutionTriggerIds = new Set<string>();
  const seenExecutionTriggerIds = new Set<string>();
  for (const execution of executionsWithTriggerId) {
    const triggerId = execution.triggerId as string;
    if (seenExecutionTriggerIds.has(triggerId)) {
      duplicateExecutionTriggerIds.add(triggerId);
    }
    seenExecutionTriggerIds.add(triggerId);
  }
  if (duplicateExecutionTriggerIds.size > 0) {
    const skillNames = executionsWithTriggerId
      .filter((execution) => duplicateExecutionTriggerIds.has(execution.triggerId as string))
      .map((execution) => execution.skillName)
      .join(', ');
    throw new Error(`Findings file contains ambiguous duplicate trigger result(s): ${skillNames}`);
  }

  const executionsByTriggerId = new Map(
    executionsWithTriggerId.map((execution) => [execution.triggerId as string, execution])
  );
  const findingsByExecutionScopedId = new Map(
    findingsOutput.findings.map((finding) => [`${finding.provenance.originSkillExecutionId}:${finding.id}`, finding])
  );
  const errorByTriggerId = new Map(
    (metadata.triggerResults ?? [])
      .filter((result) => result.status === 'error' && result.triggerId)
      .map((result) => [result.triggerId as string, (result as { error: { name?: string; message: string } }).error])
  );

  const consumedTriggerIds = new Set<string>();

  const results = matchedTriggers.map((trigger) => {
    const failOn = trigger.failOn ?? inputs.failOn;
    const reportOn = trigger.reportOn ?? inputs.reportOn;
    const minConfidence = trigger.minConfidence ?? 'medium';
    const requestChanges = trigger.requestChanges ?? inputs.requestChanges;
    const failCheck = trigger.failCheck ?? inputs.failCheck;
    const maxFindings = trigger.maxFindings ?? inputs.maxFindings;
    const baseResult = {
      triggerId: trigger.id,
      triggerName: trigger.name,
      skillName: trigger.skill,
      skillExecutionId: trigger.skillExecutionId,
      failOn,
      reportOn,
      minConfidence,
      reportOnSuccess: trigger.reportOnSuccess,
      requestChanges,
      failCheck,
      maxFindings,
    };

    const execution = executionsByTriggerId.get(trigger.id);
    if (!execution) {
      const error = errorByTriggerId.get(trigger.id);
      return {
        ...baseResult,
        error: error
          ? deserializeTriggerError(error, `Trigger ${trigger.name} (${trigger.skill}) failed during analysis`)
          : new Error(`Findings file has no result for trigger ${trigger.name} (${trigger.skill})`),
      };
    }
    consumedTriggerIds.add(trigger.id);

    const findings = execution.findingIds.flatMap((id) => {
      const finding = findingsByExecutionScopedId.get(`${execution.skillExecutionId}:${id}`);
      return finding ? [toFindingFromV2(finding)] : [];
    });

    const { usage: auxiliaryUsage, attribution: auxiliaryUsageAttribution } = fromAuxiliaryUsageEntries(
      execution.auxiliaryUsage
    );

    const report: SkillReport = {
      skill: execution.skillName,
      summary: execution.summary,
      findings,
      durationMs: execution.durationMs,
      usage: execution.usage,
      auxiliaryUsage,
      auxiliaryUsageAttribution,
      failedHunks: execution.failedHunks,
      failedExtractions: execution.failedExtractions,
      error: execution.error,
      verifierRejections: execution.verifierRejections,
      model: execution.model,
      runtime: execution.runtime,
    };

    return { ...baseResult, report };
  });

  const unreportedExecutions = executionsWithTriggerId.filter(
    (execution) => !consumedTriggerIds.has(execution.triggerId as string)
  );
  if (unreportedExecutions.length > 0) {
    const skillNames = unreportedExecutions.map((execution) => execution.skillName).join(', ');
    throw new Error(
      `Findings file contains ${unreportedExecutions.length} result(s) that do not match current config: ${skillNames}`
    );
  }

  return results;
}

/**
 * Run the reporting phase without rerunning skills.
 * It replays analyze output against the current PR config and owns GitHub writes.
 */
async function runReportMode(
  octokit: Octokit,
  inputs: ActionInputs,
  initResult: InitResult,
  repoPath: string,
  span: { setAttribute: (name: string, value: number) => void }
): Promise<void> {
  const {
    context,
    auxiliaryOptions,
    resolvedTriggers,
    matchedTriggers,
    skippedTriggers,
    skipCoreCheck,
  } = initResult;
  let metadataOutputV2: WardenMetadata | undefined;
  let findingsOutputV2: WardenFindingsV2 | undefined;
  let findingsOutputV1: FindingsOutput | undefined;
  if (inputs.outputSchemaVersion === '2') {
    metadataOutputV2 = readMetadataFileV2(inputs.metadataFile, repoPath);
    findingsOutputV2 = readFindingsFileV2(inputs.findingsFile, repoPath);
    validateV2OutputsMatchContext(metadataOutputV2, findingsOutputV2, context);
  } else {
    findingsOutputV1 = readFindingsFile(inputs.findingsFile, repoPath);
    validateFindingsMatchContext(findingsOutputV1, context);
  }

  let results: TriggerResult[] = [];
  let previousReviewInfo: BotReviewInfo | null = null;
  let reviewPhase!: ReviewPhaseResult;
  let triggerErrors!: string[];
  let canResolveStale!: boolean;

  try {
    results = metadataOutputV2 && findingsOutputV2
      ? buildReportModeResultsV2(metadataOutputV2, findingsOutputV2, matchedTriggers, inputs)
      : buildReportModeResults(findingsOutputV1 as FindingsOutput, matchedTriggers, inputs);
    await createCompletedSkippedSkillChecks(octokit, context, skippedTriggers);

    if (skipCoreCheck) {
      const outputs = { findingsCount: 0, highCount: 0, summary: skipCoreCheck.title };
      setWorkflowOutputs(outputs);
      try {
        const findingsPath = writeFindingsOutput([], context, [], {
          triggerResults: [],
          configuredSkills: buildConfiguredSkillsList({ allTriggers: resolvedTriggers, matchedTriggers }),
        });
        logAction(`Findings written to ${findingsPath}`);
      } catch (error) {
        warnAction(`Failed to write findings output: ${error}`);
      }
      writeSchemaV2ReportOutputs(metadataOutputV2, findingsOutputV2, context, matchedTriggers, [], warnAction);
      await createCompletedCoreCheckForReport(
        octokit,
        context,
        [],
        [],
        false,
        outputs,
        {
          title: skipCoreCheck.title,
          message: skipCoreCheck.message,
        },
        'neutral'
      );
      logAction('Analysis complete: 0 total findings');
      return;
    }

    if (matchedTriggers.length === 0) {
      const cleanupFindingObservations = await cleanupOrphanedComments(
        octokit,
        context,
        inputs,
        auxiliaryOptions,
        { failOnWriteError: true }
      );
      const outputs = { findingsCount: 0, highCount: 0, summary: 'No triggers matched' };
      setWorkflowOutputs(outputs);
      try {
        const findingsPath = writeFindingsOutput([], context, cleanupFindingObservations, {
          triggerResults: [],
          configuredSkills: buildConfiguredSkillsList({ allTriggers: resolvedTriggers, matchedTriggers }),
        });
        logAction(`Findings written to ${findingsPath}`);
      } catch (error) {
        warnAction(`Failed to write findings output: ${error}`);
      }
      writeSchemaV2ReportOutputs(
        metadataOutputV2, findingsOutputV2, context, matchedTriggers, cleanupFindingObservations, warnAction
      );
      await createCompletedCoreCheckForReport(
        octokit,
        context,
        [],
        [],
        false,
        outputs,
        {
          title: 'No triggers matched',
          message: 'No triggers matched for this event.',
        },
        'neutral'
      );
      logAction('Analysis complete: 0 total findings');
      return;
    }

    results = await createCompletedSkillChecksForReport(octokit, context, results);

    previousReviewInfo = await fetchPreviousReviewInfo(octokit, context);
    if (previousReviewInfo) {
      logAction(`Previous Warden review state: ${previousReviewInfo.state}`);
    }

    const gate = new ReviewFeedbackGate(octokit, context);
    reviewPhase = await Sentry.startSpan(
      { op: 'workflow.review', name: 'post reviews' },
      () => postReviewsAndTrackFailures(octokit, context, results, inputs, auxiliaryOptions, gate, {
        failOnPostError: true,
      }),
    );

    triggerErrors = collectTriggerErrors(results);
    canResolveStale = shouldResolveStaleComments(results);
    const allFindings = reviewPhase.reports.flatMap((r) => r.findings);
    span.setAttribute('warden.finding.count', allFindings.length);

    await Sentry.startSpan(
      { op: 'workflow.resolve', name: 'resolve stale comments' },
      async (resolveSpan) => {
        const resolutionResult = await evaluateFixesAndResolveStale(
          octokit, context, reviewPhase.fetchedComments,
          allFindings, reviewPhase.activeWardenCommentIds,
          canResolveStale, inputs.anthropicApiKey,
          auxiliaryOptions, gate, matchedTriggers,
          { failOnWriteError: true },
        );
        resolveSpan.setAttribute(
          'warden.feedback.auto_resolve.fix_eval_count',
          resolutionResult.autoResolvedByFixEvaluation
        );
        resolveSpan.setAttribute(
          'warden.feedback.auto_resolve.stale_count',
          resolutionResult.autoResolvedByStaleCheck
        );
        reviewPhase.findingObservations.push(...resolutionResult.findingObservations);
      },
    );

    await finalizeReportWorkflow(
      octokit, context, previousReviewInfo,
      results, reviewPhase.reports,
      reviewPhase.findingObservations,
      reviewPhase.shouldFailAction, reviewPhase.failureReasons,
      canResolveStale,
      gate,
      triggerErrors,
      { failOnWriteError: true, matchedTriggers, resolvedTriggers, inputs, metadataOutputV2, findingsOutputV2 },
    );
  } catch (error) {
    if (error instanceof ActionFailedError) {
      throw error;
    }
    await createFailedCoreCheckForReport(octokit, context, error);
    throw error;
  }

  handleTriggerErrors(triggerErrors, matchedTriggers.length);
}

// -----------------------------------------------------------------------------
// Main PR Workflow
// -----------------------------------------------------------------------------

/**
 * Dispatch PR and push events through legacy run mode or split analyze/report mode.
 */
export async function runPRWorkflow(
  octokit: Octokit,
  inputs: ActionInputs,
  eventName: string,
  eventPath: string,
  repoPath: string
): Promise<void> {
  return Sentry.startSpan(
    { op: 'workflow.run', name: 'review pull_request' },
    async (span) => {
      const initResult = await Sentry.startSpan(
        { op: 'workflow.init', name: 'initialize workflow' },
        () => initializeWorkflow(octokit, inputs, eventName, eventPath, repoPath),
      );

      const {
        context,
        runnerConcurrency,
        auxiliaryOptions,
        resolvedTriggers,
        matchedTriggers,
        skippedTriggers,
        skipCoreCheck,
      } = initResult;
      span.setAttribute('warden.trigger.count', matchedTriggers.length);

      // Set Sentry context after building event context
      if (context.pullRequest) {
        Sentry.setUser({ username: context.pullRequest.author });
      }
      Sentry.setContext('repository', {
        owner: context.repository.owner,
        name: context.repository.name,
      });
      if (context.pullRequest) {
        Sentry.setContext('pull_request', {
          number: context.pullRequest.number,
          baseBranch: context.pullRequest.baseBranch,
          headBranch: context.pullRequest.headBranch,
        });
      }

      emitRunMetric();

      const traceId = span.spanContext().traceId;
      logger.info('Workflow initialized', {
        'warden.trigger.count': matchedTriggers.length,
        'trace.id': traceId,
      });

      if (inputs.mode === 'analyze') {
        return runAnalyzeMode(inputs, initResult, span);
      }

      if (inputs.mode === 'report') {
        return runReportMode(octokit, inputs, initResult, repoPath, span);
      }

      const { coreCheckId, previousReviewInfo } = await Sentry.startSpan(
        { op: 'workflow.setup', name: 'setup github state' },
        () => setupGitHubState(octokit, context),
      );

      await completeSkippedSkillChecks(octokit, context, skippedTriggers);

      if (skipCoreCheck) {
        setOutput('findings-count', 0);
        setOutput('high-count', 0);
        setOutput('summary', skipCoreCheck.title);
        try {
          writeFindingsOutput([], context, [], {
            configuredSkills: buildConfiguredSkillsList({ allTriggers: resolvedTriggers, matchedTriggers }),
          });
        } catch (error) {
          warnAction(`Failed to write findings output: ${error}`);
        }
        writeSchemaV2Outputs(inputs, context, resolvedTriggers, matchedTriggers, [], [], warnAction);
        await completeSkippedCoreCheck(octokit, context, coreCheckId, skipCoreCheck);
        return;
      }

      if (matchedTriggers.length === 0) {
        await runOrFailCore(octokit, context, coreCheckId, async () => {
          const cleanupFindingObservations = await cleanupOrphanedComments(
            octokit,
            context,
            inputs,
            auxiliaryOptions
          );
          setOutput('findings-count', 0);
          setOutput('high-count', 0);
          setOutput('summary', 'No triggers matched');
          try {
            writeFindingsOutput([], context, cleanupFindingObservations, {
              configuredSkills: buildConfiguredSkillsList({ allTriggers: resolvedTriggers, matchedTriggers }),
            });
          } catch (error) {
            warnAction(`Failed to write findings output: ${error}`);
          }
          writeSchemaV2Outputs(inputs, context, resolvedTriggers, matchedTriggers, [], cleanupFindingObservations, warnAction);
          await completeSkippedCoreCheck(octokit, context, coreCheckId, {
            title: 'No triggers matched',
            message: 'No triggers matched for this event.',
          });
        });
        return;
      }

      let results: TriggerResult[];
      try {
        results = await Sentry.startSpan(
          {
            op: 'workflow.execute',
            name: 'execute triggers',
            attributes: { 'warden.trigger.count': matchedTriggers.length },
          },
          () => executeAllTriggers(matchedTriggers, context, runnerConcurrency, inputs, {
            checks: createTriggerCheckReporter(octokit, context),
          }),
        );
      } catch (error) {
        await failUndispatchedSkillChecks(octokit, context, matchedTriggers, error);
        await failCoreCheck(octokit, context, coreCheckId, error);
        throw error;
      }

      const gate = new ReviewFeedbackGate(octokit, context);
      const reviewPhase = await runOrFailCore(
        octokit,
        context,
        coreCheckId,
        () => Sentry.startSpan(
          { op: 'workflow.review', name: 'post reviews' },
          () => postReviewsAndTrackFailures(octokit, context, results, inputs, auxiliaryOptions, gate),
        ),
      );

      const triggerErrors = collectTriggerErrors(results);
      const canResolveStale = shouldResolveStaleComments(results);
      const allFindings = reviewPhase.reports.flatMap((r) => r.findings);
      span.setAttribute('warden.finding.count', allFindings.length);

      await runOrFailCore(
        octokit,
        context,
        coreCheckId,
        () => Sentry.startSpan(
          { op: 'workflow.resolve', name: 'resolve stale comments' },
          async (resolveSpan) => {
            const resolutionResult = await evaluateFixesAndResolveStale(
              octokit, context, reviewPhase.fetchedComments,
              allFindings, reviewPhase.activeWardenCommentIds,
              canResolveStale, inputs.anthropicApiKey,
              auxiliaryOptions, gate, matchedTriggers,
            );
            resolveSpan.setAttribute(
              'warden.feedback.auto_resolve.fix_eval_count',
              resolutionResult.autoResolvedByFixEvaluation
            );
            resolveSpan.setAttribute(
              'warden.feedback.auto_resolve.stale_count',
              resolutionResult.autoResolvedByStaleCheck
            );
            reviewPhase.findingObservations.push(...resolutionResult.findingObservations);
          },
        ),
      );

      await finalizeWorkflow(
        octokit, context, previousReviewInfo, coreCheckId,
        results, reviewPhase.reports,
        reviewPhase.findingObservations,
        reviewPhase.shouldFailAction, reviewPhase.failureReasons,
        canResolveStale,
        gate,
        triggerErrors,
        matchedTriggers,
        resolvedTriggers,
        inputs,
      );

      handleTriggerErrors(triggerErrors, matchedTriggers.length);
    },
  );
}
