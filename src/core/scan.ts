import { join } from 'node:path';
import type { Browser, BrowserContext } from 'playwright';
import { runAxe } from './axe.js';
import { launchBrowser } from './browser.js';
import type { CanopyConfig } from './config.js';
import { emptyKeyboardResult, keyboardFindingsToIssues, probeKeyboard } from './keyboard.js';
import { countIssues, overallScore, scoreIssues } from './score.js';
import { createRunDirectory, relativeArtifact, writeJson, writeText } from './storage.js';
import type { PageScanResult, RunManifest } from './types.js';
import { assertSafeTarget, parseTargetUrl } from './url.js';

export interface ScanPageOptions {
  url: string;
  config: CanopyConfig;
  toolVersion: string;
  onEvent?: (message: string) => void;
}

export interface ScanPageResult {
  manifest: RunManifest;
  runDir: string;
  manifestPath: string;
}

export async function scanPage(options: ScanPageOptions): Promise<ScanPageResult> {
  const target = parseTargetUrl(options.url);
  await assertSafeTarget(target, {
    allowPrivate: options.config.crawl.allowPrivateNetworks,
  });

  const startedMs = Date.now();
  const startedAt = new Date(startedMs).toISOString();
  const run = await createRunDirectory(options.config.output.dir, target.toString());
  const manifestPath = join(run.dir, 'summary.json');

  let browser: Browser | undefined;
  let context: BrowserContext | undefined;

  try {
    options.onEvent?.('Launching browser');
    const launched = await launchBrowser(options.config);
    browser = launched.browser;

    context = await browser.newContext({
      viewport: options.config.browser.viewport,
      ignoreHTTPSErrors: options.config.browser.ignoreHTTPSErrors,
      acceptDownloads: false,
      userAgent: 'CanopyBot/0.0.1',
    });

    const page = await context.newPage();
    page.on('dialog', (dialog) => {
      void dialog.dismiss();
    });
    page.setDefaultTimeout(options.config.browser.timeoutMs);
    page.setDefaultNavigationTimeout(options.config.browser.timeoutMs);

    options.onEvent?.(`Navigating to ${target.toString()}`);
    const response = await page.goto(target.toString(), {
      waitUntil: 'domcontentloaded',
      timeout: options.config.browser.timeoutMs,
    });

    await page
      .waitForLoadState('networkidle', {
        timeout: Math.min(5000, options.config.browser.timeoutMs),
      })
      .catch(() => undefined);
    await page.waitForTimeout(options.config.browser.settleMs);

    const finalUrl = page.url();
    await assertSafeTarget(new URL(finalUrl), {
      allowPrivate: options.config.crawl.allowPrivateNetworks,
    });

    const title = await page.title();
    const metaRobots = await page.evaluate(
      () => document.querySelector('meta[name="robots"]')?.getAttribute('content') ?? null,
    );

    let headers: Record<string, string> = {};
    if (response) {
      try {
        headers = redactHeaders(await response.allHeaders());
      } catch {
        headers = {};
      }
    }

    const html = await page.content();
    const artifacts: PageScanResult['artifacts'] = {};

    if (options.config.output.screenshots) {
      const screenshotPath = join(run.dir, 'screenshot.png');
      await page.screenshot({ path: screenshotPath, fullPage: true, animations: 'disabled' });
      artifacts.screenshot = relativeArtifact(run.dir, screenshotPath);
    }

    if (options.config.output.domSnapshots) {
      const domPath = join(run.dir, 'page.html');
      await writeText(domPath, html);
      artifacts.dom = relativeArtifact(run.dir, domPath);
    }

    options.onEvent?.('Running axe-core');
    const axe = await runAxe(page, options.config);
    const axePath = join(run.dir, 'axe.json');
    await writeJson(axePath, axe.raw);
    artifacts.axe = relativeArtifact(run.dir, axePath);

    options.onEvent?.('Probing keyboard navigation');
    const keyboard = await probeKeyboard(page, options.config.audit.maxTabs);
    const keyboardPath = join(run.dir, 'keyboard.json');
    await writeJson(keyboardPath, keyboard);
    artifacts.keyboard = relativeArtifact(run.dir, keyboardPath);

    const keyboardIssues = keyboardFindingsToIssues(keyboard);
    const issues = [...axe.issues, ...keyboardIssues];
    const adaScore = scoreIssues(axe.issues);
    const keyboardScore = scoreIssues(keyboardIssues);
    const overall = overallScore(adaScore, keyboardScore);
    const finishedMs = Date.now();

    const pageResult: PageScanResult = {
      url: target.toString(),
      finalUrl,
      status: response?.status() ?? null,
      title,
      metaRobots,
      headers,
      issues,
      keyboard,
      scores: { ada: adaScore, keyboard: keyboardScore, overall },
      artifacts,
      timings: {
        startedAt,
        finishedAt: new Date(finishedMs).toISOString(),
        durationMs: finishedMs - startedMs,
      },
    };

    const manifest: RunManifest = {
      schemaVersion: 1,
      id: run.id,
      toolVersion: options.toolVersion,
      targetUrl: target.toString(),
      config: options.config,
      page: pageResult,
      summary: {
        adaScore,
        keyboardScore,
        overallScore: overall,
        issueCounts: countIssues(issues),
        keyboardFindings: keyboard.findings.length,
      },
    };

    await writeJson(manifestPath, manifest);

    return { manifest, runDir: run.dir, manifestPath };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const finishedMs = Date.now();

    const errorPage: PageScanResult = {
      url: target.toString(),
      finalUrl: target.toString(),
      status: null,
      title: '',
      metaRobots: null,
      headers: {},
      issues: [],
      keyboard: emptyKeyboardResult(options.config.audit.maxTabs),
      scores: { ada: 0, keyboard: 0, overall: 0 },
      artifacts: {},
      timings: {
        startedAt,
        finishedAt: new Date(finishedMs).toISOString(),
        durationMs: finishedMs - startedMs,
      },
      error: message,
    };

    const manifest: RunManifest = {
      schemaVersion: 1,
      id: run.id,
      toolVersion: options.toolVersion,
      targetUrl: target.toString(),
      config: options.config,
      page: errorPage,
      summary: {
        adaScore: 0,
        keyboardScore: 0,
        overallScore: 0,
        issueCounts: { critical: 0, serious: 0, moderate: 0, minor: 0 },
        keyboardFindings: 0,
      },
    };

    await writeJson(manifestPath, manifest);

    return { manifest, runDir: run.dir, manifestPath };
  } finally {
    if (context) await context.close().catch(() => undefined);
    if (browser) await browser.close().catch(() => undefined);
  }
}

function redactHeaders(headers: Record<string, string>): Record<string, string> {
  const sensitive = /cookie|authorization|token|secret/i;
  const result: Record<string, string> = {};

  for (const [key, value] of Object.entries(headers)) {
    result[key] = sensitive.test(key) ? '[redacted]' : value;
  }

  return result;
}
