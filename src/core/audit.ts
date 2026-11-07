import { join } from 'node:path';
import type { Page, Response } from 'playwright';
import { runAxe } from './axe.js';
import type { CanopyConfig } from './config.js';
import { keyboardFindingsToIssues, probeKeyboard } from './keyboard.js';
import { overallScore, scoreIssues } from './score.js';
import { relativeArtifact, writeJson, writeText } from './storage.js';
import type { Issue, IssueRect, PageScanResult } from './types.js';

export interface AuditPageOptions {
  page: Page;
  targetUrl: string;
  response: Response | null;
  runDir: string;
  artifactDir: string;
  config: CanopyConfig;
  startedMs?: number;
  onEvent?: (message: string) => void;
}

export function redactHeaders(headers: Record<string, string>): Record<string, string> {
  const sensitive = /cookie|authorization|token|secret|set-cookie/i;
  const result: Record<string, string> = {};

  for (const [key, value] of Object.entries(headers)) {
    result[key] = sensitive.test(key) ? '[redacted]' : value;
  }

  return result;
}

/**
 * Audit a page that is already loaded in a Playwright page. Shared by the
 * single-page scanner and the crawler so both produce identical findings.
 */
export async function auditLoadedPage(options: AuditPageOptions): Promise<PageScanResult> {
  const { page, config, runDir, artifactDir } = options;
  const startedMs = options.startedMs ?? Date.now();
  const startedAt = new Date(startedMs).toISOString();

  const finalUrl = page.url();
  const title = await page.title();
  const metaRobots = await page.evaluate(
    () => document.querySelector('meta[name="robots"]')?.getAttribute('content') ?? null,
  );

  let headers: Record<string, string> = {};
  if (options.response) {
    try {
      headers = redactHeaders(await options.response.allHeaders());
    } catch {
      headers = {};
    }
  }

  const html = await page.content();
  const artifacts: PageScanResult['artifacts'] = {};

  if (config.output.screenshots) {
    const screenshotPath = join(artifactDir, 'screenshot.png');
    await page.screenshot({ path: screenshotPath, fullPage: true, animations: 'disabled' });
    artifacts.screenshot = relativeArtifact(runDir, screenshotPath);
  }

  if (config.output.domSnapshots) {
    const domPath = join(artifactDir, 'page.html');
    await writeText(domPath, html);
    artifacts.dom = relativeArtifact(runDir, domPath);
  }

  options.onEvent?.('Running axe-core');
  const axe = await runAxe(page, config);
  await annotateIssueRects(page, axe.issues);
  const axePath = join(artifactDir, 'axe.json');
  await writeJson(axePath, axe.raw);
  artifacts.axe = relativeArtifact(runDir, axePath);

  options.onEvent?.('Probing keyboard navigation');
  const keyboard = await probeKeyboard(page, config.audit.maxTabs);
  const keyboardPath = join(artifactDir, 'keyboard.json');
  await writeJson(keyboardPath, keyboard);
  artifacts.keyboard = relativeArtifact(runDir, keyboardPath);

  const keyboardIssues = keyboardFindingsToIssues(keyboard);
  await annotateIssueRects(page, keyboardIssues);
  const issues = [...axe.issues, ...keyboardIssues];
  const adaScore = scoreIssues(axe.issues);
  const keyboardScore = scoreIssues(keyboardIssues);
  const finishedMs = Date.now();

  return {
    url: options.targetUrl,
    finalUrl,
    status: options.response?.status() ?? null,
    title,
    metaRobots,
    headers,
    issues,
    keyboard,
    scores: { ada: adaScore, keyboard: keyboardScore, overall: overallScore(adaScore, keyboardScore) },
    artifacts,
    timings: {
      startedAt,
      finishedAt: new Date(finishedMs).toISOString(),
      durationMs: finishedMs - startedMs,
    },
  };
}

async function annotateIssueRects(page: Page, issues: Issue[]): Promise<void> {
  const selectors: Array<{ issue: number; node: number; selector: string }> = [];

  issues.forEach((issue, issueIndex) => {
    issue.nodes.forEach((node, nodeIndex) => {
      const selector = node.target[0];
      if (selector) selectors.push({ issue: issueIndex, node: nodeIndex, selector });
    });
  });

  if (selectors.length === 0) return;

  // Cap to avoid huge evaluate payloads on noisy pages.
  const batch = selectors.slice(0, 300);

  let rects: Array<IssueRect | null>;
  try {
    rects = await page.evaluate((inputs) => {
      const toRect = (el: Element): { x: number; y: number; width: number; height: number } | null => {
        const r = el.getBoundingClientRect();
        if (r.width <= 0 && r.height <= 0) return null;
        return {
          x: Math.round(r.left + window.scrollX),
          y: Math.round(r.top + window.scrollY),
          width: Math.round(r.width),
          height: Math.round(r.height),
        };
      };

      return inputs.map((input) => {
        try {
          // Axe selectors can target shadow DOM via nested arrays; we only
          // handle simple top-level selectors here (best-effort).
          if (input.selector.includes(' >> ') || input.selector.startsWith('/')) return null;
          const el = document.querySelector(input.selector);
          return el ? toRect(el) : null;
        } catch {
          return null;
        }
      });
    }, batch.map((item) => ({ selector: item.selector })));
  } catch {
    return;
  }

  batch.forEach((item, index) => {
    const rect = rects[index];
    if (rect) {
      const node = issues[item.issue]?.nodes[item.node];
      if (node) node.rect = rect;
    }
  });
}
