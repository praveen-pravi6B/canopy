import type { Browser, BrowserContext } from 'playwright';
import { AuthError, loadAuthRecipe, readStorageState, resolveAuthStatePath, runLogin, saveStorageState } from './auth.js';
import { launchBrowser } from './browser.js';
import type { CanopyConfig } from './config.js';
import { USER_AGENT } from './version.js';

export interface OpenSessionOptions {
  config: CanopyConfig;
  onEvent?: (message: string) => void;
}

export interface AuthSession {
  browser: Browser;
  context: BrowserContext;
  loginUrl: string | null;
  statePath: string | null;
  authenticated: boolean;
}

/**
 * Launch a browser context, optionally authenticated. A recipe always performs
 * a fresh login and then persists the session state (mode 0600). A state file
 * without a recipe reuses an existing session, for MFA/captcha captures.
 */
export async function openSession(options: OpenSessionOptions): Promise<AuthSession> {
  const { config } = options;
  const recipePath = config.auth.recipe;
  const recipe = recipePath ? await loadAuthRecipe(recipePath) : null;
  const statePath = resolveAuthStatePath(config, recipePath, recipe?.statePath);

  const storedState = !recipe && statePath ? await readStorageState(statePath) : null;
  if (!recipe && statePath && !storedState) {
    throw new AuthError(
      `Session state not found or unreadable: ${statePath}. Run "canopy auth capture" first.`,
    );
  }

  options.onEvent?.('Launching browser');
  const launched = await launchBrowser(config);

  try {
    const context = await launched.browser.newContext({
      viewport: config.browser.viewport,
      ignoreHTTPSErrors: config.browser.ignoreHTTPSErrors,
      acceptDownloads: false,
      userAgent: USER_AGENT,
      ...(storedState ? { storageState: storedState } : {}),
    });

    const loginUrl = recipe?.login.url ?? config.auth.loginUrl ?? null;

    if (recipe) {
      options.onEvent?.('Logging in with the auth recipe');
      await runLogin({
        recipe,
        context,
        ...(options.onEvent ? { onEvent: options.onEvent } : {}),
      });

      if (statePath) {
        await saveStorageState(context, statePath);
        options.onEvent?.(`Saved session state to ${statePath}`);
      }
    } else if (storedState) {
      options.onEvent?.('Using the saved session state');
    }

    return {
      browser: launched.browser,
      context,
      loginUrl,
      statePath,
      authenticated: Boolean(recipe || storedState),
    };
  } catch (error) {
    await launched.browser.close().catch(() => undefined);
    throw error;
  }
}
