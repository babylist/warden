import { z } from 'zod';
import {
  ConfidenceSchema,
  ConfidenceThresholdSchema,
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
  Severity,
  SeverityThreshold,
} from '../../types/index.js';
import type { ResolvedTrigger } from '../../config/loader.js';
import { matchPullRequestState } from '../../triggers/matcher.js';
import type { TriggerResult } from '../triggers/executor.js';
import { buildConfiguredSkillsList, serializeTriggerError } from './output.js';
import { generateContentHash } from '../../output/dedup.js';
import { getVersion } from '../../utils/version.js';
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
    skippedReason: z.enum(['max_findings', 'duplicate_in_batch', 'no_inline_location']),
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
}

export function buildMetadataOutputV2(
  context: EventContext,
  resolvedTriggers: ResolvedTrigger[],
  matchedTriggers: ResolvedTrigger[],
  results: TriggerResult[],
  options: BuildMetadataOutputV2Options
): WardenMetadata {
  const matchedIds = new Set(matchedTriggers.map((t) => t.id));
  const skippedTriggers = resolvedTriggers
    .filter((t) => !matchedIds.has(t.id))
    .map((t) => ({
      skillName: t.skill,
      triggerId: t.id,
      triggerName: t.name,
      reason: deriveSkippedReason(t, context),
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
        minConfidence: primary.minConfidence,
        model: primary.model,
        auxiliaryModel: primary.auxiliaryModel,
        synthesisModel: primary.synthesisModel,
        runtime: primary.runtime,
        verifyFindings: primary.verifyFindings,
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

function buildFindingObservationsV2(
  findingObservations: FindingObservation[],
  matchedTriggers: ResolvedTrigger[]
): { observations: FindingObservationV2[]; byOutcome: SummaryV2['byOutcome'] } {
  const skillExecutionIdByName = skillExecutionIdByNameFrom(matchedTriggers);

  const observations: FindingObservationV2[] = findingObservations.map((observation) => {
    const skillExecutionId = observation.skillExecutionId ?? skillExecutionIdByName.get(observation.skill ?? '') ?? '';
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
        return { outcome: 'posted', origin, finding: findingSnapshot };
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

interface CorroboratingCandidate {
  attribution: FindingAttribution;
  targetSkills?: string[];
}

function buildCorroboratingAttributions(
  findingObservations: FindingObservation[],
  matchedTriggers: ResolvedTrigger[]
): Map<string, CorroboratingCandidate[]> {
  const skillExecutionIdByName = skillExecutionIdByNameFrom(matchedTriggers);
  const corroboratingById = new Map<string, CorroboratingCandidate[]>();
  for (const observation of findingObservations) {
    if (observation.outcome === 'deduped' && observation.dedupe.existingFindingId) {
      const winnerId = observation.dedupe.existingFindingId;
      const list = corroboratingById.get(winnerId) ?? [];
      list.push({
        attribution: {
          skillExecutionId: observation.skillExecutionId ?? skillExecutionIdByName.get(observation.skill ?? '') ?? '',
          skillName: observation.skill ?? '',
          role: 'corroborating',
          matchType: observation.dedupe.matchType,
        },
        targetSkills: observation.dedupe.existingSkills,
      });
      corroboratingById.set(winnerId, list);
    }
  }
  return corroboratingById;
}

/**
 * Bare finding ids collide across skills, so a dedupe match against
 * `existingFindingId` can name a finding shared by unrelated skills. Narrow
 * to the actual winner using the skill(s) recorded on the dedupe match.
 * A skill can also dedupe more than one of its own findings against the
 * same winner in one run, so also collapse repeat matches from the same
 * skillExecutionId before returning.
 *
 * A posted comment's dedupe match only records the winner's skill *name*
 * (parsed from the comment footer), not its skillExecutionId. When that name
 * has more than one execution in the current run, there's no way to tell
 * which execution the comment actually corroborates, so skip rather than
 * attach the same corroboration to every same-named execution.
 *
 * A finding that dedupes against its own prior posting (continuity, not
 * corroboration) recenters `existingFindingId` onto itself, so its own
 * skillExecutionId can appear among the candidates here — exclude it rather
 * than have a finding list itself as a corroborator of itself.
 */
function resolveCorroboratingAttributions(
  candidates: CorroboratingCandidate[],
  targetSkillName: string,
  targetSkillExecutionId: string,
  skillExecutionIdByName: Map<string, string>
): FindingAttribution[] {
  if (skillExecutionIdByName.get(targetSkillName) !== targetSkillExecutionId) {
    return [];
  }

  const seenSkillExecutionIds = new Set<string>([targetSkillExecutionId]);
  const attributions: FindingAttribution[] = [];
  for (const candidate of candidates) {
    if (candidate.targetSkills && candidate.targetSkills.length > 0 && !candidate.targetSkills.includes(targetSkillName)) {
      continue;
    }
    if (seenSkillExecutionIds.has(candidate.attribution.skillExecutionId)) continue;
    seenSkillExecutionIds.add(candidate.attribution.skillExecutionId);
    attributions.push(candidate.attribution);
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
  matchedTriggers: ResolvedTrigger[]
): Map<string, string> {
  const skillExecutionIdByName = skillExecutionIdByNameFrom(matchedTriggers);
  const reportedIds = new Map<string, string>();
  for (const observation of findingObservations) {
    if (observation.outcome !== 'deduped' || !observation.finding.reportedId) continue;
    const skillExecutionId = observation.skillExecutionId ?? skillExecutionIdByName.get(observation.skill ?? '') ?? '';
    reportedIds.set(`${skillExecutionId}:${observation.finding.id}`, observation.finding.reportedId);
  }
  return reportedIds;
}

/**
 * Rebuild only the observation-derived parts of a v2 findings payload:
 * `findingObservations`, `summary.byOutcome`, any newly-discovered
 * `reportedId` (continuity with an existing comment), and any
 * newly-discovered cross-skill corroboration on `findings[].reportedBy`.
 * Used by report mode to fold real posting outcomes into an analyze-phase
 * payload without touching `skillExecutions`/`discardedFindings`/
 * `provenance`, which can only be reconstructed from the original
 * `findingProcessingEvents` and would otherwise be silently wiped by a full
 * rebuild from replayed results. Corroboration is additive-only (existing
 * `reportedBy` entries are never removed) since it can only be discovered
 * once posting/dedup runs, which analyze mode never does.
 */
export function patchFindingsOutputV2Observations(
  base: WardenFindingsV2,
  matchedTriggers: ResolvedTrigger[],
  findingObservations: FindingObservation[]
): WardenFindingsV2 {
  const { observations, byOutcome } = buildFindingObservationsV2(findingObservations, matchedTriggers);
  const corroboratingById = buildCorroboratingAttributions(findingObservations, matchedTriggers);
  const reportedIdMap = buildReportedIdMap(findingObservations, matchedTriggers);
  const skillExecutionIdByName = skillExecutionIdByNameFrom(matchedTriggers);

  const findings = base.findings.map((original) => {
    const originSkillExecutionId = original.reportedBy.find((r) => r.role === 'primary')?.skillExecutionId ?? '';
    const reportedId = reportedIdMap.get(`${originSkillExecutionId}:${original.id}`);
    const finding = reportedId ? { ...original, reportedId } : original;

    const primarySkillName = finding.reportedBy.find((r) => r.role === 'primary')?.skillName ?? '';
    const newCorroborators = resolveCorroboratingAttributions(
      corroboratingById.get(finding.reportedId ?? finding.id) ?? [],
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
    skillExecutions: base.skillExecutions,
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

export function buildFindingsOutputV2(
  results: TriggerResult[],
  matchedTriggers: ResolvedTrigger[],
  findingObservations: FindingObservation[],
  options: BuildFindingsOutputV2Options
): WardenFindingsV2 {
  const triggerById = new Map(matchedTriggers.map((t) => [t.id, t]));
  const skillExecutionIdByName = skillExecutionIdByNameFrom(matchedTriggers);
  const corroboratingById = buildCorroboratingAttributions(findingObservations, matchedTriggers);

  const skillExecutions: SkillExecution[] = [];
  const findings: ExportedFindingV2[] = [];
  const discardedFindings: DiscardedFinding[] = [];

  for (const result of results) {
    const report = result.report;
    if (!report) continue;

    const trigger = result.triggerId ? triggerById.get(result.triggerId) : undefined;
    const skillExecutionId = trigger?.skillExecutionId ?? skillExecutionIdByName.get(report.skill) ?? report.skill;

    // Finding IDs are model-assigned per skill run and can collide across
    // skills, so these maps must not survive past this execution's findings.
    const verificationById = new Map<string, VerificationStage>();
    const mergeById = new Map<string, MergeStage>();

    for (const event of result.findingProcessingEvents ?? []) {
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
        discardedFindings.push({
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
        discardedFindings.push({
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

    const auxiliaryUsageEntries = toAuxiliaryUsageEntries(report.auxiliaryUsage, report.auxiliaryUsageAttribution);

    skillExecutions.push({
      skillExecutionId,
      skillName: report.skill,
      triggerId: result.triggerId,
      triggerName: result.triggerName,
      model: report.model,
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
    });

    for (const finding of report.findings) {
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
            corroboratingById.get(finding.reportedId ?? finding.id) ?? [],
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
      });
    }
  }

  const { observations, byOutcome } = buildFindingObservationsV2(findingObservations, matchedTriggers);

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
