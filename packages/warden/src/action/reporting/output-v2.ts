import { z } from 'zod';
import {
  ConfidenceSchema,
  ConfidenceThresholdSchema,
  filterFindings,
  GitHubEventTypeSchema,
  LocationSchema,
  SeveritySchema,
  SeverityThresholdSchema,
  SkillErrorSchema,
  SourceSnippetSchema,
  UsageStatsSchema,
  VerifierRejectionsSchema,
} from '../../types/index.js';
import type {
  AuxiliaryUsageAttributionMap,
  AuxiliaryUsageMap,
  EventContext,
  Finding,
  Severity,
  SeverityThreshold,
  SkillReport,
} from '../../types/index.js';
import type { ResolvedTrigger } from '../../config/loader.js';
import { matchPullRequestState } from '../../triggers/matcher.js';
import type { TriggerResult } from '../triggers/executor.js';
import { buildConfiguredSkillsList, serializeTriggerError } from './output.js';
import { generateContentHash } from '../../output/dedup.js';
import { determineConclusion } from '../../output/github-checks.js';
import { getVersion } from '../../utils/version.js';
import { displayFindingId } from '../../cli/output/formatters.js';
import type { FindingObservation } from './outcomes.js';

export const SeverityBreakdownSchema = z.object({
  high: z.number().int().nonnegative(),
  medium: z.number().int().nonnegative(),
  low: z.number().int().nonnegative(),
});
export type SeverityBreakdown = z.infer<typeof SeverityBreakdownSchema>;

const HarnessSchema = z.object({
  name: z.literal('warden'),
  version: z.string(),
  actionRef: z.string().optional(),
});

const RepositorySchema = z.object({
  owner: z.string(),
  name: z.string(),
  fullName: z.string(),
});

const PullRequestEnvelopeSchema = z.object({
  number: z.number().int(),
  author: z.string(),
  title: z.string(),
  baseBranch: z.string(),
  headBranch: z.string(),
  headSha: z.string(),
});

const ConfiguredSkillSchema = z.object({
  name: z.string(),
  triggered: z.boolean(),
});

export const SkippedTriggerReasonSchema = z.enum([
  'no_event_match',
  'path_filter',
  'draft_state',
  'label_mismatch',
  'no_changes',
  'pending',
]);

const SkippedTriggerSchema = z.object({
  skillName: z.string(),
  triggerId: z.string().optional(),
  triggerName: z.string().optional(),
  reason: SkippedTriggerReasonSchema,
});

const TriggerErrorSchema = z.object({
  name: z.string().optional(),
  message: z.string(),
});

export const TriggerRunResultV2Schema = z.discriminatedUnion('status', [
  z.object({
    status: z.literal('success'),
    triggerId: z.string().optional(),
    triggerName: z.string(),
    skillName: z.string(),
  }),
  z.object({
    status: z.literal('error'),
    triggerId: z.string().optional(),
    triggerName: z.string(),
    skillName: z.string(),
    error: TriggerErrorSchema,
  }),
]);

const ResolvedDefaultsSchema = z.object({
  failOn: SeverityThresholdSchema.optional(),
  reportOn: SeverityThresholdSchema.optional(),
  minConfidence: ConfidenceThresholdSchema.optional(),
  model: z.string().optional(),
  auxiliaryModel: z.string().optional(),
  synthesisModel: z.string().optional(),
  runtime: z.string().optional(),
  verifyFindings: z.boolean().optional(),
  failCheck: z.boolean().optional(),
  requestChanges: z.boolean().optional(),
  maxFindings: z.number().int().nonnegative().optional(),
});

export const WardenMetadataSchema = z.object({
  schemaVersion: z.literal('2'),
  runId: z.string(),
  runAttempt: z.string().optional(),
  generatedAt: z.string().datetime(),
  harness: HarnessSchema,
  repository: RepositorySchema,
  event: GitHubEventTypeSchema,
  pullRequest: PullRequestEnvelopeSchema.optional(),
  configuredSkills: z.array(ConfiguredSkillSchema).optional(),
  skippedTriggers: z.array(SkippedTriggerSchema).optional(),
  triggerResults: z.array(TriggerRunResultV2Schema).optional(),
  resolvedDefaults: ResolvedDefaultsSchema.optional(),
});
export type WardenMetadata = z.infer<typeof WardenMetadataSchema>;

const AuxiliaryUsageEntrySchema = z.object({
  agent: z.string(),
  model: z.string().optional(),
  runtime: z.string().optional(),
  usage: UsageStatsSchema,
});

export const SkillExecutionSchema = z.object({
  skillExecutionId: z.string(),
  skillName: z.string(),
  triggerId: z.string().optional(),
  triggerName: z.string().optional(),
  model: z.string().optional(),
  models: z.array(z.string()).optional(),
  runtime: z.string().optional(),
  auxiliaryModel: z.string().optional(),
  synthesisModel: z.string().optional(),
  summary: z.string(),
  durationMs: z.number().nonnegative().optional(),
  usage: UsageStatsSchema.optional(),
  auxiliaryUsage: z.array(AuxiliaryUsageEntrySchema).optional(),
  findingsBySeverity: SeverityBreakdownSchema,
  findingIds: z.array(z.string()),
  failedHunks: z.number().int().nonnegative().optional(),
  failedExtractions: z.number().int().nonnegative().optional(),
  error: SkillErrorSchema.optional(),
  verifierRejections: VerifierRejectionsSchema.optional(),
  checkRunUrl: z.string().optional(),
  checkRunId: z.number().int().positive().optional(),
  reviewEvent: z.enum(['APPROVE', 'REQUEST_CHANGES', 'COMMENT']).optional(),
  checkConclusion: z.enum(['success', 'failure', 'neutral', 'cancelled']).optional(),
  issueNumber: z.number().int().positive().optional(),
  issueUrl: z.string().optional(),
});
export type SkillExecution = z.infer<typeof SkillExecutionSchema>;

const FindingSnapshotSchema = z.object({
  title: z.string(),
  description: z.string(),
  severity: SeveritySchema,
  confidence: ConfidenceSchema.optional(),
});

const VerificationStageSchema = z.discriminatedUnion('outcome', [
  z.object({
    outcome: z.literal('kept'),
    model: z.string().optional(),
    runtime: z.string().optional(),
  }),
  z.object({
    outcome: z.literal('revised'),
    model: z.string().optional(),
    runtime: z.string().optional(),
    evidence: z.string().optional(),
    before: FindingSnapshotSchema,
  }),
]);

const MergeStageSchema = z.object({
  model: z.string().optional(),
  runtime: z.string().optional(),
  absorbedFindingIds: z.array(z.string()),
});

export type VerificationStage = z.infer<typeof VerificationStageSchema>;
export type MergeStage = z.infer<typeof MergeStageSchema>;

const FindingProvenanceSchema = z.object({
  originSkillExecutionId: z.string(),
  originModel: z.string().optional(),
  verification: VerificationStageSchema.optional(),
  merge: MergeStageSchema.optional(),
});
export type FindingProvenance = z.infer<typeof FindingProvenanceSchema>;

const FindingAttributionSchema = z.object({
  skillExecutionId: z.string(),
  skillName: z.string(),
  role: z.enum(['primary', 'corroborating']),
  matchType: z.enum(['hash', 'semantic']).optional(),
});
export type FindingAttribution = z.infer<typeof FindingAttributionSchema>;

export const ExportedFindingV2Schema = z.object({
  id: z.string(),
  reportedId: z.string().optional(),
  contentHash: z.string(),
  severity: SeveritySchema,
  confidence: ConfidenceSchema.optional(),
  title: z.string(),
  description: z.string(),
  verification: z.string().optional(),
  location: LocationSchema.optional(),
  additionalLocations: z.array(LocationSchema).optional(),
  sourceSnippet: SourceSnippetSchema.optional(),
  reportedBy: z.array(FindingAttributionSchema).min(1),
  provenance: FindingProvenanceSchema,
  githubCommentId: z.number().int().positive().optional(),
  githubCommentUrl: z.string().optional(),
});
export type ExportedFindingV2 = z.infer<typeof ExportedFindingV2Schema>;

export const DiscardedFindingSchema = z.object({
  originSkillExecutionId: z.string(),
  stage: z.enum(['verification_rejected', 'merge_absorbed']),
  severity: SeveritySchema,
  title: z.string(),
  location: LocationSchema.optional(),
  model: z.string().optional(),
  reason: z.string().optional(),
  survivorFindingId: z.string().optional(),
});
export type DiscardedFinding = z.infer<typeof DiscardedFindingSchema>;

const FindingOriginSchema = z.object({
  skillExecutionId: z.string(),
  skillName: z.string(),
});

export const DedupeDetailV2Schema = z.object({
  source: z.enum(['warden', 'external']),
  matchType: z.enum(['hash', 'semantic']),
  existingFindingId: z.string().optional(),
  existingSkillExecutionId: z.string().optional(),
  existingCommentId: z.number().int().positive().optional(),
  existingThreadId: z.string().optional(),
  existingResolved: z.boolean().optional(),
  existingSkills: z.array(z.string()).optional(),
  actor: z.string().optional(),
});
export type DedupeDetailV2 = z.infer<typeof DedupeDetailV2Schema>;

const ObservedFindingSchema = z.object({
  id: z.string(),
  reportedId: z.string().optional(),
  severity: SeveritySchema,
  confidence: ConfidenceSchema.optional(),
  title: z.string(),
  description: z.string(),
  location: LocationSchema.optional(),
  elapsedMs: z.number().nonnegative().optional(),
});

export const FindingObservationV2Schema = z.discriminatedUnion('outcome', [
  z.object({
    outcome: z.literal('posted'),
    origin: FindingOriginSchema,
    finding: ObservedFindingSchema,
    githubCommentId: z.number().int().positive().optional(),
    githubCommentUrl: z.string().optional(),
  }),
  z.object({
    outcome: z.literal('deduped'),
    origin: FindingOriginSchema,
    finding: ObservedFindingSchema,
    dedupe: DedupeDetailV2Schema,
  }),
  z.object({
    outcome: z.literal('skipped'),
    origin: FindingOriginSchema,
    finding: ObservedFindingSchema,
    skippedReason: z.enum(['max_findings', 'duplicate_in_batch', 'no_inline_location', 'review_not_posted']),
  }),
  z.object({
    outcome: z.literal('resolved'),
    origin: FindingOriginSchema,
    finding: ObservedFindingSchema,
    resolvedReason: z.enum(['fix_evaluation', 'stale_check']),
  }),
  z.object({
    outcome: z.literal('failed'),
    origin: FindingOriginSchema,
    finding: ObservedFindingSchema,
  }),
]);
export type FindingObservationV2 = z.infer<typeof FindingObservationV2Schema>;

const SummarySchema = z.object({
  totalFindings: z.number().int().nonnegative(),
  totalSkillExecutions: z.number().int().nonnegative(),
  bySeverity: SeverityBreakdownSchema,
  byOutcome: z.object({
    posted: z.number().int().nonnegative(),
    deduped: z.number().int().nonnegative(),
    skipped: z.number().int().nonnegative(),
    resolved: z.number().int().nonnegative(),
    failed: z.number().int().nonnegative(),
  }),
});
export type SummaryV2 = z.infer<typeof SummarySchema>;

export const WardenFindingsSchemaV2 = z.object({
  schemaVersion: z.literal('2'),
  runId: z.string(),
  skillExecutions: z.array(SkillExecutionSchema),
  findings: z.array(ExportedFindingV2Schema),
  discardedFindings: z.array(DiscardedFindingSchema).optional(),
  findingObservations: z.array(FindingObservationV2Schema),
  summary: SummarySchema,
});
export type WardenFindingsV2 = z.infer<typeof WardenFindingsSchemaV2>;

// -----------------------------------------------------------------------------
// Builders
// -----------------------------------------------------------------------------

function severityBreakdown(items: { severity: Severity }[]): SeverityBreakdown {
  return {
    high: items.filter((i) => i.severity === 'high').length,
    medium: items.filter((i) => i.severity === 'medium').length,
    low: items.filter((i) => i.severity === 'low').length,
  };
}

function toAuxiliaryUsageEntries(
  usage: AuxiliaryUsageMap | undefined,
  attribution: AuxiliaryUsageAttributionMap | undefined
): z.infer<typeof AuxiliaryUsageEntrySchema>[] {
  if (!usage) return [];
  return Object.entries(usage).map(([agent, agentUsage]) => {
    const agentAttribution = attribution?.[agent];
    return {
      agent,
      model: agentAttribution?.model ?? agentAttribution?.models?.[0],
      runtime: agentAttribution?.runtime ?? agentAttribution?.runtimes?.[0],
      usage: agentUsage,
    };
  });
}

/** Inverse of {@link toAuxiliaryUsageEntries} — rebuilds the record-keyed shape SkillReport expects. */
export function fromAuxiliaryUsageEntries(
  entries: z.infer<typeof AuxiliaryUsageEntrySchema>[] | undefined
): { usage: AuxiliaryUsageMap | undefined; attribution: AuxiliaryUsageAttributionMap | undefined } {
  if (!entries || entries.length === 0) return { usage: undefined, attribution: undefined };

  const usage: AuxiliaryUsageMap = {};
  const attribution: AuxiliaryUsageAttributionMap = {};
  for (const entry of entries) {
    usage[entry.agent] = entry.usage;
    if (entry.model || entry.runtime) {
      attribution[entry.agent] = { model: entry.model, runtime: entry.runtime };
    }
  }
  return { usage, attribution: Object.keys(attribution).length > 0 ? attribution : undefined };
}

function deriveSkippedReason(
  trigger: ResolvedTrigger,
  context: EventContext
): z.infer<typeof SkippedTriggerReasonSchema> {
  if (trigger.type === 'local') return 'no_event_match';
  if (trigger.type === 'schedule') {
    return context.eventType === 'schedule' ? 'no_changes' : 'no_event_match';
  }
  // schedule.ts only ever evaluates type: 'schedule' triggers - a wildcard
  // trigger never reaches matchTrigger's path-filter check in a scheduled
  // run, so it isn't excluded by paths, it's excluded by event type entirely
  // (same as the 'local'/'pull_request' branches above for a schedule event).
  if (trigger.type === '*' && context.eventType === 'schedule') return 'no_event_match';
  if (trigger.type === 'pull_request') {
    if (context.eventType !== 'pull_request') return 'no_event_match';
    if (!trigger.actions?.includes(context.action)) return 'no_event_match';
    if (!matchPullRequestState(trigger, context)) {
      if (context.action === 'labeled' && trigger.labels !== undefined) {
        const eventLabelMatches = context.label !== undefined && trigger.labels.includes(context.label);
        if (!eventLabelMatches) return 'label_mismatch';
      }
      const labels = context.pullRequest?.labels ?? [];
      const labelMatches = trigger.labels?.some((label) => labels.includes(label));
      if (trigger.labels !== undefined && !labelMatches) return 'label_mismatch';
      return 'draft_state';
    }
  }
  return 'path_filter';
}

export interface BuildMetadataOutputV2Options {
  runId: string;
  runAttempt?: string;
  generatedAt?: string;
  actionRef?: string;
  /** Action-level fallback used by every trigger via `trigger.failOn ?? inputs.failOn`. */
  failOn?: SeverityThreshold;
  /** Action-level fallback used by every trigger via `trigger.reportOn ?? inputs.reportOn`. */
  reportOn?: SeverityThreshold;
  /** Action-level fallback used by every trigger via `trigger.failCheck ?? inputs.failCheck`. */
  failCheck?: boolean;
  /** Action-level fallback used by every trigger via `trigger.requestChanges ?? inputs.requestChanges`. */
  requestChanges?: boolean;
  /** Action-level fallback used by every trigger via `trigger.maxFindings ?? inputs.maxFindings`. */
  maxFindings?: number;
  /** Triggers not yet attempted this run (schedule.ts's sequential loop hasn't reached them), reported as 'pending' instead of a guessed skip reason. */
  pendingTriggerIds?: Set<string>;
}

/** Build the schema-v2 metadata output: static run/repo/harness identity plus the resolved trigger roster. */
export function buildMetadataOutputV2(
  context: EventContext,
  resolvedTriggers: ResolvedTrigger[],
  matchedTriggers: ResolvedTrigger[],
  results: TriggerResult[],
  options: BuildMetadataOutputV2Options
): WardenMetadata {
  const matchedIds = new Set(matchedTriggers.map((t) => t.id));
  const pendingIds = options.pendingTriggerIds;
  const skippedTriggers = resolvedTriggers
    .filter((t) => !matchedIds.has(t.id))
    .map((t) => ({
      skillName: t.skill,
      triggerId: t.id,
      triggerName: t.name,
      reason: pendingIds?.has(t.id) ? ('pending' as const) : deriveSkippedReason(t, context),
    }));

  const triggerResults = results.map((r) =>
    r.error
      ? {
          status: 'error' as const,
          triggerId: r.triggerId,
          triggerName: r.triggerName,
          skillName: r.skillName,
          error: serializeTriggerError(r.error),
        }
      : {
          status: 'success' as const,
          triggerId: r.triggerId,
          triggerName: r.triggerName,
          skillName: r.skillName,
        }
  );

  const primary = matchedTriggers[0];

  return WardenMetadataSchema.parse({
    schemaVersion: '2',
    runId: options.runId,
    runAttempt: options.runAttempt,
    generatedAt: options.generatedAt ?? new Date().toISOString(),
    harness: {
      name: 'warden',
      version: getVersion(),
      actionRef: options.actionRef,
    },
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
    configuredSkills: buildConfiguredSkillsList({ allTriggers: resolvedTriggers, matchedTriggers }),
    skippedTriggers,
    triggerResults,
    ...(primary && {
      resolvedDefaults: {
        failOn: primary.failOn ?? options.failOn,
        reportOn: primary.reportOn ?? options.reportOn,
        minConfidence: primary.minConfidence ?? 'medium',
        model: primary.model,
        auxiliaryModel: primary.auxiliaryModel,
        synthesisModel: primary.synthesisModel,
        runtime: primary.runtime,
        verifyFindings: primary.verifyFindings,
        failCheck: primary.failCheck ?? options.failCheck,
        requestChanges: primary.requestChanges ?? options.requestChanges,
        maxFindings: primary.maxFindings ?? options.maxFindings,
      },
    }),
  });
}

/** skillExecutionId per skill name, restricted to names with exactly one current execution. */
export function skillExecutionIdByNameFrom(matchedTriggers: ResolvedTrigger[]): Map<string, string> {
  const counts = new Map<string, number>();
  const idByName = new Map<string, string>();
  for (const t of matchedTriggers) {
    counts.set(t.skill, (counts.get(t.skill) ?? 0) + 1);
    if (!idByName.has(t.skill)) {
      idByName.set(t.skill, t.skillExecutionId);
    }
  }

  const skillExecutionIdByName = new Map<string, string>();
  for (const [name, id] of idByName) {
    if (counts.get(name) === 1) skillExecutionIdByName.set(name, id);
  }
  return skillExecutionIdByName;
}

/**
 * Resolves an observation's own execution id: its own id, then a by-name
 * fallback. Deliberately falls back to '' (never the bare skill name) when
 * neither is known - an observation can describe a comment from a trigger
 * no longer in the current config, so guessing a truthy-but-wrong id here
 * risks a false match at a `${skillExecutionId}:${id}` compound key.
 */
function resolveObservationSkillExecutionId(
  ownId: string | undefined,
  skillName: string | undefined,
  skillExecutionIdByName: Map<string, string>
): string {
  return ownId ?? skillExecutionIdByName.get(skillName ?? '') ?? '';
}

/**
 * Resolves a current result's own execution id: its own id, then a by-name
 * fallback, then the skill name itself. Unlike the observation-side
 * resolver, this always describes a result that just ran in this process,
 * so falling back to its own (non-empty) skill name is a safe placeholder
 * rather than a guess.
 */
function resolveReportSkillExecutionId(
  ownId: string | undefined,
  skillName: string,
  skillExecutionIdByName: Map<string, string>
): string {
  return ownId ?? skillExecutionIdByName.get(skillName) ?? skillName;
}

function buildFindingObservationsV2(
  findingObservations: FindingObservation[],
  skillExecutionIdByName: Map<string, string>
): { observations: FindingObservationV2[]; byOutcome: SummaryV2['byOutcome'] } {
  const observations: FindingObservationV2[] = findingObservations.map((observation) => {
    const skillExecutionId = resolveObservationSkillExecutionId(observation.skillExecutionId, observation.skill, skillExecutionIdByName);
    const origin = { skillExecutionId, skillName: observation.skill ?? '' };
    const findingSnapshot = {
      id: observation.finding.id,
      reportedId: observation.finding.reportedId,
      severity: observation.finding.severity,
      confidence: observation.finding.confidence,
      title: observation.finding.title,
      description: observation.finding.description,
      location: observation.finding.location,
      elapsedMs: observation.finding.elapsedMs,
    };

    switch (observation.outcome) {
      case 'deduped':
        return { outcome: 'deduped', origin, finding: findingSnapshot, dedupe: observation.dedupe };
      case 'skipped':
        return { outcome: 'skipped', origin, finding: findingSnapshot, skippedReason: observation.skippedReason };
      case 'resolved':
        return { outcome: 'resolved', origin, finding: findingSnapshot, resolvedReason: observation.resolvedReason };
      case 'posted':
        return {
          outcome: 'posted',
          origin,
          finding: findingSnapshot,
          githubCommentId: observation.githubCommentId,
          githubCommentUrl: observation.githubCommentUrl,
        };
      case 'failed':
        return { outcome: 'failed', origin, finding: findingSnapshot };
    }
  });

  const byOutcome = { posted: 0, deduped: 0, skipped: 0, resolved: 0, failed: 0 };
  for (const observation of findingObservations) {
    byOutcome[observation.outcome]++;
  }

  return { observations, byOutcome };
}

interface DedupeAnchor {
  existingCommentId?: number;
  existingThreadId?: string;
}

interface HeuristicCorroboratingCandidate {
  attribution: FindingAttribution;
  targetSkills?: string[];
  anchor: DedupeAnchor;
  /**
   * Set once this candidate is accepted by some target. A heuristic
   * candidate is only ever looked up by its bare `existingFindingId`, which
   * two unrelated fresh findings from different skills can coincidentally
   * share this run - without this flag, both would independently pass the
   * same permissive checks (no anchor on either target, no `targetSkills`
   * filter) and both would attach the same corroborator. Claiming makes the
   * match at most one target's, at the cost of an arbitrary pick (run order)
   * between two truly ambiguous targets - still strictly better than
   * corrupting both.
   */
  claimed: boolean;
}

/**
 * Split by match basis rather than commingled in one list, so a filter
 * written for one basis structurally cannot see candidates of the other.
 * `exact` candidates were matched via a dedupe's `existingSkillExecutionId`
 * (known whenever the match is against a comment posted earlier in the same
 * run) and need no further narrowing - a bare-id collision from an unrelated
 * execution physically cannot share that compound key. `heuristic`
 * candidates are all a match against a comment from a *prior* run can ever
 * produce, since a comment footer only ever records the winner's skill
 * *name*, not its skillExecutionId - these still need the name-based
 * narrowing `resolveCorroboratingAttributions` applies, plus the anchor
 * narrowing below (two prior-run comments can coincidentally share a bare
 * model-assigned finding id just as two current-run findings can).
 */
interface CorroboratingCandidates {
  exact: Map<string, FindingAttribution[]>;
  heuristic: Map<string, HeuristicCorroboratingCandidate[]>;
  /**
   * A resolving finding's own dedupe anchor, keyed by `${skillExecutionId}:${finding.id}` -
   * the finding's own internal id, never its bare `existingFindingId`. Two
   * findings from the same execution routinely share a bare `existingFindingId`
   * (sequential model-assigned continuity ids collide across historical runs),
   * so keying on that would let the second overwrite the first's anchor and
   * silently drop a real corroborator resolved against the first.
   */
  ownAnchors: Map<string, DedupeAnchor>;
}

function exactCorroborationKey(skillExecutionId: string, findingId: string): string {
  return `${skillExecutionId}:${findingId}`;
}

/**
 * Two heuristic candidates only definitely refer to the same prior-run
 * comment when both sides carry a comment/thread id and they match - a bare
 * `existingFindingId` string alone can't tell two coincidentally-same-id
 * prior comments apart, the same collision class `exactCorroborationKey`
 * defends against on the current-run side. When either side lacks an
 * anchor, there's no way to rule the match out, so it's kept (matches the
 * permissive default for unparseable skill metadata).
 */
function anchorsConflict(a: DedupeAnchor, b: DedupeAnchor): boolean {
  if (a.existingCommentId !== undefined && b.existingCommentId !== undefined) {
    return a.existingCommentId !== b.existingCommentId;
  }
  if (a.existingThreadId !== undefined && b.existingThreadId !== undefined) {
    return a.existingThreadId !== b.existingThreadId;
  }
  return false;
}

function buildCorroboratingAttributions(
  findingObservations: FindingObservation[],
  skillExecutionIdByName: Map<string, string>
): CorroboratingCandidates {
  const exact = new Map<string, FindingAttribution[]>();
  const heuristic = new Map<string, HeuristicCorroboratingCandidate[]>();
  const ownAnchors = new Map<string, DedupeAnchor>();

  for (const observation of findingObservations) {
    if (observation.outcome !== 'deduped' || !observation.dedupe.existingFindingId) continue;

    const skillExecutionId = resolveObservationSkillExecutionId(observation.skillExecutionId, observation.skill, skillExecutionIdByName);
    const attribution: FindingAttribution = {
      skillExecutionId,
      skillName: observation.skill ?? '',
      role: 'corroborating',
      matchType: observation.dedupe.matchType,
    };
    const anchor: DedupeAnchor = {
      existingCommentId: observation.dedupe.existingCommentId,
      existingThreadId: observation.dedupe.existingThreadId,
    };
    ownAnchors.set(`${skillExecutionId}:${observation.finding.id}`, anchor);

    if (observation.dedupe.existingSkillExecutionId) {
      const key = exactCorroborationKey(observation.dedupe.existingSkillExecutionId, observation.dedupe.existingFindingId);
      const list = exact.get(key) ?? [];
      list.push(attribution);
      exact.set(key, list);
    } else {
      const key = observation.dedupe.existingFindingId;
      const list = heuristic.get(key) ?? [];
      list.push({ attribution, targetSkills: observation.dedupe.existingSkills, anchor, claimed: false });
      heuristic.set(key, list);
    }
  }

  return { exact, heuristic, ownAnchors };
}

/**
 * Bare finding ids collide across skills, so a heuristic dedupe match
 * against `existingFindingId` can name a finding shared by unrelated skills.
 * Narrow to the actual winner using the skill(s) recorded on the dedupe
 * match, and only trust that narrowing when the target skill name maps to
 * exactly one execution in the run - with more than one, there's no way to
 * tell which execution a name-only match actually corroborates.
 *
 * Exact candidates skip all of that: the compound key they were looked up by
 * already proves which execution they target, independent of `targetSkillName`.
 *
 * A bare `existingFindingId` can also collide across two genuinely different
 * *prior*-run comments, so heuristic candidates are further narrowed against
 * the target's own dedupe anchor (`anchorsConflict`) whenever both sides
 * have one - otherwise two unrelated old findings that happen to share a
 * model-assigned id could corroborate each other. This narrowing is only as
 * good as the target's own anchor: a target posted fresh this run (never
 * itself deduped) has none, so a heuristic candidate can't be ruled out for
 * it on anchor grounds alone - accepted the same way an empty
 * `existingSkills` is (see the "empty skills array" tests below), since
 * requiring an anchor here would also block that legitimate case.
 *
 * Either pass can also dedupe more than one of its own findings against the
 * same winner in one run, or (for a finding that dedupes against its own
 * prior posting - continuity, not corroboration) recenter onto its own
 * skillExecutionId - `seenSkillExecutionIds` collapses/excludes both across
 * both passes.
 */
function resolveCorroboratingAttributions(
  candidates: CorroboratingCandidates,
  findingId: string,
  ownFindingId: string,
  targetSkillName: string,
  targetSkillExecutionId: string,
  skillExecutionIdByName: Map<string, string>
): FindingAttribution[] {
  const seenSkillExecutionIds = new Set<string>([targetSkillExecutionId]);
  const attributions: FindingAttribution[] = [];

  const exactMatches = candidates.exact.get(exactCorroborationKey(targetSkillExecutionId, findingId)) ?? [];
  for (const attribution of exactMatches) {
    if (seenSkillExecutionIds.has(attribution.skillExecutionId)) continue;
    seenSkillExecutionIds.add(attribution.skillExecutionId);
    attributions.push(attribution);
  }

  if (skillExecutionIdByName.get(targetSkillName) === targetSkillExecutionId) {
    const ownAnchor = candidates.ownAnchors.get(`${targetSkillExecutionId}:${ownFindingId}`);
    const heuristicMatches = candidates.heuristic.get(findingId) ?? [];
    for (const candidate of heuristicMatches) {
      if (candidate.claimed) continue;
      if (candidate.targetSkills && candidate.targetSkills.length > 0 && !candidate.targetSkills.includes(targetSkillName)) {
        continue;
      }
      if (ownAnchor && anchorsConflict(ownAnchor, candidate.anchor)) continue;
      if (seenSkillExecutionIds.has(candidate.attribution.skillExecutionId)) continue;
      seenSkillExecutionIds.add(candidate.attribution.skillExecutionId);
      candidate.claimed = true;
      attributions.push(candidate.attribution);
    }
  }

  return attributions;
}

/**
 * Report-time dedupe against an existing comment sets `reportedId` on a
 * finding (see `syncReportedIds` in poster.ts) without ever changing its
 * `id`. The analyze-phase payload being patched here was built before that
 * happened, so newly-discovered `reportedId`s need folding in. `id` alone
 * is only unique within one skill execution, not across the whole run, so
 * the map is keyed by `${skillExecutionId}:${id}` - the same composite key
 * `buildReportModeResultsV2` already uses for this exact reason.
 */
function buildReportedIdMap(
  findingObservations: FindingObservation[],
  skillExecutionIdByName: Map<string, string>
): Map<string, string> {
  const reportedIds = new Map<string, string>();
  for (const observation of findingObservations) {
    if (observation.outcome !== 'deduped' || !observation.finding.reportedId) continue;
    const skillExecutionId = resolveObservationSkillExecutionId(observation.skillExecutionId, observation.skill, skillExecutionIdByName);
    reportedIds.set(`${skillExecutionId}:${observation.finding.id}`, observation.finding.reportedId);
  }
  return reportedIds;
}

interface GithubCommentRef {
  githubCommentId?: number;
  githubCommentUrl?: string;
}

/**
 * `githubCommentId`/`githubCommentUrl` only exist on the `posted` variant of
 * a `FindingObservation` (they come back from the GitHub API at posting
 * time, unlike `reportedId` which `syncReportedIds` writes onto the `Finding`
 * object itself) - so, unlike reportedId, this has no live-object fallback
 * and must always be looked up from `findingObservations`.
 */
function buildGithubCommentMap(
  findingObservations: FindingObservation[],
  skillExecutionIdByName: Map<string, string>
): Map<string, GithubCommentRef> {
  const commentsById = new Map<string, GithubCommentRef>();
  for (const observation of findingObservations) {
    if (observation.outcome !== 'posted') continue;
    if (!observation.githubCommentId && !observation.githubCommentUrl) continue;
    const skillExecutionId = resolveObservationSkillExecutionId(observation.skillExecutionId, observation.skill, skillExecutionIdByName);
    commentsById.set(`${skillExecutionId}:${observation.finding.id}`, {
      githubCommentId: observation.githubCommentId,
      githubCommentUrl: observation.githubCommentUrl,
    });
  }
  return commentsById;
}

interface SkillExecutionUsageUpdate {
  usage: SkillExecution['usage'];
  auxiliaryUsage: SkillExecution['auxiliaryUsage'];
  checkRunUrl: SkillExecution['checkRunUrl'];
  checkRunId: SkillExecution['checkRunId'];
  reviewEvent: SkillExecution['reviewEvent'];
  checkConclusion: SkillExecution['checkConclusion'];
}

/**
 * Report-phase posting (dedupe/consolidate) merges auxiliary usage onto
 * `result.report` (see poster.ts) after the analyze-phase payload being
 * patched here was already built. Unlike verification/merge provenance,
 * this isn't data that only `findingProcessingEvents` can reconstruct -
 * `results` carries the live, already-mutated report at patch time, the
 * same source v1's write reads from, so it can be folded in directly. The
 * same is true of `checkRunUrl`/`checkRunId`: report mode creates its skill
 * checks as already-completed check runs (`createCompletedSkillChecksForReport`)
 * only after the analyze-phase payload was built, so `result` is the only
 * place this run's real check identity exists. `reviewEvent`/`checkConclusion`
 * follow the same rule: dedup can shrink the finding set posted (or posting
 * can fail/get blocked) after the analyze-phase payload was built, so only
 * `result` at patch time reflects what was actually posted and concluded.
 */
function buildSkillExecutionUsageUpdates(
  results: TriggerResult[],
  triggerById: Map<string, ResolvedTrigger>,
  skillExecutionIdByName: Map<string, string>
): Map<string, SkillExecutionUsageUpdate> {
  const updates = new Map<string, SkillExecutionUsageUpdate>();

  for (const result of results) {
    const report = result.report;
    if (!report) continue;

    const trigger = result.triggerId ? triggerById.get(result.triggerId) : undefined;
    const skillExecutionId = resolveReportSkillExecutionId(trigger?.skillExecutionId, report.skill, skillExecutionIdByName);
    const auxiliaryUsageEntries = toAuxiliaryUsageEntries(report.auxiliaryUsage, report.auxiliaryUsageAttribution);

    updates.set(skillExecutionId, {
      usage: report.usage,
      auxiliaryUsage: auxiliaryUsageEntries.length > 0 ? auxiliaryUsageEntries : undefined,
      checkRunUrl: result.checkRunUrl,
      checkRunId: result.checkRunId,
      reviewEvent: result.renderResult?.review?.event,
      checkConclusion: determineConclusion(
        filterFindings(report.findings, undefined, result.minConfidence),
        result.failOn,
        result.failCheck
      ),
    });
  }

  return updates;
}

/**
 * Rebuild only the observation-derived parts of a v2 findings payload:
 * `findingObservations`, `summary.byOutcome`, any newly-discovered
 * `reportedId` (continuity with an existing comment), any newly-discovered
 * cross-skill corroboration on `findings[].reportedBy`, and each skill
 * execution's `usage`/`auxiliaryUsage` (report-phase posting costs). Used
 * by report mode to fold real posting outcomes into an analyze-phase
 * payload without touching `skillExecutions[].findingIds`/verification/
 * merge provenance or `discardedFindings`, which can only be reconstructed
 * from the original `findingProcessingEvents` and would otherwise be
 * silently wiped by a full rebuild from replayed results. Corroboration is
 * additive-only (existing `reportedBy` entries are never removed) since it
 * can only be discovered once posting/dedup runs, which analyze mode never
 * does.
 */
export function patchFindingsOutputV2Observations(
  base: WardenFindingsV2,
  results: TriggerResult[],
  matchedTriggers: ResolvedTrigger[],
  findingObservations: FindingObservation[]
): WardenFindingsV2 {
  const triggerById = new Map(matchedTriggers.map((t) => [t.id, t]));
  const skillExecutionIdByName = skillExecutionIdByNameFrom(matchedTriggers);
  const { observations, byOutcome } = buildFindingObservationsV2(findingObservations, skillExecutionIdByName);
  const corroboratingById = buildCorroboratingAttributions(findingObservations, skillExecutionIdByName);
  const reportedIdMap = buildReportedIdMap(findingObservations, skillExecutionIdByName);
  const githubCommentMap = buildGithubCommentMap(findingObservations, skillExecutionIdByName);
  const usageUpdates = buildSkillExecutionUsageUpdates(results, triggerById, skillExecutionIdByName);

  const skillExecutions = base.skillExecutions.map((execution) => {
    const update = usageUpdates.get(execution.skillExecutionId);
    if (!update) return execution;
    return {
      ...execution,
      usage: update.usage,
      auxiliaryUsage: update.auxiliaryUsage,
      checkRunUrl: update.checkRunUrl,
      checkRunId: update.checkRunId,
      reviewEvent: update.reviewEvent,
      checkConclusion: update.checkConclusion,
    };
  });

  const findings = base.findings.map((original) => {
    const originSkillExecutionId = original.reportedBy.find((r) => r.role === 'primary')?.skillExecutionId ?? '';
    const reportedId = reportedIdMap.get(`${originSkillExecutionId}:${original.id}`);
    const githubComment = githubCommentMap.get(`${originSkillExecutionId}:${original.id}`);
    const finding = {
      ...original,
      ...(reportedId && { reportedId }),
      ...(githubComment && {
        githubCommentId: githubComment.githubCommentId,
        githubCommentUrl: githubComment.githubCommentUrl,
      }),
    };

    const primarySkillName = finding.reportedBy.find((r) => r.role === 'primary')?.skillName ?? '';
    const newCorroborators = resolveCorroboratingAttributions(
      corroboratingById,
      displayFindingId(finding),
      finding.id,
      primarySkillName,
      originSkillExecutionId,
      skillExecutionIdByName
    );
    if (newCorroborators.length === 0) return finding;

    const existingSkillExecutionIds = new Set(finding.reportedBy.map((r) => r.skillExecutionId));
    const additions = newCorroborators.filter((c) => !existingSkillExecutionIds.has(c.skillExecutionId));
    if (additions.length === 0) return finding;

    return { ...finding, reportedBy: [...finding.reportedBy, ...additions] };
  });

  // Every field is named explicitly (no `...base` spread) so a new field
  // added to WardenFindingsV2 fails to compile here until this function
  // decides whether report mode owns it or must pass it through from base.
  const patched: WardenFindingsV2 = {
    schemaVersion: base.schemaVersion,
    runId: base.runId,
    skillExecutions,
    discardedFindings: base.discardedFindings,
    findings,
    findingObservations: observations,
    summary: {
      totalFindings: base.summary.totalFindings,
      totalSkillExecutions: base.summary.totalSkillExecutions,
      bySeverity: base.summary.bySeverity,
      byOutcome,
    },
  };
  return WardenFindingsSchemaV2.parse(patched);
}

export interface BuildFindingsOutputV2Options {
  runId: string;
}

interface ReducedFindingProcessingEvents {
  verificationById: Map<string, VerificationStage>;
  mergeById: Map<string, MergeStage>;
  discarded: DiscardedFinding[];
}

/** Finding IDs are model-assigned per skill run and can collide across skills, so the returned maps must not survive past this execution's findings. */
function reduceFindingProcessingEvents(
  events: TriggerResult['findingProcessingEvents'],
  skillExecutionId: string
): ReducedFindingProcessingEvents {
  const verificationById = new Map<string, VerificationStage>();
  const mergeById = new Map<string, MergeStage>();
  const discarded: DiscardedFinding[] = [];

  for (const event of events ?? []) {
    if (event.stage === 'verification' && event.action === 'revised' && event.replacement) {
      verificationById.set(event.replacement.id, {
        outcome: 'revised',
        model: event.model,
        runtime: event.runtime,
        evidence: event.replacement.verification,
        before: {
          title: event.finding.title,
          description: event.finding.description,
          severity: event.finding.severity,
          confidence: event.finding.confidence,
        },
      });
    } else if (event.stage === 'verification' && event.action === 'kept') {
      verificationById.set(event.finding.id, {
        outcome: 'kept',
        model: event.model,
        runtime: event.runtime,
      });
    } else if (event.stage === 'verification' && event.action === 'rejected') {
      discarded.push({
        originSkillExecutionId: skillExecutionId,
        stage: 'verification_rejected',
        severity: event.finding.severity,
        title: event.finding.title,
        location: event.finding.location,
        model: event.model,
        reason: event.reason,
      });
    } else if (event.stage === 'merge' && event.action === 'merged') {
      const survivorId = event.replacement?.id;
      discarded.push({
        originSkillExecutionId: skillExecutionId,
        stage: 'merge_absorbed',
        severity: event.finding.severity,
        title: event.finding.title,
        location: event.finding.location,
        model: event.model,
        reason: event.reason,
        survivorFindingId: survivorId,
      });
      if (survivorId) {
        const entry = mergeById.get(survivorId) ?? { model: event.model, runtime: event.runtime, absorbedFindingIds: [] };
        entry.absorbedFindingIds.push(event.finding.id);
        mergeById.set(survivorId, entry);
      }
    }
  }

  return { verificationById, mergeById, discarded };
}

/** Build the schema-v2 findings output from scratch: skill executions, findings, corroboration, and discarded findings from this run's results. */
export function buildFindingsOutputV2(
  results: TriggerResult[],
  matchedTriggers: ResolvedTrigger[],
  findingObservations: FindingObservation[],
  options: BuildFindingsOutputV2Options
): WardenFindingsV2 {
  const triggerById = new Map(matchedTriggers.map((t) => [t.id, t]));
  const skillExecutionIdByName = skillExecutionIdByNameFrom(matchedTriggers);
  const corroboratingById = buildCorroboratingAttributions(findingObservations, skillExecutionIdByName);
  const githubCommentMap = buildGithubCommentMap(findingObservations, skillExecutionIdByName);

  const skillExecutions: SkillExecution[] = [];
  const findings: ExportedFindingV2[] = [];
  const discardedFindings: DiscardedFinding[] = [];

  for (const result of results) {
    const report = result.report;
    if (!report) continue;

    const trigger = result.triggerId ? triggerById.get(result.triggerId) : undefined;
    const skillExecutionId = resolveReportSkillExecutionId(trigger?.skillExecutionId, report.skill, skillExecutionIdByName);

    const { verificationById, mergeById, discarded } = reduceFindingProcessingEvents(
      result.findingProcessingEvents,
      skillExecutionId
    );
    discardedFindings.push(...discarded);

    const auxiliaryUsageEntries = toAuxiliaryUsageEntries(report.auxiliaryUsage, report.auxiliaryUsageAttribution);

    skillExecutions.push({
      skillExecutionId,
      skillName: report.skill,
      triggerId: result.triggerId,
      triggerName: result.triggerName,
      model: report.model,
      models: report.models,
      runtime: report.runtime,
      auxiliaryModel: trigger?.auxiliaryModel,
      synthesisModel: trigger?.synthesisModel,
      summary: report.summary,
      durationMs: report.durationMs,
      usage: report.usage,
      auxiliaryUsage: auxiliaryUsageEntries.length > 0 ? auxiliaryUsageEntries : undefined,
      findingsBySeverity: severityBreakdown(report.findings),
      findingIds: report.findings.map((f) => f.id),
      failedHunks: report.failedHunks,
      failedExtractions: report.failedExtractions,
      error: report.error,
      verifierRejections: report.verifierRejections,
      checkRunUrl: result.checkRunUrl,
      checkRunId: result.checkRunId,
      reviewEvent: result.renderResult?.review?.event,
      checkConclusion: determineConclusion(
        filterFindings(report.findings, undefined, result.minConfidence),
        result.failOn,
        result.failCheck
      ),
      issueNumber: result.issueNumber,
      issueUrl: result.issueUrl,
    });

    for (const finding of report.findings) {
      const githubComment = githubCommentMap.get(`${skillExecutionId}:${finding.id}`);
      findings.push({
        id: finding.id,
        reportedId: finding.reportedId,
        contentHash: generateContentHash(finding.title, finding.description),
        severity: finding.severity,
        confidence: finding.confidence,
        title: finding.title,
        description: finding.description,
        verification: finding.verification,
        location: finding.location,
        additionalLocations: finding.additionalLocations,
        sourceSnippet: finding.sourceSnippet,
        reportedBy: [
          { skillExecutionId, skillName: report.skill, role: 'primary' },
          ...resolveCorroboratingAttributions(
            corroboratingById,
            displayFindingId(finding),
            finding.id,
            report.skill,
            skillExecutionId,
            skillExecutionIdByName
          ),
        ],
        provenance: {
          originSkillExecutionId: skillExecutionId,
          originModel: report.model,
          verification: verificationById.get(finding.id),
          merge: mergeById.get(finding.id),
        },
        githubCommentId: githubComment?.githubCommentId,
        githubCommentUrl: githubComment?.githubCommentUrl,
      });
    }
  }

  const { observations, byOutcome } = buildFindingObservationsV2(findingObservations, skillExecutionIdByName);

  return WardenFindingsSchemaV2.parse({
    schemaVersion: '2',
    runId: options.runId,
    skillExecutions,
    findings,
    discardedFindings: discardedFindings.length > 0 ? discardedFindings : undefined,
    findingObservations: observations,
    summary: {
      totalFindings: findings.length,
      totalSkillExecutions: skillExecutions.length,
      bySeverity: severityBreakdown(findings),
      byOutcome,
    },
  });
}

export function toFindingFromV2(finding: ExportedFindingV2): Finding {
  return {
    id: finding.id,
    reportedId: finding.reportedId,
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
 * Rebuild the `SkillReport[]` a v2 artifact pair describes, independent of any
 * currently-configured triggers. Used for CLI replay (`warden runs show`),
 * where the goal is "show me what this run produced," not
 * `buildReportModeResultsV2`'s "should I re-post this against current config."
 */
export function reconstructSkillReportsFromV2(findingsOutput: WardenFindingsV2): SkillReport[] {
  const findingsByExecutionScopedId = new Map(
    findingsOutput.findings.map((finding) => [`${finding.provenance.originSkillExecutionId}:${finding.id}`, finding])
  );

  return findingsOutput.skillExecutions.map((execution) => {
    const findings = execution.findingIds.flatMap((id) => {
      const finding = findingsByExecutionScopedId.get(`${execution.skillExecutionId}:${id}`);
      return finding ? [toFindingFromV2(finding)] : [];
    });

    const { usage: auxiliaryUsage, attribution: auxiliaryUsageAttribution } = fromAuxiliaryUsageEntries(
      execution.auxiliaryUsage
    );

    return {
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
      models: execution.models,
      runtime: execution.runtime,
    };
  });
}
