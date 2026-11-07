import { chromium, type Browser } from 'playwright';
import type { CanopyConfig } from './config.js';

type BrowserName = CanopyConfig['browser']['name'];

interface Attempt {
  name: BrowserName;
  channel?: 'chrome' | 'msedge';
}

export interface LaunchResult {
  browser: Browser;
  used: BrowserName;
}

export async function launchBrowser(config: CanopyConfig): Promise<LaunchResult> {
  const requested = config.browser.name;
  const channel: 'chrome' | 'msedge' | undefined =
    requested === 'chrome' ? 'chrome' : requested === 'msedge' ? 'msedge' : undefined;

  const attempts: Attempt[] = [{ name: requested, ...(channel ? { channel } : {}) }];

  if (requested === 'chromium') {
    attempts.push({ name: 'chrome', channel: 'chrome' });
  } else {
    attempts.push({ name: 'chromium' });
  }

  let lastError: unknown;

  for (const attempt of attempts) {
    try {
      const browser = await chromium.launch({
        headless: config.browser.headless,
        ...(attempt.channel ? { channel: attempt.channel } : {}),
        args: ['--no-first-run', '--no-default-browser-check'],
      });

      return { browser, used: attempt.name };
    } catch (error) {
      lastError = error;
    }
  }

  const detail = lastError instanceof Error ? lastError.message : String(lastError);
  throw new Error(
    `Unable to launch a browser. Run "pnpm exec playwright install chromium" or install Google Chrome. Last error: ${detail}`,
  );
}
