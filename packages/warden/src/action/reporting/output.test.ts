import { describe, expect, it } from 'vitest';
import type { EventContext, Finding, SkillReport } from '../../types/index.js';
import { buildConfiguredSkillsList, buildFindingsOutput, FindingsOutputSchema } from './output.js';

describe('findings output schema', () => {
  it('builds a schema-valid public findings payload', () => {
    const output = buildFindingsOutput([createReport()], createContext(), [
      {
        outcome: 'posted',
        finding: createFinding(),
        skill: 'test-skill',
      },
    ], {
      timestamp: '2026-01-01T00:00:00.000Z',
      runId: '123',
    });

    expect(FindingsOutputSchema.parse(output)).toEqual(output);
    expect(output.summary).toEqual({
      totalFindings: 1,
      findingsBySeverity: { high: 1, medium: 0, low: 0 },
      totalSkills: 1,
    });
  });

  it('includes trigger run results for split report mode', () => {
    const report = createReport();
    const output = buildFindingsOutput([report], createContext(), [], {
      timestamp: '2026-01-01T00:00:00.000Z',
      runId: '123',
      triggerResults: [
        {
          triggerName: 'test-trigger',
          skillName: 'test-skill',
          report,
        },
        {
          triggerName: 'failed-trigger',
          skillName: 'failed-skill',
          error: new Error('Token expired'),
        },
      ],
    });

    expect(FindingsOutputSchema.parse(output)).toEqual(output);
    expect(output.triggerResults).toEqual([
      {
        triggerName: 'test-trigger',
        skillName: 'test-skill',
        status: 'success',
        report,
      },
      {
        triggerName: 'failed-trigger',
        skillName: 'failed-skill',
        status: 'error',
        error: {
          name: 'Error',
          message: 'Token expired',
        },
      },
    ]);
  });

  it('serializes trigger results with the configured skill identity', () => {
    const report = createReport({ skill: 'frontmatter-skill' });
    const output = buildFindingsOutput([report], createContext(), [], {
      timestamp: '2026-01-01T00:00:00.000Z',
      runId: '123',
      triggerResults: [
        {
          triggerName: 'test-trigger',
          skillName: 'config-skill',
          report,
        },
      ],
    });

    expect(output.triggerResults?.[0]).toMatchObject({
      triggerName: 'test-trigger',
      skillName: 'config-skill',
      status: 'success',
      report,
    });
  });

  it('projects trigger reports to fields needed for split-mode replay', () => {
    const report = createReport({
      metadata: { internal: true },
      runtime: 'pi',
      failedHunks: 1,
      failedExtractions: 2,
      error: { code: 'sdk_error', message: 'partial failure' },
      verifierRejections: { count: 1, reasons: ['not reproducible'] },
    });
    const output = buildFindingsOutput([report], createContext(), [], {
      timestamp: '2026-01-01T00:00:00.000Z',
      runId: '123',
      triggerResults: [
        {
          triggerName: 'test-trigger',
          skillName: 'test-skill',
          report,
        },
      ],
    });

    expect(output.triggerResults?.[0]).toMatchObject({
      status: 'success',
      report: {
        skill: 'test-skill',
        summary: 'Found 1 issue',
        failedHunks: 1,
        failedExtractions: 2,
        error: { code: 'sdk_error', message: 'partial failure' },
        verifierRejections: { count: 1, reasons: ['not reproducible'] },
      },
    });
    expect(output.triggerResults?.[0]).not.toHaveProperty('report.metadata');
    expect(output.triggerResults?.[0]).not.toHaveProperty('report.runtime');
  });

  it('requires status-specific trigger result data', () => {
    const output = buildFindingsOutput([createReport()], createContext(), [], {
      timestamp: '2026-01-01T00:00:00.000Z',
      runId: '123',
    });

    expect(() =>
      FindingsOutputSchema.parse({
        ...output,
        triggerResults: [
          {
            triggerName: 'test-trigger',
            skillName: 'test-skill',
            status: 'success',
          },
        ],
      })
    ).toThrow();

    expect(() =>
      FindingsOutputSchema.parse({
        ...output,
        triggerResults: [
          {
            triggerName: 'failed-trigger',
            skillName: 'test-skill',
            status: 'error',
          },
        ],
      })
    ).toThrow();
  });

  it('rejects outcome details that do not match the observation kind', () => {
    const output = buildFindingsOutput([createReport()], createContext(), [], {
      timestamp: '2026-01-01T00:00:00.000Z',
      runId: '123',
    });

    expect(() =>
      FindingsOutputSchema.parse({
        ...output,
        findingObservations: [
          {
            outcome: 'deduped',
            finding: createFinding(),
            skill: 'test-skill',
          },
        ],
      })
    ).toThrow();
  });

  it('includes verifierRejections when present', () => {
    const report = createReport({
      verifierRejections: { count: 1, reasons: ['not reproducible'] },
    });
    const output = buildFindingsOutput([report], createContext(), [], {
      timestamp: '2026-01-01T00:00:00.000Z',
      runId: '123',
    });

    expect(FindingsOutputSchema.parse(output)).toEqual(output);
    expect(output.skills[0]).toMatchObject({
      verifierRejections: { count: 1, reasons: ['not reproducible'] },
    });
  });

  it('omits verifierRejections when absent', () => {
    const output = buildFindingsOutput([createReport()], createContext(), [], {
      timestamp: '2026-01-01T00:00:00.000Z',
      runId: '123',
    });

    expect(output.skills[0]?.verifierRejections).toBeUndefined();
  });

  it('rejects sentinel dedupe comment IDs', () => {
    const output = buildFindingsOutput([createReport()], createContext(), [], {
      timestamp: '2026-01-01T00:00:00.000Z',
      runId: '123',
    });

    expect(() =>
      FindingsOutputSchema.parse({
        ...output,
        findingObservations: [
          {
            outcome: 'deduped',
            finding: createFinding(),
            skill: 'test-skill',
            dedupe: {
              source: 'warden',
              matchType: 'hash',
              existingFindingId: 'WRD-001',
              existingCommentId: -1,
            },
          },
        ],
      })
    ).toThrow();
  });

  it('includes skill reliability fields when present', () => {
    const report = createReport({
      failedHunks: 2,
      failedExtractions: 1,
      error: { code: 'sdk_error', message: 'boom' },
    });
    const output = buildFindingsOutput([report], createContext(), [], {
      timestamp: '2026-01-01T00:00:00.000Z',
      runId: '123',
    });

    expect(FindingsOutputSchema.parse(output)).toEqual(output);
    expect(output.skills[0]).toMatchObject({
      failedHunks: 2,
      failedExtractions: 1,
      error: { code: 'sdk_error', message: 'boom' },
    });
  });

  it('omits skill reliability fields when absent', () => {
    const output = buildFindingsOutput([createReport()], createContext(), [], {
      timestamp: '2026-01-01T00:00:00.000Z',
      runId: '123',
    });

    expect(output.skills[0]?.failedHunks).toBeUndefined();
    expect(output.skills[0]?.failedExtractions).toBeUndefined();
    expect(output.skills[0]?.error).toBeUndefined();

    const serialized = JSON.parse(JSON.stringify(output.skills[0]));
    expect('failedHunks' in serialized).toBe(false);
    expect('failedExtractions' in serialized).toBe(false);
    expect('error' in serialized).toBe(false);
  });

  it('includes the configured skills roster when provided', () => {
    const output = buildFindingsOutput([createReport()], createContext(), [], {
      timestamp: '2026-01-01T00:00:00.000Z',
      runId: '123',
      configuredSkills: [
        { name: 'test-skill', triggered: true },
        { name: 'idle-skill', triggered: false },
      ],
    });

    expect(FindingsOutputSchema.parse(output)).toEqual(output);
    expect(output.configuredSkills).toEqual([
      { name: 'test-skill', triggered: true },
      { name: 'idle-skill', triggered: false },
    ]);
  });

  it('omits the configured skills roster when not provided', () => {
    const output = buildFindingsOutput([createReport()], createContext(), [], {
      timestamp: '2026-01-01T00:00:00.000Z',
      runId: '123',
    });

    expect(output.configuredSkills).toBeUndefined();
  });
});

describe('buildConfiguredSkillsList', () => {
  it('marks matched skills as triggered and unmatched skills as not', () => {
    const result = buildConfiguredSkillsList({
      allTriggers: [{ name: 'matched-skill' }, { name: 'skipped-skill' }],
      matchedTriggers: [{ name: 'matched-skill' }],
    });

    expect(result).toEqual([
      { name: 'matched-skill', triggered: true },
      { name: 'skipped-skill', triggered: false },
    ]);
  });

  it('deduplicates multiple trigger blocks for the same skill', () => {
    const result = buildConfiguredSkillsList({
      allTriggers: [{ name: 'multi-trigger-skill' }, { name: 'multi-trigger-skill' }],
      matchedTriggers: [{ name: 'multi-trigger-skill' }],
    });

    expect(result).toEqual([{ name: 'multi-trigger-skill', triggered: true }]);
  });

  it('returns an empty list when nothing is configured', () => {
    expect(buildConfiguredSkillsList({ allTriggers: [], matchedTriggers: [] })).toEqual([]);
  });

  it('includes a skill whose only trigger is neither matched nor a PR-check skip', () => {
    const result = buildConfiguredSkillsList({
      allTriggers: [{ name: 'nightly-sweep' }],
      matchedTriggers: [],
    });

    expect(result).toEqual([{ name: 'nightly-sweep', triggered: false }]);
  });
});

function createFinding(): Finding {
  return {
    id: 'WRD-001',
    severity: 'high',
    confidence: 'high',
    title: 'Finding title',
    description: 'Finding description',
    location: { path: 'src/index.ts', startLine: 1 },
  };
}

function createReport(overrides: Partial<SkillReport> = {}): SkillReport {
  return {
    skill: 'test-skill',
    summary: 'Found 1 issue',
    findings: [createFinding()],
    ...overrides,
  };
}

function createContext(): EventContext {
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
    repoPath: '/tmp/warden',
  };
}
