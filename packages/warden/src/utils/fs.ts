import { existsSync, mkdirSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
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
 * temp path first, then rename each temp file into place, backing up
 * whichever destination already existed. If a staging write fails, none of
 * the target paths are touched. If a rename fails partway through the commit
 * phase, every destination already renamed this call is restored from its
 * backup (or removed, if it didn't exist before) before rethrowing. Either
 * way, callers that require several files to stay in sync (e.g. a
 * metadata/findings pair sharing a runId) never observe a partial commit —
 * one file updated to a new run while its partner still holds a prior one.
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
  } catch (error) {
    for (const { tempPath } of staged) {
      try { unlinkSync(tempPath); } catch { /* best-effort cleanup */ }
    }
    throw error;
  }

  const committed: { path: string; backupPath?: string }[] = [];
  try {
    for (const { tempPath, path } of staged) {
      const backupPath = existsSync(path) ? `${path}.${process.pid}.${Date.now()}.bak` : undefined;
      if (backupPath) renameSync(path, backupPath);
      try {
        renameSync(tempPath, path);
      } catch (error) {
        // The backup rename above (if any) already succeeded for this entry, so it isn't
        // in `committed` yet — restore it here before letting the outer catch handle the
        // entries from earlier iterations that did make it into `committed`.
        if (backupPath) {
          try { renameSync(backupPath, path); } catch { /* best-effort rollback */ }
        }
        throw error;
      }
      committed.push({ path, backupPath });
    }
  } catch (error) {
    for (const { path, backupPath } of committed) {
      try {
        if (backupPath) renameSync(backupPath, path);
        else unlinkSync(path);
      } catch { /* best-effort rollback */ }
    }
    for (const { tempPath, path } of staged) {
      if (!committed.some((entry) => entry.path === path)) {
        try { unlinkSync(tempPath); } catch { /* best-effort cleanup */ }
      }
    }
    throw error;
  }

  for (const { backupPath } of committed) {
    if (backupPath) {
      try { unlinkSync(backupPath); } catch { /* best-effort cleanup */ }
    }
  }
}
