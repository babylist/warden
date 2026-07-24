import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

let cachedVersion: string | undefined;

/** Only trusts a version from the actual @sentry/warden package.json, not just any package.json that happens to exist at a candidate path. */
function readPackageVersion(path: string): string | undefined {
  if (!existsSync(path)) return undefined;
  const pkg = JSON.parse(readFileSync(path, 'utf-8')) as { name?: string; version?: string };
  return pkg.name === '@sentry/warden' ? pkg.version : undefined;
}

export function getVersion(): string {
  if (cachedVersion) return cachedVersion;
  const __dirname = dirname(fileURLToPath(import.meta.url));
  // Normal build: dist/<pkg-relative-dir>/utils/version.js, two levels below the
  // package root. ncc-bundled action: dist/action/index.js at the monorepo root,
  // where packages/warden/package.json is a sibling rather than an ancestor.
  cachedVersion =
    readPackageVersion(join(__dirname, '..', '..', 'package.json')) ??
    readPackageVersion(join(__dirname, '..', '..', 'packages', 'warden', 'package.json')) ??
    '0.0.0';
  return cachedVersion;
}

export function getMajorVersion(): string {
  return getVersion().split('.')[0] ?? '0';
}
