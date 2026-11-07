import { createRequire } from 'node:module';
import type { Page } from 'playwright';
import type { CanopyConfig } from './config.js';
import type { Impact, Issue } from './types.js';

const require = createRequire(import.meta.url);
const AXE_PATH = require.resolve('axe-core/axe.min.js');

export interface AxeRawNode {
  target: string[];
  html: string;
  failureSummary?: string;
  impact?: string | null;
}

export interface AxeRawViolation {
  id: string;
  impact?: string | null;
  description: string;
  help: string;
  helpUrl: string;
  tags: string[];
  nodes: AxeRawNode[];
}

export interface AxeRawResults {
  violations: AxeRawViolation[];
  passes?: unknown[];
  incomplete?: unknown[];
  inapplicable?: unknown[];
}

const PROFILE_TAGS: Record<CanopyConfig['audit']['profile'], string[]> = {
  ada: ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa', 'section508'],
  wcag22aa: ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'],
  'best-practice': ['best-practice'],
};

export function axeTagsForConfig(config: CanopyConfig): string[] {
  const tags = [...PROFILE_TAGS[config.audit.profile]];
  if (config.audit.includeBestPractices) tags.push('best-practice');
  return [...new Set(tags)];
}

async function runOnce(page: Page, tags: string[]): Promise<AxeRawResults> {
  return (await page.evaluate(async (values) => {
    const axe = (
      window as unknown as {
        axe?: {
          run: (context: Document, options: unknown) => Promise<unknown>;
        };
      }
    ).axe;

    if (!axe) throw new Error('axe-core was not injected into the page.');

    return axe.run(document, {
      runOnly: { type: 'tag', values },
      resultTypes: ['violations'],
    });
  }, tags)) as AxeRawResults;
}

export async function runAxe(
  page: Page,
  config: CanopyConfig,
): Promise<{ raw: AxeRawResults; issues: Issue[] }> {
  const tags = axeTagsForConfig(config);
  await page.addScriptTag({ path: AXE_PATH });

  let raw: AxeRawResults;
  try {
    raw = await runOnce(page, tags);
  } catch (error) {
    if (!tags.includes('section508')) throw error;
    raw = await runOnce(
      page,
      tags.filter((tag) => tag !== 'section508'),
    );
  }

  return { raw, issues: normalizeAxeViolations(raw.violations) };
}

function toImpact(value: string | null | undefined): Impact {
  if (value === 'minor' || value === 'moderate' || value === 'serious' || value === 'critical') {
    return value;
  }
  return 'moderate';
}

function normalizeAxeViolations(violations: AxeRawViolation[]): Issue[] {
  return violations.map((violation) => ({
    source: 'axe',
    ruleId: violation.id,
    impact: toImpact(violation.impact),
    description: violation.description,
    help: violation.help,
    helpUrl: violation.helpUrl,
    tags: violation.tags,
    nodes: violation.nodes.slice(0, 100).map((node) => ({
      target: node.target,
      html: node.html,
      ...(node.failureSummary ? { failureSummary: node.failureSummary } : {}),
    })),
  }));
}
