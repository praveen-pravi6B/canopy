import { readFileSync } from 'node:fs';

function readVersion(): string {
  try {
    const pkg = JSON.parse(
      readFileSync(new URL('../../package.json', import.meta.url), 'utf8'),
    ) as { version?: string };
    return pkg.version ?? '0.0.0';
  } catch {
    return '0.0.0';
  }
}

export const TOOL_VERSION = readVersion();

export const USER_AGENT = 'CanopyBot/0.1 (+https://github.com/praveen-pravi6B/canopy)';
