/**
 * Write a file's full contents atomically: write to a temp path in the same
 * directory, then rename into place. Readers never observe a partial write.
 * On failure, best-effort removes the temp file before rethrowing.
 */
export declare function writeFileAtomic(path: string, content: string): void;
//# sourceMappingURL=fs.d.ts.map