import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  AuthError,
  AuthRecipeSchema,
  defaultAuthStatePath,
  detectAuthExpiry,
  interpolateEnv,
  loadAuthRecipe,
  readStorageState,
  resolveAuthStatePath,
} from '../src/core/auth.js';
import { CanopyConfigSchema } from '../src/core/config.js';

const tempDirs: string[] = [];

async function tempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'canopy-auth-'));
  tempDirs.push(dir);
  return dir;
}

afterEach(async () => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) await rm(dir, { recursive: true, force: true });
  }
});

describe('interpolateEnv', () => {
  it('resolves variables and fallbacks', () => {
    expect(interpolateEnv('hello ${NAME}', { NAME: 'ada' })).toBe('hello ada');
    expect(interpolateEnv('${MISSING:-fallback}', {})).toBe('fallback');
  });

  it('never silently blanks a missing secret', () => {
    expect(() => interpolateEnv('${MISSING}', {})).toThrow(AuthError);
    expect(() => interpolateEnv('${MISSING}', {})).toThrow(/MISSING/);
  });
});

describe('loadAuthRecipe', () => {
  it('parses YAML and resolves environment placeholders', async () => {
    const dir = await tempDir();
    const path = join(dir, 'auth.yml');
    await writeFile(
      path,
      `login:
  url: https://example.com/login
  steps:
    - fill: { selector: "#email", value: "\${CANOPY_USER}" }
    - fill: { selector: "#password", value: "\${CANOPY_PASS}" }
    - click: { selector: "button[type=submit]" }
    - press: { key: Enter }
  success:
    waitForUrl: /dashboard
`,
      'utf8',
    );

    const recipe = await loadAuthRecipe(path, {
      CANOPY_USER: 'ada@example.com',
      CANOPY_PASS: 'correct horse',
    });

    expect(recipe.login.steps).toHaveLength(4);
    expect(recipe.login.success.waitForUrl).toBe('/dashboard');

    const fill = recipe.login.steps[0];
    expect(fill && 'fill' in fill ? fill.fill.value : null).toBe('ada@example.com');
  });

  it('accepts JSON recipes', async () => {
    const dir = await tempDir();
    const path = join(dir, 'auth.json');
    await writeFile(
      path,
      JSON.stringify({ login: { url: 'https://example.com/login', steps: [] } }),
      'utf8',
    );

    const recipe = await loadAuthRecipe(path, {});
    expect(recipe.login.url).toBe('https://example.com/login');
    expect(recipe.login.steps).toEqual([]);
  });

  it('reports a missing recipe file', async () => {
    await expect(loadAuthRecipe('/no/such/recipe.yml')).rejects.toThrow(/not found/);
  });

  it('rejects unknown step shapes', () => {
    const result = AuthRecipeSchema.safeParse({
      login: { url: 'https://example.com/login', steps: [{ jump: { selector: 'a' } }] },
    });
    expect(result.success).toBe(false);
  });
});

describe('state paths', () => {
  it('derives a safe per-recipe state path', () => {
    expect(defaultAuthStatePath('.canopy', 'recipes/staging auth.yml')).toBe(
      resolve('.canopy', 'auth', 'staging-auth.storage.json'),
    );
  });

  it('prefers an explicit config path over the recipe path', () => {
    const config = CanopyConfigSchema.parse({
      output: { dir: '.canopy' },
      auth: { statePath: '/tmp/session.json' },
    });
    expect(resolveAuthStatePath(config, 'auth.yml', '/tmp/recipe-state.json')).toBe(
      resolve('/tmp/session.json'),
    );
  });

  it('reads valid storage state and rejects junk', async () => {
    const dir = await tempDir();
    const good = join(dir, 'good.json');
    await writeFile(
      good,
      JSON.stringify({ cookies: [], origins: [], extra: true }),
      'utf8',
    );
    expect(await readStorageState(good)).toEqual({ cookies: [], origins: [] });

    const bad = join(dir, 'bad.json');
    await writeFile(bad, '{"cookies": "nope"}', 'utf8');
    expect(await readStorageState(bad)).toBeNull();
    expect(await readStorageState(join(dir, 'missing.json'))).toBeNull();
  });
});

describe('detectAuthExpiry', () => {
  const loginUrl = 'https://example.com/login';

  it('treats 401 and 403 as expired', () => {
    expect(detectAuthExpiry('https://example.com/dashboard', 401, loginUrl)).toBe(true);
    expect(detectAuthExpiry('https://example.com/dashboard', 403, loginUrl)).toBe(true);
  });

  it('catches redirects back to the login page', () => {
    expect(detectAuthExpiry('https://example.com/login', 200, loginUrl)).toBe(true);
    expect(detectAuthExpiry('https://example.com/login/', 200, loginUrl)).toBe(true);
  });

  it('does not flag healthy pages or lookalike paths', () => {
    expect(detectAuthExpiry('https://example.com/dashboard', 200, loginUrl)).toBe(false);
    expect(detectAuthExpiry('https://example.com/login-help', 200, loginUrl)).toBe(false);
    expect(detectAuthExpiry('https://other.example/login', 200, loginUrl)).toBe(false);
    expect(detectAuthExpiry('https://example.com/dashboard', 200, null)).toBe(false);
  });
});
