import { describe, expect, it } from 'vitest';
import type { EventContext, Finding, SkillReport } from '../../types/index.js';
import type { ResolvedTrigger } from '../../config/loader.js';
import type { TriggerResult } from '../triggers/executor.js';
import type { FindingObservation } from './outcomes.js';
import {
  buildFindingsOutputV2,
  buildMetadataOutputV2,
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
});
