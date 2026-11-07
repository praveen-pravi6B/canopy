import { chmod, mkdir, readFile, writeFile } from 'node:fs/promises';
import { basename, dirname, isAbsolute, resolve } from 'node:path';
import type { BrowserContext } from 'playwright';
import { parse as parseYaml } from 'yaml';
import { z } from 'zod';
import type { CanopyConfig } from './config.js';

/**
 * Scripted-login support. Recipes are YAML or JSON. Secrets stay in the
 * environment: `${VAR}` placeholders are resolved at run time and never
 * written to the recipe or the run manifest.
 */

export class AuthError extends Error {
  readonly code = 'auth';

  constructor(message: string) {
    super(message);
    this.name = 'AuthError';
  }
}

const FillStepSchema = z.object({
  fill: z.object({ selector: z.string().min(1), value: z.string() }),
});

const ClickStepSchema = z.object({
  click: z.object({ selector: z.string().min(1) }),
});

const PressStepSchema = z.object({
  press: z.object({ selector: z.string().min(1).optional(), key: z.string().min(1) }),
});

const WaitForStepSchema = z.object({
  waitFor: z
    .object({ selector: z.string().min(1).optional(), url: z.string().min(1).optional() })
    .refine((value) => value.selector !== undefined || value.url !== undefined, {
      message: 'waitFor needs a selector or a url',
    }),
});

const GotoStepSchema = z.object({ goto: z.string().min(1) });
const DelayStepSchema = z.object({ delay: z.number().int().min(0).max(60_000) });

export const AuthStepSchema = z.union([
  FillStepSchema,
  ClickStepSchema,
  PressStepSchema,
  WaitForStepSchema,
  GotoStepSchema,
  DelayStepSchema,
]);

export const AuthRecipeSchema = z.object({
  login: z.object({
    url: z.string().min(1),
    steps: z.array(AuthStepSchema).prefault([]),
    success: z
      .object({
        waitForUrl: z.string().min(1).optional(),
        selector: z.string().min(1).optional(),
      })
      .prefault({}),
    timeoutMs: z.number().int().min(1000).max(300_000).optional(),
  }),
  statePath: z.string().min(1).optional(),
});

export type AuthRecipe = z.infer<typeof AuthRecipeSchema>;
export type AuthStep = z.infer<typeof AuthStepSchema>;

const ENV_PATTERN = /\$\{([A-Za-z_][A-Za-z0-9_]*)(?::-([^}]*))?\}/g;

/** Resolve `${VAR}` and `${VAR:-fallback}` placeholders from the environment. */
export function interpolateEnv(value: string, env: NodeJS.ProcessEnv = process.env): string {
  return value.replace(ENV_PATTERN, (_match, name: string, fallback: string | undefined) => {
    const resolved = env[name];
    if (resolved !== undefined) return resolved;
    if (fallback !== undefined) return fallback;
    throw new AuthError(`Missing environment variable ${name} required by the auth recipe.`);
  });
}

function interpolateRecipe(recipe: AuthRecipe, env: NodeJS.ProcessEnv): AuthRecipe {
  const login = recipe.login;

  return {
    ...recipe,
    login: {
      ...login,
      url: interpolateEnv(login.url, env),
      steps: login.steps.map((step) => {
        if ('fill' in step) {
          return {
            fill: {
              selector: step.fill.selector,
              value: interpolateEnv(step.fill.value, env),
            },
          };
        }
        if ('goto' in step) return { goto: interpolateEnv(step.goto, env) };
        if ('waitFor' in step) {
          return {
            waitFor: {
              ...(step.waitFor.selector ? { selector: step.waitFor.selector } : {}),
              ...(step.waitFor.url ? { url: interpolateEnv(step.waitFor.url, env) } : {}),
            },
          };
        }
        return step;
      }),
      success: {
        ...(login.success.waitForUrl
          ? { waitForUrl: interpolateEnv(login.success.waitForUrl, env) }
          : {}),
        ...(login.success.selector ? { selector: login.success.selector } : {}),
      },
      ...(login.timeoutMs !== undefined ? { timeoutMs: login.timeoutMs } : {}),
    },
  };
}

export async function loadAuthRecipe(path: string, env: NodeJS.ProcessEnv = process.env): Promise<AuthRecipe> {
  let raw: string;
  try {
    raw = await readFile(path, 'utf8');
  } catch {
    throw new AuthError(`Auth recipe not found: ${path}`);
  }

  let parsed: unknown;
  try {
    parsed = parseYaml(raw);
  } catch (error) {
    throw new AuthError(
      `Could not parse auth recipe ${path}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  const result = AuthRecipeSchema.safeParse(parsed);
  if (!result.success) {
    throw new AuthError(`Invalid auth recipe ${path}: ${result.error.issues[0]?.message ?? 'unknown error'}`);
  }

  return interpolateRecipe(result.data, env);
}

export function defaultAuthStatePath(outputDir: string, recipePath: string): string {
  const name =
    basename(recipePath)
      .replace(/\.[^.]+$/, '')
      .replace(/[^a-z0-9_-]+/gi, '-')
      .replace(/^-+|-+$/g, '') || 'auth';
  return resolve(outputDir, 'auth', `${name}.storage.json`);
}

export function resolveAuthStatePath(
  config: CanopyConfig,
  recipePath: string | null,
  recipeStatePath?: string,
): string | null {
  if (config.auth.statePath) return resolve(config.auth.statePath);
  if (recipeStatePath) return isAbsolute(recipeStatePath) ? recipeStatePath : resolve(recipeStatePath);
  if (recipePath) return defaultAuthStatePath(config.output.dir, recipePath);
  return null;
}

export type StorageState = Awaited<ReturnType<BrowserContext['storageState']>>;

export async function readStorageState(path: string): Promise<StorageState | null> {
  try {
    const parsed = JSON.parse(await readFile(path, 'utf8')) as Partial<StorageState>;
    if (!Array.isArray(parsed.cookies) || !Array.isArray(parsed.origins)) return null;
    return { cookies: parsed.cookies, origins: parsed.origins } as StorageState;
  } catch {
    return null;
  }
}

export async function saveStorageState(context: BrowserContext, path: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const state = await context.storageState();
  await writeFile(path, `${JSON.stringify(state, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
  await chmod(path, 0o600).catch(() => undefined);
}

export interface LoginOptions {
  recipe: AuthRecipe;
  context: BrowserContext;
  onEvent?: (message: string) => void;
}

function isSameOrChildPath(candidate: URL, base: URL): boolean {
  if (candidate.origin !== base.origin) return false;
  const basePath = base.pathname.replace(/\/+$/, '') || '/';
  if (basePath === '/') return true;
  return candidate.pathname === basePath || candidate.pathname === `${basePath}/`;
}

/** Heuristic: did a response land on the login screen or reject the session? */
export function detectAuthExpiry(
  finalUrl: string,
  status: number | null,
  loginUrl: string | null,
): boolean {
  if (status === 401 || status === 403) return true;
  if (!loginUrl) return false;

  try {
    return isSameOrChildPath(new URL(finalUrl), new URL(loginUrl));
  } catch {
    return false;
  }
}

export async function runLogin(options: LoginOptions): Promise<void> {
  const { recipe, context } = options;
  const login = recipe.login;
  const timeoutMs = login.timeoutMs ?? 30_000;

  options.onEvent?.(`Opening login page ${login.url}`);
  const page = await context.newPage();
  page.setDefaultTimeout(timeoutMs);
  page.setDefaultNavigationTimeout(timeoutMs);

  try {
    const response = await page.goto(login.url, { waitUntil: 'domcontentloaded' });
    if (response && response.status() >= 400) {
      throw new AuthError(`Login page returned HTTP ${response.status()}.`);
    }

    for (const step of login.steps) {
      if ('fill' in step) {
        await page.fill(step.fill.selector, step.fill.value);
        continue;
      }
      if ('click' in step) {
        await page.click(step.click.selector);
        continue;
      }
      if ('press' in step) {
        if (step.press.selector) await page.press(step.press.selector, step.press.key);
        else await page.keyboard.press(step.press.key);
        continue;
      }
      if ('waitFor' in step) {
        if (step.waitFor.selector) {
          await page.waitForSelector(step.waitFor.selector, { state: 'visible' });
        }
        if (step.waitFor.url) {
          await page.waitForURL((url) => url.toString().includes(step.waitFor.url ?? ''), {
            timeout: timeoutMs,
          });
        }
        continue;
      }
      if ('goto' in step) {
        await page.goto(step.goto, { waitUntil: 'domcontentloaded' });
        continue;
      }
      if ('delay' in step) {
        await page.waitForTimeout(step.delay);
      }
    }

    if (login.success.waitForUrl) {
      await page.waitForURL((url) => url.toString().includes(login.success.waitForUrl ?? ''), {
        timeout: timeoutMs,
      });
    }
    if (login.success.selector) {
      await page.waitForSelector(login.success.selector, { state: 'visible' });
    }
    if (!login.success.waitForUrl && !login.success.selector) {
      await page.waitForLoadState('networkidle', { timeout: Math.min(5000, timeoutMs) }).catch(() => undefined);
    }

    if (
      !login.success.waitForUrl &&
      !login.success.selector &&
      detectAuthExpiry(page.url(), null, login.url)
    ) {
      throw new AuthError('Login did not leave the login page. Check the recipe and success condition.');
    }
  } catch (error) {
    if (error instanceof AuthError) throw error;
    throw new AuthError(
      `Login failed: ${error instanceof Error ? error.message : String(error)}`,
    );
  } finally {
    await page.close().catch(() => undefined);
  }
}
