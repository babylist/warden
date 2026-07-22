import { describe, expect, it, vi, beforeEach } from 'vitest';

describe('getVersion', () => {
  beforeEach(() => {
    vi.resetModules();
  });

  function occurrencesOf(needle: string, haystack: string): number {
    return haystack.split(needle).length - 1;
  }

  it('reads the package.json two levels up from the compiled file', async () => {
    vi.doMock('node:fs', () => ({
      existsSync: (path: string) => occurrencesOf('packages/warden', path) <= 1,
      readFileSync: () => JSON.stringify({ version: '1.2.3' }),
    }));
    const { getVersion } = await import('./version.js');
    expect(getVersion()).toBe('1.2.3');
  });

  it('falls back to packages/warden/package.json when the two-levels-up file has no version (ncc bundle layout)', async () => {
    vi.doMock('node:fs', () => ({
      existsSync: (path: string) => occurrencesOf('packages/warden', path) === 2,
      readFileSync: (path: string) =>
        occurrencesOf('packages/warden', path) === 2
          ? JSON.stringify({ version: '0.42.0' })
          : JSON.stringify({ name: 'warden-monorepo' }),
    }));
    const { getVersion } = await import('./version.js');
    expect(getVersion()).toBe('0.42.0');
  });

  it('falls back to 0.0.0 when no package.json with a version is found', async () => {
    vi.doMock('node:fs', () => ({
      existsSync: () => false,
      readFileSync: () => '{}',
    }));
    const { getVersion } = await import('./version.js');
    expect(getVersion()).toBe('0.0.0');
  });
});
