import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import type * as NodeFS from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { writeFileAtomic, writeFilesAtomicPair } from './fs.js';

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof NodeFS>();
  return { ...actual, renameSync: vi.fn(actual.renameSync), writeFileSync: vi.fn(actual.writeFileSync) };
});

describe('writeFileAtomic', () => {
  let tempDir: string;
  let targetPath: string;

  beforeEach(() => {
    tempDir = join(tmpdir(), `warden-write-file-atomic-${Date.now()}`);
    mkdirSync(tempDir, { recursive: true });
    targetPath = join(tempDir, 'nested', 'output.json');
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  it('writes the exact content and creates parent directories', () => {
    writeFileAtomic(targetPath, '{"a":1}');
    expect(readFileSync(targetPath, 'utf-8')).toBe('{"a":1}');
  });

  it('overwrites an existing file', () => {
    writeFileAtomic(targetPath, 'first');
    writeFileAtomic(targetPath, 'second');
    expect(readFileSync(targetPath, 'utf-8')).toBe('second');
  });

  it('leaves no temp file behind after repeated calls', () => {
    for (let i = 0; i < 5; i++) {
      writeFileAtomic(targetPath, `content-${i}`);
    }
    const entries = readdirSync(join(tempDir, 'nested'));
    expect(entries).toEqual(['output.json']);
  });

  it('cleans up the temp file and rethrows when rename fails', async () => {
    const { renameSync } = await import('node:fs');
    vi.mocked(renameSync).mockImplementationOnce(() => {
      throw new Error('rename failed');
    });

    expect(() => writeFileAtomic(targetPath, 'content')).toThrow('rename failed');
    expect(existsSync(targetPath)).toBe(false);
    const entries = readdirSync(join(tempDir, 'nested'));
    expect(entries).toEqual([]);
  });
});

describe('writeFilesAtomicPair', () => {
  let tempDir: string;
  let firstPath: string;
  let secondPath: string;

  beforeEach(() => {
    tempDir = join(tmpdir(), `warden-write-files-atomic-pair-${Date.now()}`);
    mkdirSync(tempDir, { recursive: true });
    firstPath = join(tempDir, 'first.json');
    secondPath = join(tempDir, 'second.json');
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  it('writes every file when all staging writes succeed', () => {
    writeFilesAtomicPair([
      { path: firstPath, content: 'first-content' },
      { path: secondPath, content: 'second-content' },
    ]);

    expect(readFileSync(firstPath, 'utf-8')).toBe('first-content');
    expect(readFileSync(secondPath, 'utf-8')).toBe('second-content');
  });

  it('leaves all target files untouched when the second file fails to stage', async () => {
    writeFilesAtomicPair([{ path: firstPath, content: 'stale-first' }]);

    const actualFs = await vi.importActual<typeof NodeFS>('node:fs');
    const { writeFileSync } = await import('node:fs');
    vi.mocked(writeFileSync)
      .mockImplementationOnce(actualFs.writeFileSync)
      .mockImplementationOnce(() => {
        throw new Error('disk full');
      });

    expect(() =>
      writeFilesAtomicPair([
        { path: firstPath, content: 'new-first' },
        { path: secondPath, content: 'new-second' },
      ])
    ).toThrow('disk full');

    expect(readFileSync(firstPath, 'utf-8')).toBe('stale-first');
    expect(existsSync(secondPath)).toBe(false);
  });

  it('cleans up the first file\'s staged temp file when the second file fails to stage', async () => {
    const actualFs = await vi.importActual<typeof NodeFS>('node:fs');
    const { writeFileSync } = await import('node:fs');
    vi.mocked(writeFileSync)
      .mockImplementationOnce(actualFs.writeFileSync)
      .mockImplementationOnce(() => {
        throw new Error('disk full');
      });

    expect(() =>
      writeFilesAtomicPair([
        { path: firstPath, content: 'first-content' },
        { path: secondPath, content: 'second-content' },
      ])
    ).toThrow('disk full');

    expect(readdirSync(tempDir)).toEqual([]);
  });
});
