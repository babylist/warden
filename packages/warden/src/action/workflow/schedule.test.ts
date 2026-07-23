import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { join } from 'node:path';
import { readFileSync, rmSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { Octokit } from '@octokit/rest';
import type { ActionInputs } from '../inputs.js';
import type { SkillReport, Finding, EventContext } from '../../types/index.js';
import { getMetadataOutputPath, getFindingsOutputPathV2, getFindingsOutputPath } from './base.js';

// -----------------------------------------------------------------------------
// Fixtures Directory
// -----------------------------------------------------------------------------

const __dirname = fileURLToPath(new URL('.', import.meta.url));
const SCHEDULE_FIXTURES = join(__dirname, '__fixtures__/schedule');
const SCHEDULE_BASE_ONLY_FIXTURES = join(__dirname, '__fixtures__/schedule-base-only');
const SCHEDULE_MULTI_FIXTURES = join(__dirname, '__fixtures__/schedule-multi');
const SCHEDULE_WITH_PR_SKILL_FIXTURES = join(__dirname, '__fixtures__/schedule-with-pr-skill');
const SCHEDULE_TITLE_FIXTURES = join(__dirname, '__fixtures__/schedule-title');
const NO_CONFIG_FIXTURES = join(__dirname, '__fixtures__/no-config');
const RUNTIME_CLAUDE_FIXTURES = join(__dirname, '__fixtures__/runtime-claude');
// Reuse the base fixtures dir (has only pull_request triggers, no schedule)
const PR_ONLY_FIXTURES = join(__dirname, '__fixtures__');

// -----------------------------------------------------------------------------
// Mocks - ONLY external boundaries
// -----------------------------------------------------------------------------

// Mock base utilities that call process.exit or need system access
vi.mock('./base.js', async () => {
  const actual: Record<string, unknown> = await vi.importActual('./base.js');
  const mockedSetFailed = vi.fn((msg: string): never => {
    throw new Error(`setFailed: ${msg}`);
  });
  return {
    ...actual,
    setFailed: mockedSetFailed,
    writeFindingsOutput: vi.fn(actual['writeFindingsOutput'] as (...args: unknown[]) => unknown),
    ensureClaudeAuth: vi.fn((inputs: ActionInputs): void => {
      if (inputs.anthropicApiKey || inputs.oauthToken) {
        return;
      }
      mockedSetFailed(
        'Authentication not found. Provide an API key via anthropic-api-key input, ' +
          'WARDEN_ANTHROPIC_API_KEY env var, or OAuth token via CLAUDE_CODE_OAUTH_TOKEN env var.'
      );
    }),
    findClaudeCodeExecutable: vi.fn(() => '/usr/local/bin/claude'),
    prepareRuntimeEnvironment: vi.fn((triggers: Iterable<{ runtime?: string }>, inputs: ActionInputs) => {
      const usesClaude = Array.from(triggers).some((trigger) => (trigger.runtime ?? 'pi') === 'claude');
      if (!usesClaude) {
        return Promise.resolve({});
      }
      if (!inputs.anthropicApiKey && !inputs.oauthToken) {
        mockedSetFailed(
          'Authentication not found. Provide an API key via anthropic-api-key input, ' +
            'WARDEN_ANTHROPIC_API_KEY env var, or OAuth token via CLAUDE_CODE_OAUTH_TOKEN env var.'
        );
      }
      return Promise.resolve({ pathToClaudeCodeExecutable: '/usr/local/bin/claude' });
    }),
    getDefaultBranchFromAPI: vi.fn(() => Promise.resolve('main')),
    // Override handleTriggerErrors to use the mocked setFailed
    handleTriggerErrors: (triggerErrors: string[], totalTriggers: number) => {
      if (triggerErrors.length === 0) return;
      if (triggerErrors.length === totalTriggers && totalTriggers > 0) {
        mockedSetFailed(`All ${totalTriggers} trigger(s) failed: ${triggerErrors.join('; ')}`);
      }
    },
  };
});

// Mock SDK runner — LLM calls
vi.mock('../../sdk/runner.js', () => ({
  runSkill: vi.fn(),
}));

// Mock schedule context builder — filesystem glob expansion
vi.mock('../../event/schedule-context.js', () => ({
  buildScheduleEventContext: vi.fn(),
}));

// Mock GitHub issue/PR creation
vi.mock('../../output/github-issues.js', () => ({
  createOrUpdateIssue: vi.fn(),
}));

// Mock skill loader — filesystem reads; keep clearSkillsCache real
vi.mock('../../skills/loader.js', async () => {
  const actual = await vi.importActual('../../skills/loader.js');
  return {
    ...actual,
    resolveSkillAsync: vi.fn(() =>
      Promise.resolve({
        name: 'test-skill',
        description: 'Test skill',
        prompt: 'Review code',
      })
    ),
  };
});

// Import after mocks
import { runSkill } from '../../sdk/runner.js';
import { buildScheduleEventContext } from '../../event/schedule-context.js';
import { createOrUpdateIssue } from '../../output/github-issues.js';
import { resolveSkillAsync } from '../../skills/loader.js';
import { setFailed, writeFindingsOutput } from './base.js';
import { runScheduleWorkflow } from './schedule.js';
import { clearSkillsCache } from '../../skills/loader.js';

// Type the mocks
const mockRunSkill = vi.mocked(runSkill);
const mockBuildContext = vi.mocked(buildScheduleEventContext);
const mockCreateOrUpdateIssue = vi.mocked(createOrUpdateIssue);
const mockResolveSkillAsync = vi.mocked(resolveSkillAsync);
const mockSetFailed = vi.mocked(setFailed);

// -----------------------------------------------------------------------------
// Mock Octokit Factory
// -----------------------------------------------------------------------------

function createMockOctokit(): Octokit {
  return {
    repos: {
      get: vi.fn(() => Promise.resolve({ data: { default_branch: 'main' } })),
    },
  } as unknown as Octokit;
}

// -----------------------------------------------------------------------------
// Test Fixtures
// -----------------------------------------------------------------------------

function createDefaultInputs(overrides: Partial<ActionInputs> = {}): ActionInputs {
  return {
    anthropicApiKey: 'test-api-key',
    oauthToken: '',
    githubToken: 'test-github-token',
    mode: 'run',
    configPath: 'warden.toml',
    maxFindings: 50,
    parallel: 2,
    outputSchemaVersion: '1',
    ...overrides,
  };
}

function createFinding(overrides: Partial<Finding> = {}): Finding {
  return {
    id: 'finding-1',
    severity: 'high',
    title: 'Test Finding',
    description: 'This is a test finding',
    location: { path: 'src/test.ts', startLine: 10 },
    ...overrides,
  };
}

function createSkillReport(overrides: Partial<SkillReport> = {}): SkillReport {
  return {
    skill: 'test-skill',
    summary: 'Test summary',
    findings: [],
    ...overrides,
  };
}

function createScheduleContext(
  overrides: Partial<EventContext> = {}
): EventContext {
  return {
    eventType: 'schedule',
    action: 'scheduled',
    repository: {
      owner: 'test-owner',
      name: 'test-repo',
      fullName: 'test-owner/test-repo',
      defaultBranch: 'main',
    },
    pullRequest: {
      number: 0,
      title: 'Scheduled Analysis',
      body: null,
      author: 'warden',
      baseBranch: 'main',
      headBranch: 'main',
      headSha: 'abc123',
      baseSha: 'abc123',
      files: [
        {
          filename: 'src/test.ts',
          status: 'modified',
          additions: 10,
          deletions: 5,
          patch: '@@ -1,5 +1,10 @@\n+console.log("test")',
        },
      ],
    },
    repoPath: '/tmp/test-repo',
    ...overrides,
  };
}

// -----------------------------------------------------------------------------
// Tests
// -----------------------------------------------------------------------------

describe('runScheduleWorkflow', () => {
  let mockOctokit: Octokit;
  let consoleLogSpy: ReturnType<typeof vi.spyOn>;
  let consoleErrorSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.resetAllMocks();
    clearSkillsCache();
    mockOctokit = createMockOctokit();

    // Environment setup
    process.env['GITHUB_REPOSITORY'] = 'test-owner/test-repo';
    process.env['GITHUB_SHA'] = 'abc123';

    // Default mock: context with files, no findings
    mockBuildContext.mockResolvedValue(createScheduleContext());
    mockRunSkill.mockResolvedValue(createSkillReport());
    mockCreateOrUpdateIssue.mockResolvedValue({
      issueNumber: 1,
      issueUrl: 'https://github.com/test-owner/test-repo/issues/1',
      created: true,
    });
    mockResolveSkillAsync.mockResolvedValue({
      name: 'test-skill',
      description: 'Test skill',
      prompt: 'Review code',
    });

    consoleLogSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
  });

  afterEach(() => {
    delete process.env['GITHUB_REPOSITORY'];
    delete process.env['GITHUB_SHA'];
    consoleLogSpy.mockRestore();
    consoleErrorSpy.mockRestore();
  });

  // ---------------------------------------------------------------------------
  // Configuration & Early Exit
  // ---------------------------------------------------------------------------

  describe('configuration and early exit', () => {
    it('exits cleanly when warden.toml is missing', async () => {
      await runScheduleWorkflow(mockOctokit, createDefaultInputs(), NO_CONFIG_FIXTURES);

      expect(mockRunSkill).not.toHaveBeenCalled();
      expect(mockCreateOrUpdateIssue).not.toHaveBeenCalled();
      expect(mockSetFailed).not.toHaveBeenCalled();
      expect(consoleLogSpy).toHaveBeenCalledWith(
        '::warning::No warden.toml found. Skipping analysis.'
      );
    });

    it('loads the base config when repo warden.toml is missing', async () => {
      mockRunSkill.mockResolvedValue(createSkillReport({ skill: 'org-skill' }));

      await runScheduleWorkflow(
        mockOctokit,
        createDefaultInputs({
          baseConfigPath: '.warden-org/warden.toml',
          baseSkillRoot: '.warden-org',
        }),
        SCHEDULE_BASE_ONLY_FIXTURES
      );

      expect(mockRunSkill).toHaveBeenCalledTimes(1);
      expect(mockResolveSkillAsync).toHaveBeenCalledWith(
        'org-skill',
        join(SCHEDULE_BASE_ONLY_FIXTURES, '.warden-org'),
        { remote: undefined }
      );
    });

    it('merges the base config with the repo config when both exist', async () => {
      mockRunSkill.mockResolvedValue(createSkillReport());

      await runScheduleWorkflow(
        mockOctokit,
        createDefaultInputs({
          baseConfigPath: '.warden-org/warden.toml',
          baseSkillRoot: '.warden-org',
        }),
        SCHEDULE_FIXTURES
      );

      expect(mockRunSkill).toHaveBeenCalledTimes(2);
      expect(mockResolveSkillAsync.mock.calls).toEqual([
        ['org-skill', join(SCHEDULE_FIXTURES, '.warden-org'), { remote: undefined }],
        ['test-skill', SCHEDULE_FIXTURES, { remote: undefined }],
      ]);
    });

    it('passes auxiliaryMaxRetries through resolved schedule triggers', async () => {
      mockRunSkill.mockResolvedValue(createSkillReport());
      mockBuildContext.mockResolvedValue(createScheduleContext());

      await runScheduleWorkflow(
        mockOctokit,
        createDefaultInputs({
          baseConfigPath: '.warden-org/warden.toml',
          baseSkillRoot: '.warden-org',
        }),
        SCHEDULE_FIXTURES
      );

      expect(mockRunSkill).toHaveBeenNthCalledWith(1,
        expect.anything(),
        expect.anything(),
        expect.objectContaining({ auxiliaryMaxRetries: 7 })
      );
      expect(mockRunSkill).toHaveBeenNthCalledWith(2,
        expect.anything(),
        expect.anything(),
        expect.objectContaining({ auxiliaryMaxRetries: 3 })
      );
    });

    it('passes synthesisModel through resolved schedule triggers', async () => {
      mockRunSkill.mockResolvedValue(createSkillReport());
      mockBuildContext.mockResolvedValue(createScheduleContext());

      await runScheduleWorkflow(
        mockOctokit,
        createDefaultInputs({
          baseConfigPath: '.warden-org/warden.toml',
          baseSkillRoot: '.warden-org',
        }),
        SCHEDULE_FIXTURES
      );

      expect(mockRunSkill).toHaveBeenNthCalledWith(1,
        expect.anything(),
        expect.anything(),
        expect.objectContaining({ synthesisModel: 'anthropic/org-synth-model' })
      );
      expect(mockRunSkill).toHaveBeenNthCalledWith(2,
        expect.anything(),
        expect.anything(),
        expect.objectContaining({ synthesisModel: 'anthropic/repo-synth-model' })
      );
    });

    it('fails when an explicit base config is missing', async () => {
      await expect(
        runScheduleWorkflow(
          mockOctokit,
          createDefaultInputs({ baseConfigPath: '.warden-org/missing.toml' }),
          SCHEDULE_FIXTURES
        )
      ).rejects.toThrow('Configuration file not found');
    });

    it('fails when the base config defines local skills without baseSkillRoot', async () => {
      await expect(
        runScheduleWorkflow(
          mockOctokit,
          createDefaultInputs({ baseConfigPath: '.warden-org/warden.toml' }),
          SCHEDULE_FIXTURES
        )
      ).rejects.toThrow(
        'base-skill-root is required when the base config defines local skills'
      );
    });

    it('exits early when no schedule triggers configured', async () => {
      // The PR_ONLY_FIXTURES config only has pull_request triggers
      await runScheduleWorkflow(mockOctokit, createDefaultInputs(), PR_ONLY_FIXTURES);

      expect(mockRunSkill).not.toHaveBeenCalled();
      expect(mockCreateOrUpdateIssue).not.toHaveBeenCalled();
    });

    it('fails when GITHUB_REPOSITORY is not set', async () => {
      delete process.env['GITHUB_REPOSITORY'];

      await expect(
        runScheduleWorkflow(mockOctokit, createDefaultInputs(), SCHEDULE_FIXTURES)
      ).rejects.toThrow('setFailed');

      expect(mockSetFailed).toHaveBeenCalledWith(
        'GITHUB_REPOSITORY environment variable not set'
      );
    });

    it('fails when GITHUB_REPOSITORY has invalid format', async () => {
      process.env['GITHUB_REPOSITORY'] = 'noslash';

      await expect(
        runScheduleWorkflow(mockOctokit, createDefaultInputs(), SCHEDULE_FIXTURES)
      ).rejects.toThrow('setFailed');

      expect(mockSetFailed).toHaveBeenCalledWith('Invalid GITHUB_REPOSITORY format');
    });

    it('fails when GITHUB_SHA is not set', async () => {
      delete process.env['GITHUB_SHA'];

      await expect(
        runScheduleWorkflow(mockOctokit, createDefaultInputs(), SCHEDULE_FIXTURES)
      ).rejects.toThrow('setFailed');

      expect(mockSetFailed).toHaveBeenCalledWith(
        'GITHUB_SHA environment variable not set'
      );
    });
  });

  // ---------------------------------------------------------------------------
  // Happy Path
  // ---------------------------------------------------------------------------

  describe('happy path', () => {
    it('runs skill and creates issue when findings exist', async () => {
      const finding = createFinding({ severity: 'high' });
      const report = createSkillReport({ findings: [finding] });
      mockRunSkill.mockResolvedValue(report);

      await runScheduleWorkflow(mockOctokit, createDefaultInputs(), SCHEDULE_FIXTURES);

      expect(mockRunSkill).toHaveBeenCalledTimes(1);
      expect(mockCreateOrUpdateIssue).toHaveBeenCalledWith(
        mockOctokit,
        'test-owner',
        'test-repo',
        [report],
        expect.objectContaining({
          title: 'Warden: test-skill',
          commitSha: 'abc123',
        })
      );
    });

    it('creates issue even when no findings', async () => {
      mockRunSkill.mockResolvedValue(createSkillReport({ findings: [] }));

      await runScheduleWorkflow(mockOctokit, createDefaultInputs(), SCHEDULE_FIXTURES);

      expect(mockRunSkill).toHaveBeenCalledTimes(1);
      expect(mockCreateOrUpdateIssue).toHaveBeenCalledTimes(1);
    });

    it('includes configuredSkills in the v1 findings output, matching the PR workflow', async () => {
      mockRunSkill.mockResolvedValue(createSkillReport({ findings: [] }));

      const findingsFile = getFindingsOutputPath(SCHEDULE_FIXTURES);

      try {
        await runScheduleWorkflow(mockOctokit, createDefaultInputs(), SCHEDULE_FIXTURES);

        const findings = JSON.parse(readFileSync(findingsFile, 'utf-8'));
        expect(findings.configuredSkills).toEqual([{ name: 'test-skill', triggered: true }]);
      } finally {
        rmSync(findingsFile, { force: true });
      }
    });

    it('lists PR-only skills as untriggered in configuredSkills instead of omitting them', async () => {
      mockRunSkill.mockResolvedValue(createSkillReport({ findings: [] }));

      const findingsFile = getFindingsOutputPath(SCHEDULE_WITH_PR_SKILL_FIXTURES);

      try {
        await runScheduleWorkflow(mockOctokit, createDefaultInputs(), SCHEDULE_WITH_PR_SKILL_FIXTURES);

        const findings = JSON.parse(readFileSync(findingsFile, 'utf-8'));
        expect(findings.configuredSkills).toEqual(
          expect.arrayContaining([
            { name: 'test-skill', triggered: true },
            { name: 'pr-only-skill', triggered: false },
          ])
        );
      } finally {
        rmSync(findingsFile, { force: true });
      }
    });

    it('skips skill run when no files match trigger', async () => {
      mockBuildContext.mockResolvedValue(
        createScheduleContext({
          pullRequest: {
            number: 0,
            title: 'Scheduled Analysis',
            body: null,
            author: 'warden',
            baseBranch: 'main',
            headBranch: 'main',
            headSha: 'abc123',
            baseSha: 'abc123',
            files: [],
          },
        })
      );

      await runScheduleWorkflow(mockOctokit, createDefaultInputs(), SCHEDULE_FIXTURES);

      expect(mockRunSkill).not.toHaveBeenCalled();
      expect(mockCreateOrUpdateIssue).not.toHaveBeenCalled();
    });
  });

  // ---------------------------------------------------------------------------
  // Schema v2 output
  // ---------------------------------------------------------------------------

  describe('schema v2 output', () => {
    it('writes schema-v2 metadata and findings for a matched schedule trigger', async () => {
      const finding = createFinding({ severity: 'high' });
      mockRunSkill.mockResolvedValue(createSkillReport({ findings: [finding] }));

      const metadataFile = getMetadataOutputPath(SCHEDULE_FIXTURES);
      const findingsFile = getFindingsOutputPathV2(SCHEDULE_FIXTURES);

      try {
        await runScheduleWorkflow(
          mockOctokit,
          createDefaultInputs({ outputSchemaVersion: '2' }),
          SCHEDULE_FIXTURES
        );

        const metadata = JSON.parse(readFileSync(metadataFile, 'utf-8'));
        const findings = JSON.parse(readFileSync(findingsFile, 'utf-8'));

        expect(metadata.schemaVersion).toBe('2');
        expect(findings.schemaVersion).toBe('2');
        expect(findings.skillExecutions).toHaveLength(1);
        expect(findings.findings).toHaveLength(1);
        expect(findings.findings[0]?.id).toBe(finding.id);
      } finally {
        rmSync(metadataFile, { force: true });
        rmSync(findingsFile, { force: true });
      }
    });

    it('records verification provenance from onFindingProcessing in schedule v2 output', async () => {
      const finding = createFinding({ severity: 'high' });
      mockRunSkill.mockImplementation(async (_skill, _context, options) => {
        options?.callbacks?.onFindingProcessing?.({
          stage: 'verification',
          action: 'kept',
          finding,
          reason: 'still real after tracing',
          model: 'claude-haiku-4-5',
        });
        return createSkillReport({ findings: [finding] });
      });

      const metadataFile = getMetadataOutputPath(SCHEDULE_FIXTURES);
      const findingsFile = getFindingsOutputPathV2(SCHEDULE_FIXTURES);

      try {
        await runScheduleWorkflow(
          mockOctokit,
          createDefaultInputs({ outputSchemaVersion: '2' }),
          SCHEDULE_FIXTURES
        );

        const findings = JSON.parse(readFileSync(findingsFile, 'utf-8'));
        expect(findings.findings[0]?.provenance.verification).toEqual({
          outcome: 'kept',
          model: 'claude-haiku-4-5',
          runtime: undefined,
        });
      } finally {
        rmSync(metadataFile, { force: true });
        rmSync(findingsFile, { force: true });
      }
    });

    it('records a schedule trigger with no matching files as skipped with reason no_changes', async () => {
      mockBuildContext.mockResolvedValue(
        createScheduleContext({
          pullRequest: {
            number: 0,
            title: 'Scheduled Analysis',
            body: null,
            author: 'warden',
            baseBranch: 'main',
            headBranch: 'main',
            headSha: 'abc123',
            baseSha: 'abc123',
            files: [],
          },
        })
      );

      const metadataFile = getMetadataOutputPath(SCHEDULE_FIXTURES);
      const findingsFile = getFindingsOutputPathV2(SCHEDULE_FIXTURES);

      try {
        await runScheduleWorkflow(
          mockOctokit,
          createDefaultInputs({ outputSchemaVersion: '2' }),
          SCHEDULE_FIXTURES
        );

        const metadata = JSON.parse(readFileSync(metadataFile, 'utf-8'));

        expect(metadata.skippedTriggers).toEqual(
          expect.arrayContaining([expect.objectContaining({ reason: 'no_changes' })])
        );
      } finally {
        rmSync(metadataFile, { force: true });
        rmSync(findingsFile, { force: true });
      }
    });

    it('does not write schema-v2 files when output-schema-version is 1', async () => {
      mockRunSkill.mockResolvedValue(createSkillReport({ findings: [] }));

      const metadataFile = getMetadataOutputPath(SCHEDULE_FIXTURES);
      const findingsFile = getFindingsOutputPathV2(SCHEDULE_FIXTURES);
      rmSync(metadataFile, { force: true });
      rmSync(findingsFile, { force: true });

      await runScheduleWorkflow(mockOctokit, createDefaultInputs(), SCHEDULE_FIXTURES);

      expect(() => readFileSync(metadataFile, 'utf-8')).toThrow();
      expect(() => readFileSync(findingsFile, 'utf-8')).toThrow();
    });

    it('still writes schema-v2 files on the no-config early return when the v1 write throws', async () => {
      vi.mocked(writeFindingsOutput).mockImplementationOnce(() => {
        throw new Error('disk full');
      });

      const metadataFile = getMetadataOutputPath(NO_CONFIG_FIXTURES);
      const findingsFile = getFindingsOutputPathV2(NO_CONFIG_FIXTURES);

      try {
        await runScheduleWorkflow(
          mockOctokit,
          createDefaultInputs({ outputSchemaVersion: '2' }),
          NO_CONFIG_FIXTURES
        );

        const metadata = JSON.parse(readFileSync(metadataFile, 'utf-8'));
        expect(metadata.schemaVersion).toBe('2');
      } finally {
        rmSync(metadataFile, { force: true });
        rmSync(findingsFile, { force: true });
      }
    });

    it('still writes schema-v2 files when every schedule trigger fails', async () => {
      mockRunSkill.mockRejectedValue(new Error('Skill failed'));

      const metadataFile = getMetadataOutputPath(SCHEDULE_MULTI_FIXTURES);
      const findingsFile = getFindingsOutputPathV2(SCHEDULE_MULTI_FIXTURES);

      try {
        await expect(
          runScheduleWorkflow(
            mockOctokit,
            createDefaultInputs({ outputSchemaVersion: '2' }),
            SCHEDULE_MULTI_FIXTURES
          )
        ).rejects.toThrow('setFailed');

        const metadata = JSON.parse(readFileSync(metadataFile, 'utf-8'));
        const findings = JSON.parse(readFileSync(findingsFile, 'utf-8'));
        expect(metadata.schemaVersion).toBe('2');
        expect(findings.schemaVersion).toBe('2');
        expect(metadata.triggerResults).toHaveLength(2);
        expect(metadata.triggerResults.every((result: { status: string }) => result.status === 'error')).toBe(true);
      } finally {
        rmSync(metadataFile, { force: true });
        rmSync(findingsFile, { force: true });
      }
    });
  });

  // ---------------------------------------------------------------------------
  // Issue & PR Creation
  // ---------------------------------------------------------------------------

  describe('issue and PR creation', () => {
    it('uses custom issue title from schedule config', async () => {
      const report = createSkillReport({ findings: [] });
      mockRunSkill.mockResolvedValue(report);

      await runScheduleWorkflow(
        mockOctokit,
        createDefaultInputs(),
        SCHEDULE_TITLE_FIXTURES
      );

      expect(mockCreateOrUpdateIssue).toHaveBeenCalledWith(
        mockOctokit,
        'test-owner',
        'test-repo',
        [report],
        expect.objectContaining({
          title: 'Custom Issue Title',
        })
      );
    });
  });

  // ---------------------------------------------------------------------------
  // Failure & Error Handling
  // ---------------------------------------------------------------------------

  describe('failure and error handling', () => {
    it('requires Claude auth when the runtime is Claude', async () => {
      await expect(
        runScheduleWorkflow(
          mockOctokit,
          createDefaultInputs({ anthropicApiKey: '', oauthToken: '' }),
          RUNTIME_CLAUDE_FIXTURES
        )
      ).rejects.toThrow('setFailed');

      expect(mockSetFailed).toHaveBeenCalledWith(
        expect.stringContaining('Authentication not found')
      );
      expect(mockRunSkill).not.toHaveBeenCalled();
    });

    it('fails when failOn threshold is met and failCheck is true', async () => {
      const finding = createFinding({ severity: 'high' });
      mockRunSkill.mockResolvedValue(createSkillReport({ findings: [finding] }));

      await expect(
        runScheduleWorkflow(
          mockOctokit,
          createDefaultInputs({ failOn: 'high', failCheck: true }),
          SCHEDULE_FIXTURES
        )
      ).rejects.toThrow('setFailed');

      expect(mockSetFailed).toHaveBeenCalledWith(
        expect.stringContaining('high+ severity')
      );
    });

    it('does not fail when failOn threshold is met but failCheck is false', async () => {
      const finding = createFinding({ severity: 'high' });
      mockRunSkill.mockResolvedValue(createSkillReport({ findings: [finding] }));

      // Should complete without throwing (failCheck defaults to false)
      await runScheduleWorkflow(
        mockOctokit,
        createDefaultInputs({ failOn: 'high' }),
        SCHEDULE_FIXTURES
      );

      expect(mockSetFailed).not.toHaveBeenCalled();
    });

    it('records error and calls handleTriggerErrors when trigger throws', async () => {
      // Use multi-trigger fixture so not all triggers fail
      mockResolveSkillAsync.mockResolvedValue({
        name: 'test-skill-a',
        description: 'Test skill A',
        prompt: 'Review code',
      });

      // First trigger fails, second succeeds
      mockRunSkill
        .mockRejectedValueOnce(new Error('Skill failed'))
        .mockResolvedValueOnce(createSkillReport());

      // Should not throw since only one of two triggers failed
      await runScheduleWorkflow(
        mockOctokit,
        createDefaultInputs(),
        SCHEDULE_MULTI_FIXTURES
      );

      // The error should be logged
      expect(consoleErrorSpy).toHaveBeenCalledWith(
        expect.stringContaining('Trigger test-skill-a failed')
      );
    });

    it('fails when all triggers throw', async () => {
      mockRunSkill.mockRejectedValue(new Error('Skill failed'));

      // Use multi-trigger fixture — both triggers fail
      await expect(
        runScheduleWorkflow(
          mockOctokit,
          createDefaultInputs(),
          SCHEDULE_MULTI_FIXTURES
        )
      ).rejects.toThrow('setFailed');

      expect(mockSetFailed).toHaveBeenCalledWith(
        expect.stringContaining('All 2 trigger(s) failed')
      );
    });
  });

  // ---------------------------------------------------------------------------
  // Outputs
  // ---------------------------------------------------------------------------

  describe('outputs', () => {
    it('aggregates severity counts across multiple triggers', async () => {
      const finding1 = createFinding({
        id: 'f1',
        severity: 'high',
        title: 'Security bug',
      });
      const finding2 = createFinding({
        id: 'f2',
        severity: 'high',
        title: 'Logic bug',
      });

      // Alternate skill resolution for multi fixtures
      mockResolveSkillAsync
        .mockResolvedValueOnce({
          name: 'test-skill-a',
          description: 'Test skill A',
          prompt: 'Review code',
        })
        .mockResolvedValueOnce({
          name: 'test-skill-b',
          description: 'Test skill B',
          prompt: 'Review code',
        });

      mockRunSkill
        .mockResolvedValueOnce(
          createSkillReport({
            skill: 'test-skill-a',
            findings: [finding1],
            summary: 'Found security issue',
          })
        )
        .mockResolvedValueOnce(
          createSkillReport({
            skill: 'test-skill-b',
            findings: [finding2],
            summary: 'Found high issue',
          })
        );

      await runScheduleWorkflow(
        mockOctokit,
        createDefaultInputs(),
        SCHEDULE_MULTI_FIXTURES
      );

      // Verify console output includes the total
      expect(consoleLogSpy).toHaveBeenCalledWith(
        expect.stringContaining('2 total findings')
      );
    });
  });
});
