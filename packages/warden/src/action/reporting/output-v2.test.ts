import { describe, expect, it } from 'vitest';
import type { EventContext, Finding, SkillReport } from '../../types/index.js';
import type { ResolvedTrigger } from '../../config/loader.js';
import type { TriggerResult } from '../triggers/executor.js';
import type { FindingObservation } from './outcomes.js';
import {
  buildFindingsOutputV2,
  buildMetadataOutputV2,
  fromAuxiliaryUsageEntries,
  patchFindingsOutputV2Observations,
  WardenFindingsSchemaV2,
  WardenMetadataSchema,
} from './output-v2.js';

function createContext(overrides: Partial<EventContext> = {}): EventContext {
  return {
    eventType: 'pull_request',
    action: 'opened',
    repository: {
      owner: 'getsentry',
      name: 'warden',
      fullName: 'getsentry/warden',
      defaultBranch: 'main',
    },
    pullRequest: {
      number: 362,
      title: 'Test PR',
      body: '',
      author: 'user-123',
      baseBranch: 'main',
      headBranch: 'feature',
      headSha: 'abc123',
      baseSha: 'def456',
      files: [],
    },
    repoPath: '/repo',
    ...overrides,
  };
}

function createTrigger(overrides: Partial<ResolvedTrigger> = {}): ResolvedTrigger {
  return {
    id: 'trigger-id',
    skillExecutionId: 'exec-1',
    name: 'test-trigger',
    skill: 'code-review',
    type: 'pull_request',
    actions: ['opened'],
    filters: {},
    ...overrides,
  };
}

function createFinding(overrides: Partial<Finding> = {}): Finding {
  return {
    id: 'WRD-001',
    severity: 'high',
    confidence: 'high',
    title: 'Finding title',
    description: 'Finding description',
    location: { path: 'src/index.ts', startLine: 1 },
    ...overrides,
  };
}

function createReport(overrides: Partial<SkillReport> = {}): SkillReport {
  return {
    skill: 'code-review',
    summary: 'Found 1 issue',
    findings: [createFinding()],
    model: 'claude-sonnet-5',
    ...overrides,
  };
}

function createResult(overrides: Partial<TriggerResult> = {}): TriggerResult {
  return {
    triggerId: 'trigger-id',
    triggerName: 'test-trigger',
    skillName: 'code-review',
    skillExecutionId: 'exec-1',
    report: createReport(),
    ...overrides,
  };
}

describe('buildMetadataOutputV2', () => {
  it('builds a schema-valid metadata payload', () => {
    const matched = createTrigger();
    const skipped = createTrigger({
      id: 'skipped-id',
      skillExecutionId: 'exec-2',
      name: 'skipped-trigger',
      skill: 'security-review',
      actions: ['synchronize'],
    });

    const output = buildMetadataOutputV2(
      createContext(),
      [matched, skipped],
      [matched],
      [createResult()],
      { runId: '123', generatedAt: '2026-01-01T00:00:00.000Z' }
    );

    expect(WardenMetadataSchema.parse(output)).toEqual(output);
    expect(output.harness.name).toBe('warden');
    expect(output.skippedTriggers).toEqual([
      { skillName: 'security-review', triggerId: 'skipped-id', triggerName: 'skipped-trigger', reason: 'no_event_match' },
    ]);
  });

  it('reports label_mismatch, not draft_state, when a labeled event adds a non-matching label', () => {
    const matched = createTrigger();
    const skipped = createTrigger({
      id: 'skipped-id',
      skillExecutionId: 'exec-2',
      name: 'skipped-trigger',
      skill: 'security-review',
      actions: ['labeled'],
      labels: ['deploy-ready'],
    });

    const context = createContext({
      action: 'labeled',
      label: 'wont-fix',
      pullRequest: {
        number: 4821,
        title: 'Test PR',
        body: '',
        author: 'octocat',
        baseBranch: 'main',
        headBranch: 'feature',
        headSha: 'abc123',
        baseSha: 'def456',
        files: [],
        labels: ['deploy-ready', 'wont-fix'],
      },
    });

    const output = buildMetadataOutputV2(
      context,
      [matched, skipped],
      [matched],
      [createResult()],
      { runId: '123', generatedAt: '2026-01-01T00:00:00.000Z' }
    );

    expect(output.skippedTriggers).toEqual([
      { skillName: 'security-review', triggerId: 'skipped-id', triggerName: 'skipped-trigger', reason: 'label_mismatch' },
    ]);
  });

  it('reports path_filter when the event and state match but no changed file satisfies the path filter', () => {
    const matched = createTrigger();
    const skipped = createTrigger({
      id: 'skipped-id',
      skillExecutionId: 'exec-2',
      name: 'skipped-trigger',
      skill: 'security-review',
      filters: { paths: ['src/**'] },
    });

    const output = buildMetadataOutputV2(
      createContext(),
      [matched, skipped],
      [matched],
      [createResult()],
      { runId: '123', generatedAt: '2026-01-01T00:00:00.000Z' }
    );

    expect(output.skippedTriggers).toEqual([
      { skillName: 'security-review', triggerId: 'skipped-id', triggerName: 'skipped-trigger', reason: 'path_filter' },
    ]);
  });

  it('reports no_changes when a schedule trigger fires with no changed files to scan', () => {
    const matched = createTrigger();
    const skipped = createTrigger({
      id: 'skipped-id',
      skillExecutionId: 'exec-2',
      name: 'skipped-trigger',
      skill: 'security-review',
      type: 'schedule',
    });

    const output = buildMetadataOutputV2(
      createContext({ eventType: 'schedule' }),
      [matched, skipped],
      [matched],
      [createResult()],
      { runId: '123', generatedAt: '2026-01-01T00:00:00.000Z' }
    );

    expect(output.skippedTriggers).toEqual([
      { skillName: 'security-review', triggerId: 'skipped-id', triggerName: 'skipped-trigger', reason: 'no_changes' },
    ]);
  });

  it('falls back to the action-level failOn/reportOn when the primary trigger has no override', () => {
    const matched = createTrigger({ failOn: undefined, reportOn: undefined });

    const output = buildMetadataOutputV2(
      createContext(),
      [matched],
      [matched],
      [createResult()],
      { runId: '123', generatedAt: '2026-01-01T00:00:00.000Z', failOn: 'high', reportOn: 'medium' }
    );

    expect(output.resolvedDefaults).toEqual(
      expect.objectContaining({ failOn: 'high', reportOn: 'medium' })
    );
  });
});

describe('buildFindingsOutputV2', () => {
  it('builds a schema-valid findings payload with primary attribution', () => {
    const trigger = createTrigger();
    const output = buildFindingsOutputV2([createResult()], [trigger], [], { runId: '123' });

    expect(WardenFindingsSchemaV2.parse(output)).toEqual(output);
    expect(output.findings).toHaveLength(1);
    expect(output.findings[0]?.reportedBy).toEqual([
      { skillExecutionId: 'exec-1', skillName: 'code-review', role: 'primary' },
    ]);
    expect(output.skillExecutions[0]?.findingsBySeverity).toEqual({ high: 1, medium: 0, low: 0 });
  });

  it('records verifier revisions in per-finding provenance', () => {
    const trigger = createTrigger();
    const finding = createFinding({ id: 'WRD-002', severity: 'medium' });
    const result = createResult({
      report: createReport({ findings: [finding] }),
      findingProcessingEvents: [
        {
          stage: 'verification',
          action: 'revised',
          finding: createFinding({ id: 'WRD-002', severity: 'high', title: 'Original title' }),
          replacement: finding,
          reason: 'narrower scope',
          model: 'claude-haiku-4-5',
        },
      ],
    });

    const output = buildFindingsOutputV2([result], [trigger], [], { runId: '123' });

    expect(output.findings[0]?.provenance.verification).toEqual({
      outcome: 'revised',
      model: 'claude-haiku-4-5',
      runtime: undefined,
      evidence: undefined,
      before: {
        title: 'Original title',
        description: 'Finding description',
        severity: 'high',
        confidence: 'high',
      },
    });
  });

  it('does not leak verification provenance across skills when finding ids collide', () => {
    const firstTrigger = createTrigger({ id: 'trigger-1', skillExecutionId: 'exec-1', skill: 'code-review' });
    const secondTrigger = createTrigger({
      id: 'trigger-2',
      skillExecutionId: 'exec-2',
      name: 'security-review-trigger',
      skill: 'security-review',
    });

    const revisedFinding = createFinding({ id: 'WRD-001', severity: 'medium' });
    const firstResult = createResult({
      triggerId: 'trigger-1',
      report: createReport({ skill: 'code-review', findings: [revisedFinding] }),
      findingProcessingEvents: [
        {
          stage: 'verification',
          action: 'revised',
          finding: createFinding({ id: 'WRD-001', severity: 'high', title: 'Original title' }),
          replacement: revisedFinding,
          reason: 'narrower scope',
          model: 'claude-haiku-4-5',
        },
      ],
    });

    const unrelatedFinding = createFinding({ id: 'WRD-001', title: 'Unrelated finding, same id' });
    const secondResult = createResult({
      triggerId: 'trigger-2',
      report: createReport({ skill: 'security-review', findings: [unrelatedFinding] }),
    });

    const output = buildFindingsOutputV2(
      [firstResult, secondResult],
      [firstTrigger, secondTrigger],
      [],
      { runId: '123' }
    );

    const fromSecondSkill = output.findings.find((f) => f.provenance.originSkillExecutionId === 'exec-2');
    expect(fromSecondSkill?.provenance.verification).toBeUndefined();
  });

  it('does not attach corroboration to an unrelated finding that happens to share an id', () => {
    const firstTrigger = createTrigger({ id: 'trigger-1', skillExecutionId: 'exec-1', skill: 'code-review' });
    const secondTrigger = createTrigger({
      id: 'trigger-2',
      skillExecutionId: 'exec-2',
      name: 'unrelated-skill-trigger',
      skill: 'unrelated-skill',
    });
    const thirdTrigger = createTrigger({
      id: 'trigger-3',
      skillExecutionId: 'exec-3',
      name: 'security-review-trigger',
      skill: 'security-review',
    });

    const firstResult = createResult({
      triggerId: 'trigger-1',
      report: createReport({ skill: 'code-review', findings: [createFinding({ id: 'WRD-001' })] }),
    });
    const secondResult = createResult({
      triggerId: 'trigger-2',
      report: createReport({ skill: 'unrelated-skill', findings: [createFinding({ id: 'WRD-001' })] }),
    });

    // The dedupe match names its skill(s) explicitly, so this corroboration
    // targets code-review's WRD-001, not unrelated-skill's same-id finding.
    const observations: FindingObservation[] = [
      {
        outcome: 'deduped',
        finding: createFinding({ id: 'WRD-004' }),
        skill: 'security-review',
        dedupe: {
          source: 'warden',
          matchType: 'hash',
          existingFindingId: 'WRD-001',
          existingSkills: ['code-review'],
        },
      },
    ];

    const output = buildFindingsOutputV2(
      [firstResult, secondResult],
      [firstTrigger, secondTrigger, thirdTrigger],
      observations,
      { runId: '123' }
    );

    const fromCodeReview = output.findings.find((f) => f.provenance.originSkillExecutionId === 'exec-1');
    const fromUnrelated = output.findings.find((f) => f.provenance.originSkillExecutionId === 'exec-2');

    expect(fromCodeReview?.reportedBy).toEqual([
      { skillExecutionId: 'exec-1', skillName: 'code-review', role: 'primary' },
      { skillExecutionId: 'exec-3', skillName: 'security-review', role: 'corroborating', matchType: 'hash' },
    ]);
    expect(fromUnrelated?.reportedBy).toEqual([
      { skillExecutionId: 'exec-2', skillName: 'unrelated-skill', role: 'primary' },
    ]);
  });

  it('does not attach corroboration to either finding when the same skill ran twice and their ids collide', () => {
    const firstExecution = createTrigger({ id: 'trigger-1', skillExecutionId: 'exec-1', skill: 'code-review' });
    const secondExecution = createTrigger({
      id: 'trigger-2',
      skillExecutionId: 'exec-2',
      name: 'code-review-strict',
      skill: 'code-review',
    });
    const corroboratingTrigger = createTrigger({
      id: 'trigger-3',
      skillExecutionId: 'exec-3',
      name: 'security-review-trigger',
      skill: 'security-review',
    });

    const firstResult = createResult({
      triggerId: 'trigger-1',
      report: createReport({ skill: 'code-review', findings: [createFinding({ id: 'WRD-001' })] }),
    });
    const secondResult = createResult({
      triggerId: 'trigger-2',
      report: createReport({ skill: 'code-review', findings: [createFinding({ id: 'WRD-001' })] }),
    });

    const observations: FindingObservation[] = [
      {
        outcome: 'deduped',
        finding: createFinding({ id: 'WRD-004' }),
        skill: 'security-review',
        dedupe: {
          source: 'warden',
          matchType: 'hash',
          existingFindingId: 'WRD-001',
          existingSkills: ['code-review'],
        },
      },
    ];

    const output = buildFindingsOutputV2(
      [firstResult, secondResult],
      [firstExecution, secondExecution, corroboratingTrigger],
      observations,
      { runId: '123' }
    );

    const fromFirstExecution = output.findings.find((f) => f.provenance.originSkillExecutionId === 'exec-1');
    const fromSecondExecution = output.findings.find((f) => f.provenance.originSkillExecutionId === 'exec-2');

    expect(fromFirstExecution?.reportedBy).toEqual([
      { skillExecutionId: 'exec-1', skillName: 'code-review', role: 'primary' },
    ]);
    expect(fromSecondExecution?.reportedBy).toEqual([
      { skillExecutionId: 'exec-2', skillName: 'code-review', role: 'primary' },
    ]);
  });

  it('attaches an exact corroboration even when the target skill has multiple executions', () => {
    const firstExecution = createTrigger({ id: 'trigger-1', skillExecutionId: 'exec-1', skill: 'code-review' });
    const secondExecution = createTrigger({
      id: 'trigger-2',
      skillExecutionId: 'exec-2',
      name: 'code-review-strict',
      skill: 'code-review',
    });
    const corroboratingTrigger = createTrigger({
      id: 'trigger-3',
      skillExecutionId: 'exec-3',
      name: 'security-review-trigger',
      skill: 'security-review',
    });

    const firstResult = createResult({
      triggerId: 'trigger-1',
      report: createReport({ skill: 'code-review', findings: [createFinding({ id: 'WRD-001' })] }),
    });
    const secondResult = createResult({
      triggerId: 'trigger-2',
      report: createReport({ skill: 'code-review', findings: [createFinding({ id: 'WRD-002' })] }),
    });

    const observations: FindingObservation[] = [
      {
        outcome: 'deduped',
        finding: createFinding({ id: 'WRD-004' }),
        skill: 'security-review',
        dedupe: {
          source: 'warden',
          matchType: 'hash',
          existingFindingId: 'WRD-001',
          existingSkillExecutionId: 'exec-1',
          existingSkills: ['code-review'],
        },
      },
    ];

    const output = buildFindingsOutputV2(
      [firstResult, secondResult],
      [firstExecution, secondExecution, corroboratingTrigger],
      observations,
      { runId: '123' }
    );

    const fromFirstExecution = output.findings.find((f) => f.provenance.originSkillExecutionId === 'exec-1');
    const fromSecondExecution = output.findings.find((f) => f.provenance.originSkillExecutionId === 'exec-2');

    expect(fromFirstExecution?.reportedBy).toEqual([
      { skillExecutionId: 'exec-1', skillName: 'code-review', role: 'primary' },
      { skillExecutionId: 'exec-3', skillName: 'security-review', role: 'corroborating', matchType: 'hash' },
    ]);
    expect(fromSecondExecution?.reportedBy).toEqual([
      { skillExecutionId: 'exec-2', skillName: 'code-review', role: 'primary' },
    ]);
  });

  it('attaches corroboration when the existing comment has an empty skills array', () => {
    const firstTrigger = createTrigger({ id: 'trigger-1', skillExecutionId: 'exec-1', skill: 'code-review' });
    const secondTrigger = createTrigger({
      id: 'trigger-2',
      skillExecutionId: 'exec-2',
      name: 'security-review-trigger',
      skill: 'security-review',
    });

    const result = createResult({
      triggerId: 'trigger-1',
      report: createReport({ skill: 'code-review', findings: [createFinding({ id: 'WRD-001' })] }),
    });

    const observations: FindingObservation[] = [
      {
        outcome: 'deduped',
        finding: createFinding({ id: 'WRD-002' }),
        skill: 'security-review',
        dedupe: {
          source: 'warden',
          matchType: 'hash',
          existingFindingId: 'WRD-001',
          existingSkills: [],
        },
      },
    ];

    const output = buildFindingsOutputV2([result], [firstTrigger, secondTrigger], observations, { runId: '123' });

    expect(output.findings[0]?.reportedBy).toEqual([
      { skillExecutionId: 'exec-1', skillName: 'code-review', role: 'primary' },
      { skillExecutionId: 'exec-2', skillName: 'security-review', role: 'corroborating', matchType: 'hash' },
    ]);
  });

  it('does not attach corroboration to an unrelated finding sharing an id when the matched comment has an empty skills array', () => {
    const firstTrigger = createTrigger({ id: 'trigger-1', skillExecutionId: 'exec-1', skill: 'code-review' });
    const secondTrigger = createTrigger({
      id: 'trigger-2',
      skillExecutionId: 'exec-2',
      name: 'unrelated-skill-trigger',
      skill: 'unrelated-skill',
    });
    const thirdTrigger = createTrigger({
      id: 'trigger-3',
      skillExecutionId: 'exec-3',
      name: 'security-review-trigger',
      skill: 'security-review',
    });

    const firstResult = createResult({
      triggerId: 'trigger-1',
      report: createReport({ skill: 'code-review', findings: [createFinding({ id: 'WRD-001' })] }),
    });
    const secondResult = createResult({
      triggerId: 'trigger-2',
      report: createReport({ skill: 'unrelated-skill', findings: [createFinding({ id: 'WRD-001' })] }),
    });

    const observations: FindingObservation[] = [
      {
        outcome: 'deduped',
        finding: createFinding({ id: 'WRD-004' }),
        skill: 'security-review',
        dedupe: {
          source: 'warden',
          matchType: 'hash',
          existingFindingId: 'WRD-001',
          existingSkillExecutionId: 'exec-1',
          existingSkills: [],
        },
      },
    ];

    const output = buildFindingsOutputV2(
      [firstResult, secondResult],
      [firstTrigger, secondTrigger, thirdTrigger],
      observations,
      { runId: '123' }
    );

    const fromCodeReview = output.findings.find((f) => f.provenance.originSkillExecutionId === 'exec-1');
    const fromUnrelated = output.findings.find((f) => f.provenance.originSkillExecutionId === 'exec-2');

    expect(fromCodeReview?.reportedBy).toEqual([
      { skillExecutionId: 'exec-1', skillName: 'code-review', role: 'primary' },
      { skillExecutionId: 'exec-3', skillName: 'security-review', role: 'corroborating', matchType: 'hash' },
    ]);
    expect(fromUnrelated?.reportedBy).toEqual([
      { skillExecutionId: 'exec-2', skillName: 'unrelated-skill', role: 'primary' },
    ]);
  });

  it('does not list a finding as its own corroborator when it dedupes against its own prior posting', () => {
    const trigger = createTrigger({ id: 'trigger-1', skillExecutionId: 'exec-1', skill: 'code-review' });
    const finding = createFinding({ id: 'WRD-001', reportedId: 'EXISTING-001' });

    const result = createResult({
      triggerId: 'trigger-1',
      report: createReport({ skill: 'code-review', findings: [finding] }),
    });

    // Single-run mode: this finding's own continuity dedupe (matching its own
    // prior posting) is recorded as a 'deduped' observation whose
    // existingFindingId is the finding's own reportedId.
    const observations: FindingObservation[] = [
      {
        outcome: 'deduped',
        finding,
        skill: 'code-review',
        skillExecutionId: 'exec-1',
        dedupe: {
          source: 'warden',
          matchType: 'hash',
          existingFindingId: 'EXISTING-001',
          existingSkills: ['code-review'],
        },
      },
    ];

    const output = buildFindingsOutputV2([result], [trigger], observations, { runId: '123' });

    expect(output.findings[0]?.reportedBy).toEqual([
      { skillExecutionId: 'exec-1', skillName: 'code-review', role: 'primary' },
    ]);
  });

  it('records verifier rejections in discardedFindings', () => {
    const trigger = createTrigger();
    const result = createResult({
      findingProcessingEvents: [
        {
          stage: 'verification',
          action: 'rejected',
          finding: createFinding({ id: 'WRD-003' }),
          reason: 'mitigated upstream',
          model: 'claude-haiku-4-5',
        },
      ],
    });

    const output = buildFindingsOutputV2([result], [trigger], [], { runId: '123' });

    expect(output.discardedFindings).toEqual([
      {
        originSkillExecutionId: 'exec-1',
        stage: 'verification_rejected',
        severity: 'high',
        title: 'Finding title',
        location: { path: 'src/index.ts', startLine: 1 },
        model: 'claude-haiku-4-5',
        reason: 'mitigated upstream',
      },
    ]);
  });

  it('adds corroborating attribution when another skill matches an existing finding', () => {
    const primaryTrigger = createTrigger();
    const corroboratingTrigger = createTrigger({
      id: 'trigger-2',
      skillExecutionId: 'exec-2',
      name: 'security-review-trigger',
      skill: 'security-review',
    });

    const observations: FindingObservation[] = [
      {
        outcome: 'deduped',
        finding: createFinding({ id: 'WRD-004' }),
        skill: 'security-review',
        dedupe: {
          source: 'warden',
          matchType: 'hash',
          existingFindingId: 'WRD-001',
        },
      },
    ];

    const output = buildFindingsOutputV2(
      [createResult()],
      [primaryTrigger, corroboratingTrigger],
      observations,
      { runId: '123' }
    );

    expect(output.findings[0]?.reportedBy).toEqual([
      { skillExecutionId: 'exec-1', skillName: 'code-review', role: 'primary' },
      { skillExecutionId: 'exec-2', skillName: 'security-review', role: 'corroborating', matchType: 'hash' },
    ]);
    expect(output.summary.byOutcome.deduped).toBe(1);
  });

  it('collapses repeat corroboration from the same skill execution into one reportedBy entry', () => {
    const primaryTrigger = createTrigger();
    const corroboratingTrigger = createTrigger({
      id: 'trigger-2',
      skillExecutionId: 'exec-2',
      name: 'security-review-trigger',
      skill: 'security-review',
    });

    const observations: FindingObservation[] = [
      {
        outcome: 'deduped',
        finding: createFinding({ id: 'WRD-004' }),
        skill: 'security-review',
        dedupe: { source: 'warden', matchType: 'hash', existingFindingId: 'WRD-001' },
      },
      {
        outcome: 'deduped',
        finding: createFinding({ id: 'WRD-005' }),
        skill: 'security-review',
        dedupe: { source: 'warden', matchType: 'hash', existingFindingId: 'WRD-001' },
      },
    ];

    const output = buildFindingsOutputV2(
      [createResult()],
      [primaryTrigger, corroboratingTrigger],
      observations,
      { runId: '123' }
    );

    expect(output.findings[0]?.reportedBy).toEqual([
      { skillExecutionId: 'exec-1', skillName: 'code-review', role: 'primary' },
      { skillExecutionId: 'exec-2', skillName: 'security-review', role: 'corroborating', matchType: 'hash' },
    ]);
  });

  it('attributes an observation to its own execution when two triggers share a skill name', () => {
    const firstExecution = createTrigger({ id: 'trigger-1', skillExecutionId: 'exec-1', skill: 'code-review' });
    const secondExecution = createTrigger({
      id: 'trigger-2',
      skillExecutionId: 'exec-2',
      name: 'code-review-strict',
      skill: 'code-review',
    });

    const observations: FindingObservation[] = [
      {
        outcome: 'skipped',
        finding: createFinding({ id: 'WRD-501' }),
        skill: 'code-review',
        skillExecutionId: 'exec-2',
        skippedReason: 'max_findings',
      },
    ];

    const output = buildFindingsOutputV2(
      [createResult()],
      [firstExecution, secondExecution],
      observations,
      { runId: '123' }
    );

    expect(output.findingObservations[0]?.origin).toEqual({
      skillExecutionId: 'exec-2',
      skillName: 'code-review',
    });
  });
});

describe('fromAuxiliaryUsageEntries', () => {
  it('round-trips through buildFindingsOutputV2 back into the record-keyed shape SkillReport expects', () => {
    const trigger = createTrigger();
    const result = createResult({
      report: createReport({
        auxiliaryUsage: { dedup: { inputTokens: 10, outputTokens: 5, costUSD: 0.002 } },
        auxiliaryUsageAttribution: { dedup: { model: 'claude-haiku-4-5', runtime: 'pi' } },
      }),
    });

    const output = buildFindingsOutputV2([result], [trigger], [], { runId: '123' });
    const { usage, attribution } = fromAuxiliaryUsageEntries(output.skillExecutions[0]?.auxiliaryUsage);

    expect(usage).toEqual({ dedup: { inputTokens: 10, outputTokens: 5, costUSD: 0.002 } });
    expect(attribution).toEqual({ dedup: { model: 'claude-haiku-4-5', runtime: 'pi' } });
  });

  it('returns undefined for both when there are no entries', () => {
    expect(fromAuxiliaryUsageEntries(undefined)).toEqual({ usage: undefined, attribution: undefined });
    expect(fromAuxiliaryUsageEntries([])).toEqual({ usage: undefined, attribution: undefined });
  });
});

describe('patchFindingsOutputV2Observations', () => {
  it('is a no-op when patched with no report-phase observations (build/patch parity)', () => {
    const trigger = createTrigger();
    const finding = createFinding({ id: 'WRD-002', severity: 'medium' });
    const result = createResult({
      report: createReport({ findings: [finding] }),
      findingProcessingEvents: [
        {
          stage: 'verification',
          action: 'revised',
          finding: createFinding({ id: 'WRD-002', severity: 'high', title: 'Original title' }),
          replacement: finding,
          reason: 'narrower scope',
          model: 'claude-haiku-4-5',
        },
      ],
    });

    const analyzePhaseOutput = buildFindingsOutputV2([result], [trigger], [], { runId: '123' });
    const patched = patchFindingsOutputV2Observations(analyzePhaseOutput, [result], [trigger], []);

    expect(patched).toEqual(analyzePhaseOutput);
  });

  it('backfills skillExecutions usage/auxiliaryUsage from live report-phase posting costs', () => {
    const trigger = createTrigger();
    const finding = createFinding({ id: 'WRD-401' });

    const analyzePhaseOutput = buildFindingsOutputV2(
      [createResult({ report: createReport({ findings: [finding] }) })],
      [trigger],
      [],
      { runId: '123' }
    );
    expect(analyzePhaseOutput.skillExecutions[0]?.auxiliaryUsage).toBeUndefined();

    // Posting (dedupe/consolidate) merges auxiliary usage onto the live report
    // after the analyze-phase payload above was already built (see poster.ts).
    const postedResult = createResult({
      report: createReport({
        findings: [finding],
        auxiliaryUsage: { dedupe: { inputTokens: 100, outputTokens: 20, costUSD: 0.01 } },
        auxiliaryUsageAttribution: { dedupe: { model: 'claude-haiku-4-5' } },
      }),
    });

    const patched = patchFindingsOutputV2Observations(analyzePhaseOutput, [postedResult], [trigger], []);

    expect(patched.skillExecutions[0]?.auxiliaryUsage).toEqual([
      {
        agent: 'dedupe',
        model: 'claude-haiku-4-5',
        usage: { inputTokens: 100, outputTokens: 20, costUSD: 0.01 },
      },
    ]);
  });

  it('preserves skillExecutions/findings/discardedFindings/provenance while updating only observations and byOutcome', () => {
    const trigger = createTrigger();
    const finding = createFinding({ id: 'WRD-002', severity: 'medium' });
    const result = createResult({
      report: createReport({ findings: [finding] }),
      findingProcessingEvents: [
        {
          stage: 'verification',
          action: 'revised',
          finding: createFinding({ id: 'WRD-002', severity: 'high', title: 'Original title' }),
          replacement: finding,
          reason: 'narrower scope',
          model: 'claude-haiku-4-5',
        },
        {
          stage: 'verification',
          action: 'rejected',
          finding: createFinding({ id: 'WRD-003' }),
          reason: 'mitigated upstream',
          model: 'claude-haiku-4-5',
        },
      ],
    });

    const analyzePhaseOutput = buildFindingsOutputV2([result], [trigger], [], { runId: '123' });

    const reportPhaseObservations: FindingObservation[] = [
      { outcome: 'posted', finding, skill: 'code-review' },
    ];
    const patched = patchFindingsOutputV2Observations(analyzePhaseOutput, [result], [trigger], reportPhaseObservations);

    // The parts that can only be reconstructed from findingProcessingEvents
    // (unavailable during report-mode replay) must survive unchanged.
    expect(patched.skillExecutions).toEqual(analyzePhaseOutput.skillExecutions);
    expect(patched.findings).toEqual(analyzePhaseOutput.findings);
    expect(patched.discardedFindings).toEqual(analyzePhaseOutput.discardedFindings);
    expect(patched.findings[0]?.provenance.verification?.outcome).toBe('revised');

    // Only the observation-derived parts reflect the new (report-phase) data.
    expect(patched.findingObservations).toEqual([
      expect.objectContaining({ outcome: 'posted', finding: expect.objectContaining({ id: 'WRD-002' }) }),
    ]);
    expect(patched.summary.byOutcome).toEqual({ posted: 1, deduped: 0, skipped: 0, resolved: 0, failed: 0 });
    expect(patched.summary.totalFindings).toBe(analyzePhaseOutput.summary.totalFindings);
  });

  it('adds corroborating attribution discovered at report/post time without touching provenance', () => {
    const primaryTrigger = createTrigger();
    const corroboratingTrigger = createTrigger({
      id: 'trigger-2',
      skillExecutionId: 'exec-2',
      name: 'security-review-trigger',
      skill: 'security-review',
    });
    const finding = createFinding({ id: 'WRD-101' });

    const analyzePhaseOutput = buildFindingsOutputV2(
      [createResult({ report: createReport({ findings: [finding] }) })],
      [primaryTrigger],
      [],
      { runId: '123' }
    );
    expect(analyzePhaseOutput.findings[0]?.reportedBy).toEqual([
      { skillExecutionId: 'exec-1', skillName: 'code-review', role: 'primary' },
    ]);

    // Cross-skill dedup only happens during posting, so this observation only
    // becomes known during the report phase, after analyze-phase output exists.
    const reportPhaseObservations: FindingObservation[] = [
      {
        outcome: 'deduped',
        finding: createFinding({ id: 'WRD-201' }),
        skill: 'security-review',
        dedupe: { source: 'warden', matchType: 'semantic', existingFindingId: 'WRD-101' },
      },
    ];

    const patched = patchFindingsOutputV2Observations(
      analyzePhaseOutput, [], [primaryTrigger, corroboratingTrigger], reportPhaseObservations
    );

    expect(patched.findings[0]?.reportedBy).toEqual([
      { skillExecutionId: 'exec-1', skillName: 'code-review', role: 'primary' },
      { skillExecutionId: 'exec-2', skillName: 'security-review', role: 'corroborating', matchType: 'semantic' },
    ]);
    expect(patched.findings[0]?.provenance).toEqual(analyzePhaseOutput.findings[0]?.provenance);
  });

  it('adds reportedId without ever renaming findings[].id or skillExecutions[].findingIds', () => {
    const trigger = createTrigger();
    const finding = createFinding({ id: 'WRD-301' });

    const analyzePhaseOutput = buildFindingsOutputV2(
      [createResult({ report: createReport({ findings: [finding] }) })],
      [trigger],
      [],
      { runId: '123' }
    );
    expect(analyzePhaseOutput.findings[0]?.id).toBe('WRD-301');
    expect(analyzePhaseOutput.skillExecutions[0]?.findingIds).toEqual(['WRD-301']);

    // Report-time dedupe against an existing GitHub comment sets `reportedId`
    // on the finding (the analyze-phase payload being patched here still has
    // no reportedId, since dedupe hadn't happened yet) - `id` itself is
    // stable and never needs renaming.
    const reportPhaseObservations: FindingObservation[] = [
      {
        outcome: 'deduped',
        finding: { ...finding, reportedId: 'WRZ-XPL' },
        skill: 'code-review',
        dedupe: { source: 'warden', matchType: 'hash', existingFindingId: 'WRZ-XPL' },
      },
    ];

    const patched = patchFindingsOutputV2Observations(analyzePhaseOutput, [], [trigger], reportPhaseObservations);

    expect(patched.findings[0]?.id).toBe('WRD-301');
    expect(patched.findings[0]?.reportedId).toBe('WRZ-XPL');
    expect(patched.skillExecutions[0]?.findingIds).toEqual(['WRD-301']);
  });

  it('never lets a report-time dedupe in one skill rename an unrelated finding that shares its id in another skill', () => {
    const triggerA = createTrigger({ id: 'trigger-a', skillExecutionId: 'exec-a', skill: 'skill-a' });
    const triggerB = createTrigger({ id: 'trigger-b', skillExecutionId: 'exec-b', skill: 'skill-b' });
    const findingA = createFinding({ id: 'SHARED-ID' });
    const findingB = createFinding({ id: 'SHARED-ID' });

    const analyzePhaseOutput = buildFindingsOutputV2(
      [
        createResult({ report: createReport({ skill: 'skill-a', findings: [findingA] }), triggerId: 'trigger-a', skillExecutionId: 'exec-a' }),
        createResult({ report: createReport({ skill: 'skill-b', findings: [findingB] }), triggerId: 'trigger-b', skillExecutionId: 'exec-b' }),
      ],
      [triggerA, triggerB],
      [],
      { runId: '123' }
    );
    expect(analyzePhaseOutput.findings).toHaveLength(2);
    expect(analyzePhaseOutput.findings.every((f) => f.id === 'SHARED-ID')).toBe(true);

    // Only skill A's finding gets deduped this report step.
    const reportPhaseObservations: FindingObservation[] = [
      {
        outcome: 'deduped',
        finding: { ...findingA, reportedId: 'WRZ-XPL' },
        skill: 'skill-a',
        skillExecutionId: 'exec-a',
        dedupe: { source: 'warden', matchType: 'hash', existingFindingId: 'WRZ-XPL' },
      },
    ];

    const patched = patchFindingsOutputV2Observations(analyzePhaseOutput, [], [triggerA, triggerB], reportPhaseObservations);

    const patchedA = patched.findings.find((f) => f.reportedBy.some((r) => r.skillName === 'skill-a'));
    const patchedB = patched.findings.find((f) => f.reportedBy.some((r) => r.skillName === 'skill-b'));
    expect(patchedA?.reportedId).toBe('WRZ-XPL');
    expect(patchedB?.reportedId).toBeUndefined();
  });
});

describe('buildFindingsOutputV2 kept verification provenance', () => {
  it('records a kept verdict in provenance.verification', () => {
    const trigger = createTrigger();
    const finding = createFinding({ id: 'WRD-401' });
    const result = createResult({
      report: createReport({ findings: [finding] }),
      findingProcessingEvents: [
        {
          stage: 'verification',
          action: 'kept',
          finding,
          reason: 'still real after tracing',
          model: 'claude-haiku-4-5',
        },
      ],
    });

    const output = buildFindingsOutputV2([result], [trigger], [], { runId: '123' });

    expect(output.findings[0]?.provenance.verification).toEqual({
      outcome: 'kept',
      model: 'claude-haiku-4-5',
      runtime: undefined,
    });
  });
});
