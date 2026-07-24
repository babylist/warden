import { mkdirSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

/**
 * Write a file's full contents atomically: write to a temp path in the same
 * directory, then rename into place. Readers never observe a partial write.
 * On failure, best-effort removes the temp file before rethrowing.
 */
export function writeFileAtomic(path: string, content: string): void {
  mkdirSync(dirname(path), { recursive: true });
  const tempPath = `${path}.${process.pid}.${Date.now()}.tmp`;
  try {
    writeFileSync(tempPath, content);
    renameSync(tempPath, path);
  } catch (error) {
    try { unlinkSync(tempPath); } catch { /* best-effort cleanup */ }
    throw error;
  }
}

/**
 * Write multiple files as one atomic unit: stage every file's content to a
 * temp path first, and only rename any of them into place once every staging
 * write has succeeded. If a staging write fails partway through, none of the
 * target paths are touched, so callers that require several files to stay in
 * sync (e.g. a metadata/findings pair sharing a runId) never observe one
 * file updated to a new run while the other still holds a prior run.
 */
export function writeFilesAtomicPair(files: { path: string; content: string }[]): void {
  const staged: { tempPath: string; path: string }[] = [];
  try {
    for (const { path, content } of files) {
      mkdirSync(dirname(path), { recursive: true });
      const tempPath = `${path}.${process.pid}.${Date.now()}.tmp`;
      writeFileSync(tempPath, content);
      staged.push({ tempPath, path });
    }
    for (const { tempPath, path } of staged) {
      renameSync(tempPath, path);
    }
  } catch (error) {
    for (const { tempPath } of staged) {
      try { unlinkSync(tempPath); } catch { /* best-effort cleanup */ }
    }
    throw error;
  }
}
