import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import type * as NodeFS from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { EventContext, SkillReport } from '../../types/index.js';
import type { ActionInputs } from '../inputs.js';

vi.mock('../../utils/exec.js', async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...(actual as Record<string, unknown>),
    execFileNonInteractive: vi.fn(),
    execNonInteractive: vi.fn(),
  };
});

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof NodeFS>();
  return { ...actual, writeFileSync: vi.fn(actual.writeFileSync) };
});

import { execFileNonInteractive, execNonInteractive } from '../../utils/exec.js';
import {
  getFindingsOutputPath,
  getFindingsOutputPathV2,
  prepareRuntimeEnvironment,
  writeFindingsOutput,
  writeFindingsOutputs,
  writeSchemaV2OutputPair,
  writeSchemaV2OutputPairLive,
} from './base.js';
import { FindingsOutputSchema } from '../reporting/output.js';
import type { WardenFindingsV2, WardenMetadata } from '../reporting/output-v2.js';

const mockExecFile = vi.mocked(execFileNonInteractive);
const mockExec = vi.mocked(execNonInteractive);

describe('findings output', () => {
  let tempDir: string;
  let previousGithubOutput: string | undefined;
  let previousGithubWorkspace: string | undefined;
  let previousRunnerTemp: string | undefined;

  beforeEach(() => {
    vi.clearAllMocks();
    tempDir = mkdtempSync(join(tmpdir(), 'warden-findings-output-'));
    previousGithubOutput = process.env['GITHUB_OUTPUT'];
    previousGithubWorkspace = process.env['GITHUB_WORKSPACE'];
    previousRunnerTemp = process.env['RUNNER_TEMP'];
    process.env['GITHUB_OUTPUT'] = join(tempDir, 'github-output');
    delete process.env['RUNNER_TEMP'];
  });

  afterEach(() => {
    if (previousGithubOutput === undefined) {
      delete process.env['GITHUB_OUTPUT'];
    } else {
      process.env['GITHUB_OUTPUT'] = previousGithubOutput;
    }

    if (previousGithubWorkspace === undefined) {
      delete process.env['GITHUB_WORKSPACE'];
    } else {
      process.env['GITHUB_WORKSPACE'] = previousGithubWorkspace;
    }

    if (previousRunnerTemp === undefined) {
      delete process.env['RUNNER_TEMP'];
    } else {
      process.env['RUNNER_TEMP'] = previousRunnerTemp;
    }

    rmSync(tempDir, { recursive: true, force: true });
  });

  it('writes findings to the workspace and exposes a repo-relative output path', () => {
    process.env['GITHUB_WORKSPACE'] = tempDir;

    const filePath = writeFindingsOutput(
      [createReport()],
      createContext(tempDir),
      [{
        outcome: 'posted',
        skill: 'test-skill',
        finding: createReport().findings[0]!,
      }],
    );

    expect(filePath).toBe(join(tempDir, 'warden-findings.json'));
    expect(existsSync(filePath)).toBe(true);
    expect(readFileSync(process.env['GITHUB_OUTPUT']!, 'utf-8')).toBe(
      'findings-file=warden-findings.json\n'
    );

    const payload = FindingsOutputSchema.parse(JSON.parse(readFileSync(filePath, 'utf-8')));
    expect(payload.summary.totalFindings).toBe(1);
    expect(payload.skills[0]?.findings[0]?.sourceSnippet).toEqual({
      path: 'src/index.ts',
      startLine: 1,
      endLine: 3,
      targetStartLine: 1,
      targetEndLine: 1,
      lines: [
        { line: 1, content: 'const value = input;', highlighted: true },
        { line: 2, content: 'return value;' },
        { line: 3, content: '}' },
      ],
    });
    expect(payload.findingObservations).toHaveLength(1);
  });

  it('repoints the findings-file output at the v2 file, matching what report mode reads as its findings-file input', () => {
    process.env['GITHUB_WORKSPACE'] = tempDir;

    writeSchemaV2OutputPair(createV2Metadata(), createV2Findings(), createContext(tempDir));

    const outputContent = readFileSync(process.env['GITHUB_OUTPUT']!, 'utf-8');
    expect(outputContent).toContain('metadata-file=warden-metadata.json\n');
    expect(outputContent).toContain('findings-file-v2=warden-findings-v2.json\n');
    expect(outputContent).toContain('findings-file=warden-findings-v2.json\n');
  });

  it('writes a .done sidecar next to the findings file once both files land', () => {
    process.env['GITHUB_WORKSPACE'] = tempDir;

    const { findingsPath } = writeSchemaV2OutputPair(createV2Metadata(), createV2Findings(), createContext(tempDir));

    expect(existsSync(`${findingsPath}.done`)).toBe(true);
    expect(readFileSync(`${findingsPath}.done`, 'utf-8')).toBe('');
  });

  it('the live writer writes both content files but never a .done sidecar or GITHUB_OUTPUT', () => {
    process.env['GITHUB_WORKSPACE'] = tempDir;

    writeSchemaV2OutputPairLive(createV2Metadata(), createV2Findings(), createContext(tempDir));

    const findingsPath = getFindingsOutputPathV2(tempDir);
    expect(existsSync(findingsPath)).toBe(true);
    expect(existsSync(`${findingsPath}.done`)).toBe(false);
    expect(existsSync(process.env['GITHUB_OUTPUT']!)).toBe(false);
  });

  it('the live writer removes a stale .done sidecar left over from a previous run', () => {
    process.env['GITHUB_WORKSPACE'] = tempDir;

    // A prior run at this same path (persistent runner, or a repeated local
    // invocation) finished and left its .done marker behind.
    writeSchemaV2OutputPair(createV2Metadata(), createV2Findings(), createContext(tempDir));
    const findingsPath = getFindingsOutputPathV2(tempDir);
    expect(existsSync(`${findingsPath}.done`)).toBe(true);

    writeSchemaV2OutputPairLive(createV2Metadata(), createV2Findings(), createContext(tempDir));

    expect(existsSync(`${findingsPath}.done`)).toBe(false);
  });

  it('the live writer swallows a write failure instead of throwing', async () => {
    process.env['GITHUB_WORKSPACE'] = tempDir;
    const { writeFileSync } = await import('node:fs');
    vi.mocked(writeFileSync).mockImplementationOnce(() => {
      throw new Error('disk full');
    });

    expect(() =>
      writeSchemaV2OutputPairLive(createV2Metadata(), createV2Findings(), createContext(tempDir))
    ).not.toThrow();
  });

  it('falls back to RUNNER_TEMP when no repo path is provided', () => {
    const runnerTemp = join(tempDir, 'runner-temp');
    mkdirSync(runnerTemp);
    process.env['RUNNER_TEMP'] = runnerTemp;

    expect(getFindingsOutputPath()).toBe(join(runnerTemp, 'warden-findings.json'));
  });
});

describe('writeFindingsOutputs', () => {
  it('always runs writeV2 even when writeV1 throws, and reports the failure only after', () => {
    const order: string[] = [];
    const onFailure = vi.fn();

    writeFindingsOutputs(
      () => {
        order.push('v1');
        throw new Error('disk full');
      },
      () => order.push('v2'),
      onFailure
    );

    expect(order).toEqual(['v1', 'v2']);
    expect(onFailure).toHaveBeenCalledWith('Failed to write findings output: Error: disk full');
  });

  it('reports success and still runs writeV2 when writeV1 succeeds', () => {
    const onFailure = vi.fn();
    const onSuccess = vi.fn();
    const writeV2 = vi.fn();

    writeFindingsOutputs(() => '/tmp/warden-findings.json', writeV2, onFailure, onSuccess);

    expect(writeV2).toHaveBeenCalledOnce();
    expect(onSuccess).toHaveBeenCalledWith('/tmp/warden-findings.json');
    expect(onFailure).not.toHaveBeenCalled();
  });
});

describe('runtime setup', () => {
  let previousClaudeCodePath: string | undefined;
  let previousHome: string | undefined;

  beforeEach(() => {
    vi.clearAllMocks();
    previousClaudeCodePath = process.env['CLAUDE_CODE_PATH'];
    previousHome = process.env['HOME'];
    delete process.env['CLAUDE_CODE_PATH'];
    process.env['HOME'] = '/tmp/warden-home';
  });

  afterEach(() => {
    if (previousClaudeCodePath === undefined) {
      delete process.env['CLAUDE_CODE_PATH'];
    } else {
      process.env['CLAUDE_CODE_PATH'] = previousClaudeCodePath;
    }

    if (previousHome === undefined) {
      delete process.env['HOME'];
    } else {
      process.env['HOME'] = previousHome;
    }
  });

  it('does not install anything for Pi-only triggers', async () => {
    const env = await prepareRuntimeEnvironment([{ runtime: 'pi' }], createInputs());

    expect(env).toEqual({});
    expect(mockExec).not.toHaveBeenCalled();
    expect(mockExecFile).not.toHaveBeenCalled();
  });

  it('installs Claude Code when any matched trigger uses the Claude runtime', async () => {
    let installed = false;
    const homeClaudePath = '/tmp/warden-home/.local/bin/claude';
    mockExecFile.mockImplementation((file, args) => {
      if (file === 'test' && args[1] === homeClaudePath && installed) {
        return '';
      }
      throw new Error('not executable');
    });
    mockExec.mockImplementation(() => {
      installed = true;
      return 'install output';
    });

    await expect(
      prepareRuntimeEnvironment([{ runtime: 'pi' }, { runtime: 'claude' }], createInputs())
    ).resolves.toEqual({ pathToClaudeCodeExecutable: homeClaudePath });
    expect(mockExec).toHaveBeenCalledWith(
      'curl -fsSL https://claude.ai/install.sh | bash -s -- "2.1.32"',
      { timeout: 120_000 }
    );
  });
});

function createInputs(overrides: Partial<ActionInputs> = {}): ActionInputs {
  return {
    anthropicApiKey: 'test-key',
    oauthToken: '',
    githubToken: 'github-token',
    mode: 'run',
    configPath: 'warden.toml',
    maxFindings: 50,
    parallel: 4,
    outputSchemaVersion: '1',
    ...overrides,
  };
}

function createV2Metadata(): WardenMetadata {
  return {
    schemaVersion: '2',
    runId: '123',
    generatedAt: new Date().toISOString(),
    harness: { name: 'warden', version: '1.0.0' },
    repository: { owner: 'getsentry', name: 'warden', fullName: 'getsentry/warden' },
    event: 'pull_request',
  };
}

function createV2Findings(): WardenFindingsV2 {
  return {
    schemaVersion: '2',
    runId: '123',
    skillExecutions: [],
    findings: [],
    findingObservations: [],
    summary: {
      totalFindings: 0,
      totalSkillExecutions: 0,
      bySeverity: { high: 0, medium: 0, low: 0 },
      byOutcome: { posted: 0, deduped: 0, skipped: 0, resolved: 0, failed: 0 },
    },
  };
}

function createContext(repoPath: string): EventContext {
  return {
    eventType: 'schedule',
    action: 'scheduled',
    repository: {
      owner: 'getsentry',
      name: 'example',
      fullName: 'getsentry/example',
      defaultBranch: 'main',
    },
    pullRequest: {
      number: 1,
      title: 'Scheduled Analysis',
      body: null,
      author: 'warden',
      baseBranch: 'main',
      headBranch: 'main',
      headSha: 'abc123',
      baseSha: 'abc123',
      files: [],
    },
    repoPath,
  };
}

function createReport(): SkillReport {
  return {
    skill: 'test-skill',
    summary: 'Found one issue',
    findings: [
      {
        id: 'finding-1',
        severity: 'high',
        title: 'Example finding',
        description: 'A test finding',
        location: { path: 'src/index.ts', startLine: 1 },
        sourceSnippet: {
          path: 'src/index.ts',
          startLine: 1,
          endLine: 3,
          targetStartLine: 1,
          targetEndLine: 1,
          lines: [
            { line: 1, content: 'const value = input;', highlighted: true },
            { line: 2, content: 'return value;' },
            { line: 3, content: '}' },
          ],
        },
      },
    ],
  };
}
