import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  CanopyConfigSchema,
  DEFAULT_CONFIG,
  findConfig,
  loadConfig,
} from '../src/core/config.js';

const cleanup: string[] = [];

afterEach(async () => {
  while (cleanup.length > 0) {
    const dir = cleanup.pop();
    if (dir) await rm(dir, { recursive: true, force: true });
  }
});

async function tempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'canopy-config-'));
  cleanup.push(dir);
  return dir;
}

describe('CanopyConfigSchema', () => {
  it('fills in defaults for an empty object', () => {
    const config = CanopyConfigSchema.parse({});
    expect(config.crawl.maxPages).toBe(500);
    expect(config.crawl.allowPrivateNetworks).toBe(false);
    expect(config.audit.profile).toBe('ada');
    expect(config.audit.maxTabs).toBe(100);
    expect(config.browser.name).toBe('chromium');
    expect(config.browser.headless).toBe(true);
    expect(config.browser.viewport).toEqual({ width: 1440, height: 900 });
    expect(config.output.dir).toBe('.canopy');
  });

  it('keeps valid overrides and fills the rest', () => {
    const config = CanopyConfigSchema.parse({
      crawl: { maxPages: 25 },
      browser: { name: 'chrome', viewport: { width: 1280 } },
    });
    expect(config.crawl.maxPages).toBe(25);
    expect(config.crawl.maxDepth).toBe(5);
    expect(config.browser.name).toBe('chrome');
    expect(config.browser.viewport).toEqual({ width: 1280, height: 900 });
  });

  it('rejects invalid values', () => {
    expect(() => CanopyConfigSchema.parse({ crawl: { maxPages: 0 } })).toThrow();
    expect(() => CanopyConfigSchema.parse({ crawl: { concurrency: 50 } })).toThrow();
    expect(() => CanopyConfigSchema.parse({ browser: { name: 'firefox' } })).toThrow();
    expect(() => CanopyConfigSchema.parse({ browser: { viewport: { width: 100 } } })).toThrow();
    expect(() => CanopyConfigSchema.parse({ audit: { maxTabs: 5000 } })).toThrow();
  });

  it('exposes an independent default object', () => {
    const copy = structuredClone(DEFAULT_CONFIG);
    copy.crawl.maxPages = 1;
    expect(DEFAULT_CONFIG.crawl.maxPages).toBe(500);
  });
});

describe('loadConfig', () => {
  it('throws when an explicit config path does not exist', () => {
    const dir = join(tmpdir(), 'canopy-definitely-missing-config', 'nope.json');
    expect(() => loadConfig(dir)).toThrow();
  });
});

describe('findConfig', () => {
  it('finds a config in a parent directory', async () => {
    const root = await tempDir();
    const nested = join(root, 'a', 'b');
    const { mkdir } = await import('node:fs/promises');
    await mkdir(nested, { recursive: true });
    await writeFile(join(root, 'canopy.config.json'), '{}\n', 'utf8');

    expect(findConfig(nested)).toBe(join(root, 'canopy.config.json'));
  });

  it('returns null when no config exists', async () => {
    const root = await tempDir();
    // The temp directory has no config and its parents should not either.
    expect(findConfig(root)).toBeNull();
  });

  it('loads and validates an explicit config file', async () => {
    const root = await tempDir();
    const path = join(root, 'canopy.config.json');
    await writeFile(path, JSON.stringify({ crawl: { maxPages: 12 } }), 'utf8');

    const { config, path: loadedPath } = loadConfig(path);
    expect(loadedPath).toBe(path);
    expect(config.crawl.maxPages).toBe(12);
    expect(config.browser.headless).toBe(true);
  });
});
