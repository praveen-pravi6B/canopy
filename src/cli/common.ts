import pc from 'picocolors';
import type { CanopyConfig } from '../core/config.js';
import { IMPACT_ORDER } from '../core/score.js';
import type { Impact, Issue } from '../core/types.js';

const BROWSERS = new Set(['chromium', 'chrome', 'msedge']);
const FAIL_ON = new Set(['none', 'minor', 'moderate', 'serious', 'critical']);

const PROFILES = new Set(['ada', 'wcag22aa', 'best-practice']);

export interface CommonCliOptions {
  browser?: string;
  headed?: boolean;
  out?: string;
  timeout?: string;
  viewport?: string;
  ignoreHttpsErrors?: boolean;
  allowPrivate?: boolean;
  screenshot?: boolean;
  dom?: boolean;
  auth?: string;
  authState?: string;
  authLoginUrl?: string;
  profile?: string;
  bestPractices?: boolean;
  maxTabs?: string;
}

export function applyCommonOptions(config: CanopyConfig, options: CommonCliOptions): void {
  if (options.browser) {
    if (!BROWSERS.has(options.browser)) {
      throw new Error('--browser must be chromium, chrome, or msedge.');
    }
    config.browser.name = options.browser as 'chromium' | 'chrome' | 'msedge';
  }

  if (options.headed) config.browser.headless = false;
  if (options.out) config.output.dir = options.out;

  if (options.timeout) {
    const timeout = Number(options.timeout);
    if (!Number.isFinite(timeout) || timeout < 1000) {
      throw new Error('--timeout must be a number of milliseconds >= 1000.');
    }
    config.browser.timeoutMs = Math.floor(timeout);
  }

  if (options.viewport) config.browser.viewport = parseViewport(options.viewport);
  if (options.ignoreHttpsErrors) config.browser.ignoreHTTPSErrors = true;
  if (options.allowPrivate) config.crawl.allowPrivateNetworks = true;
  if (options.screenshot === false) config.output.screenshots = false;
  if (options.dom === false) config.output.domSnapshots = false;
  if (options.auth) config.auth.recipe = options.auth;
  if (options.authState) config.auth.statePath = options.authState;
  if (options.authLoginUrl) config.auth.loginUrl = options.authLoginUrl;
  if (options.profile) {
    if (!PROFILES.has(options.profile)) {
      throw new Error('--profile must be ada, wcag22aa, or best-practice.');
    }
    config.audit.profile = options.profile as CanopyConfig['audit']['profile'];
  }
  if (options.bestPractices !== undefined) config.audit.includeBestPractices = options.bestPractices;
  if (options.maxTabs) config.audit.maxTabs = parsePositiveInteger(options.maxTabs, '--max-tabs', 1000);
}

export function parseViewport(value: string): { width: number; height: number } {
  const match = /^(\d+)x(\d+)$/i.exec(value.trim());
  if (!match) throw new Error('--viewport must look like 1440x900.');

  const width = Number(match[1]);
  const height = Number(match[2]);

  if (!Number.isFinite(width) || !Number.isFinite(height) || width < 320 || height < 240) {
    throw new Error('--viewport width must be >= 320 and height >= 240.');
  }

  return { width: Math.floor(width), height: Math.floor(height) };
}

export function parsePositiveInteger(value: string, flag: string, max: number): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > max) {
    throw new Error(`${flag} must be an integer between 1 and ${max}.`);
  }
  return parsed;
}

export function parseFailOn(value: string | undefined): 'none' | Impact {
  const failOn = value ?? 'none';
  if (!FAIL_ON.has(failOn)) {
    throw new Error('--fail-on must be none, minor, moderate, serious, or critical.');
  }
  return failOn as 'none' | Impact;
}

export function issuesFail(issues: Issue[], failOn: 'none' | Impact): boolean {
  if (failOn === 'none') return false;
  const minimum = IMPACT_ORDER[failOn];
  return issues.some((issue) => IMPACT_ORDER[issue.impact] >= minimum);
}

export function formatScore(score: number): string {
  const text = `${score}/100`;
  if (score >= 90) return pc.green(text);
  if (score >= 70) return pc.yellow(text);
  return pc.red(text);
}

export function formatCounts(counts: Record<Impact, number>): string {
  return (['critical', 'serious', 'moderate', 'minor'] as const)
    .map((impact) => `${counts[impact]} ${impact}`)
    .join(pc.dim(' · '));
}
