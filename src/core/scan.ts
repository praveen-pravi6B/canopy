import { join } from 'node:path';
import type { Browser, BrowserContext } from 'playwright';
import { auditLoadedPage } from './audit.js';
import { launchBrowser } from './browser.js';
import type { CanopyConfig } from './config.js';
import { emptyKeyboardResult } from './keyboard.js';
import { countIssues } from './score.js';
import { createRunDirectory, writeJson } from './storage.js';
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
      userAgent: 'CanopyBot/0.1',
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

    const pageResult = await auditLoadedPage({
      page,
      targetUrl: target.toString(),
      response,
      runDir: run.dir,
      artifactDir: run.dir,
      config: options.config,
      startedMs,
      ...(options.onEvent ? { onEvent: options.onEvent } : {}),
    });

    const manifest: RunManifest = {
      schemaVersion: 1,
      id: run.id,
      toolVersion: options.toolVersion,
      targetUrl: target.toString(),
      config: options.config,
      page: pageResult,
      summary: {
        adaScore: pageResult.scores.ada,
        keyboardScore: pageResult.scores.keyboard,
        overallScore: pageResult.scores.overall,
        issueCounts: countIssues(pageResult.issues),
        keyboardFindings: pageResult.keyboard.findings.length,
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
