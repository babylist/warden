import { z } from 'zod';
import type { EventContext, Finding, SkillReport } from '../../types/index.js';
import {
  AuxiliaryUsageMapSchema,
  FindingSchema,
  GitHubEventTypeSchema,
  LocationSchema,
  SkillErrorSchema,
  SourceSnippetSchema,
  UsageStatsSchema,
  VerifierRejectionsSchema,
} from '../../types/index.js';
import type { FindingObservation } from './outcomes.js';
import { FindingObservationSchema } from './outcomes.js';
import { displayFindingId } from '../../cli/output/formatters.js';

const ExportedFindingSchema = z.object({
  id: z.string(),
  severity: FindingSchema.shape.severity,
  confidence: FindingSchema.shape.confidence,
  title: z.string(),
  description: z.string(),
  location: LocationSchema.optional(),
  additionalLocations: z.array(LocationSchema).optional(),
  sourceSnippet: SourceSnippetSchema.optional(),
});

const TriggerErrorSchema = z.object({
  name: z.string().optional(),
  message: z.string(),
});

// Durable analyze/report replay rows join by triggerName plus configured
// skillName. `report.skill` is preserved as report identity and may differ for
// local path skills with frontmatter names.
const TriggerRunResultBaseSchema = z.object({
  triggerId: z.string().optional(),
  triggerName: z.string(),
  skillName: z.string(),
});

const ReplaySkillReportSchema = z.object({
  skill: z.string(),
  summary: z.string(),
  findings: z.array(FindingSchema),
  durationMs: z.number().nonnegative().optional(),
  usage: UsageStatsSchema.optional(),
  auxiliaryUsage: AuxiliaryUsageMapSchema.optional(),
  model: z.string().optional(),
  failedHunks: z.number().int().nonnegative().optional(),
  failedExtractions: z.number().int().nonnegative().optional(),
  error: SkillErrorSchema.optional(),
  verifierRejections: VerifierRejectionsSchema.optional(),
});

export const TriggerRunResultSchema = z.discriminatedUnion('status', [
  TriggerRunResultBaseSchema.extend({
    status: z.literal('success'),
    report: ReplaySkillReportSchema,
    error: z.never().optional(),
  }),
  TriggerRunResultBaseSchema.extend({
    status: z.literal('error'),
    report: z.never().optional(),
    error: TriggerErrorSchema,
  }),
]);

export const FindingsOutputSchema = z.object({
  version: z.literal('1'),
  timestamp: z.string().datetime(),
  repository: z.object({
    owner: z.string(),
    name: z.string(),
    fullName: z.string(),
  }),
  event: GitHubEventTypeSchema,
  pullRequest: z.object({
    number: z.number().int(),
    author: z.string(),
    title: z.string(),
    baseBranch: z.string(),
    headBranch: z.string(),
    headSha: z.string(),
  }).optional(),
  runId: z.string(),
  summary: z.object({
    totalFindings: z.number().int().nonnegative(),
    findingsBySeverity: z.object({
      high: z.number().int().nonnegative(),
      medium: z.number().int().nonnegative(),
      low: z.number().int().nonnegative(),
    }),
    totalSkills: z.number().int().nonnegative(),
  }),
  skills: z.array(z.object({
    name: z.string(),
    summary: z.string(),
    model: z.string().optional(),
    durationMs: z.number().nonnegative().optional(),
    usage: UsageStatsSchema.optional(),
    failedHunks: z.number().int().nonnegative().optional(),
    failedExtractions: z.number().int().nonnegative().optional(),
    error: SkillErrorSchema.optional(),
    verifierRejections: VerifierRejectionsSchema.optional(),
    findings: z.array(ExportedFindingSchema),
  })),
  triggerResults: z.array(TriggerRunResultSchema).optional(),
  findingObservations: z.array(FindingObservationSchema),
  configuredSkills: z.array(z.object({
    name: z.string(),
    triggered: z.boolean(),
  })).optional(),
});

export type FindingsOutput = z.infer<typeof FindingsOutputSchema>;

export interface ReplayTriggerResult {
  triggerId?: string;
  triggerName: string;
  skillName: string;
  report?: SkillReport;
  error?: unknown;
}

interface BuildFindingsOutputOptions {
  timestamp?: string;
  runId?: string;
  triggerResults?: ReplayTriggerResult[];
  configuredSkills?: { name: string; triggered: boolean }[];
}

/** Build the configured-skills roster, deduping by name since a skill's multiple trigger blocks (e.g. PR + schedule) share one name. */
export function buildConfiguredSkillsList({
  allTriggers,
  matchedTriggers,
}: {
  allTriggers: { name: string }[];
  matchedTriggers: { name: string }[];
}): { name: string; triggered: boolean }[] {
  const matchedNames = new Set(matchedTriggers.map((t) => t.name));
  const seen = new Set<string>();
  const result: { name: string; triggered: boolean }[] = [];

  for (const trigger of allTriggers) {
    if (seen.has(trigger.name)) continue;
    seen.add(trigger.name);
    result.push({ name: trigger.name, triggered: matchedNames.has(trigger.name) });
  }

  return result;
}

export function serializeTriggerError(error: unknown): z.infer<typeof TriggerErrorSchema> {
  if (error instanceof Error) {
    return {
      name: error.name,
      message: error.message,
    };
  }

  return { message: String(error) };
}

function serializeReplayReport(report: SkillReport): z.infer<typeof ReplaySkillReportSchema> {
  return {
    skill: report.skill,
    summary: report.summary,
    findings: report.findings.map((f) => ({ ...f, id: v1ContinuityId(f) })),
    durationMs: report.durationMs,
    usage: report.usage,
    auxiliaryUsage: report.auxiliaryUsage,
    model: report.model,
    failedHunks: report.failedHunks,
    failedExtractions: report.failedExtractions,
    error: report.error,
    verifierRejections: report.verifierRejections,
  };
}

function serializeTriggerResult(result: ReplayTriggerResult): z.infer<typeof TriggerRunResultSchema> {
  if (result.report) {
    return {
      triggerId: result.triggerId,
      triggerName: result.triggerName,
      skillName: result.skillName,
      status: 'success',
      report: serializeReplayReport(result.report),
    };
  }

  return {
    triggerId: result.triggerId,
    triggerName: result.triggerName,
    skillName: result.skillName,
    status: 'error',
    error: serializeTriggerError(result.error ?? 'Trigger did not produce a report'),
  };
}

/**
 * v1 predates the id/reportedId split and has always used a single `id` per
 * finding, mutated to match an existing comment on dedupe. `reportedId ?? id`
 * preserves that continuity behavior for v1 consumers without mutating the
 * underlying Finding.
 */
function v1ContinuityId(finding: Finding): string {
  return displayFindingId(finding);
}

/**
 * `FindingObservation`/`DedupeDetail` (outcomes.ts) carry `skillExecutionId`,
 * `githubCommentId`/`githubCommentUrl`, and `dedupe.existingSkillExecutionId`/
 * `existingSkills` for schema-v2 consumers. v1 predates all of these, so drop
 * them here rather than spreading the observation as-is, keeping v1 output
 * byte-for-byte what it was before schema v2 existed.
 */
function serializeV1FindingObservation(observation: FindingObservation): z.infer<typeof FindingObservationSchema> {
  const finding = { ...observation.finding, id: v1ContinuityId(observation.finding) };

  switch (observation.outcome) {
    case 'posted':
      return { outcome: 'posted', finding, skill: observation.skill };
    case 'deduped':
      return {
        outcome: 'deduped',
        finding,
        skill: observation.skill,
        dedupe: {
          source: observation.dedupe.source,
          matchType: observation.dedupe.matchType,
          existingFindingId: observation.dedupe.existingFindingId,
          existingCommentId: observation.dedupe.existingCommentId,
          existingThreadId: observation.dedupe.existingThreadId,
          existingResolved: observation.dedupe.existingResolved,
          actor: observation.dedupe.actor,
        },
      };
    case 'skipped':
      return { outcome: 'skipped', finding, skill: observation.skill, skippedReason: observation.skippedReason };
    case 'resolved':
      return { outcome: 'resolved', finding, skill: observation.skill, resolvedReason: observation.resolvedReason };
    case 'failed':
      return { outcome: 'failed', finding, skill: observation.skill };
  }
}

/** Build the public findings export payload. */
export function buildFindingsOutput(
  reports: SkillReport[],
  context: EventContext,
  findingObservations: FindingObservation[] = [],
  options: BuildFindingsOutputOptions = {}
): FindingsOutput {
  const allFindings = reports.flatMap((r) => r.findings);
  const output = {
    version: '1',
    timestamp: options.timestamp ?? new Date().toISOString(),
    repository: {
      owner: context.repository.owner,
      name: context.repository.name,
      fullName: context.repository.fullName,
    },
    event: context.eventType,
    ...(context.pullRequest && {
      pullRequest: {
        number: context.pullRequest.number,
        author: context.pullRequest.author,
        title: context.pullRequest.title,
        baseBranch: context.pullRequest.baseBranch,
        headBranch: context.pullRequest.headBranch,
        headSha: context.pullRequest.headSha,
      },
    }),
    runId: options.runId ?? process.env['GITHUB_RUN_ID'] ?? '',
    summary: {
      totalFindings: allFindings.length,
      findingsBySeverity: {
        high: allFindings.filter((f) => f.severity === 'high').length,
        medium: allFindings.filter((f) => f.severity === 'medium').length,
        low: allFindings.filter((f) => f.severity === 'low').length,
      },
      totalSkills: reports.length,
    },
    skills: reports.map((r) => ({
      name: r.skill,
      summary: r.summary,
      model: r.model,
      durationMs: r.durationMs,
      usage: r.usage,
      failedHunks: r.failedHunks,
      failedExtractions: r.failedExtractions,
      error: r.error,
      verifierRejections: r.verifierRejections,
      findings: r.findings.map((f) => ({
        id: v1ContinuityId(f),
        severity: f.severity,
        confidence: f.confidence,
        title: f.title,
        description: f.description,
        location: f.location,
        additionalLocations: f.additionalLocations,
        sourceSnippet: f.sourceSnippet,
      })),
    })),
    ...(options.triggerResults && {
      triggerResults: options.triggerResults.map(serializeTriggerResult),
    }),
    findingObservations: findingObservations.map(serializeV1FindingObservation),
    ...(options.configuredSkills && { configuredSkills: options.configuredSkills }),
  };

  return FindingsOutputSchema.parse(output);
}
