import { countIssues, overallScore, scoreIssues } from './score.js';
import type { CrawlManifest, CrawledPage, IgnoreCategory, IgnoreRule, Issue } from './types.js';

export interface IgnoreMatch {
  rule: IgnoreRule;
  issue: Issue;
}

export interface AppliedIgnoreResult<T extends CrawlManifest | CrawledPage> {
  value: T;
  ignoredCount: number;
  ignoredByRule: Array<{ ruleId: number; count: number }>;
}

function escapeRegex(value: string): string {
  return value.replace(/[.+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Match a URL against an ignore pattern.
 * - `*` matches any sequence except nothing special (path/glob-style)
 * - `**` matches across segments
 * - patterns without a scheme are matched against the URL path+search
 * - full URLs are matched against the full normalized URL
 */
export function matchesIgnorePattern(pattern: string, url: string): boolean {
  const trimmed = pattern.trim();
  if (!trimmed) return false;

  let target = url;
  let source = trimmed;

  const hasScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed);
  if (!hasScheme) {
    try {
      const parsed = new URL(url);
      target = parsed.pathname + parsed.search;
    } catch {
      target = url;
    }
    // Treat a bare path pattern as anchored to the path.
    if (!source.startsWith('/')) source = `/${source}`;
  }

  const DOUBLE = '\u0000DS\u0000';
  const withDouble = source.replace(/\*\*/g, DOUBLE);
  const parts = withDouble.split('*').map((part) => escapeRegex(part));
  // * and ** both match any characters except ? and # (URL-friendly glob).
  const escaped = parts.join('[^?#]*').replace(new RegExp(escapeRegex(DOUBLE), 'g'), '[^?#]*');

  try {
    return new RegExp(`^${escaped}$`).test(target);
  } catch {
    return target === source;
  }
}

export function issueCategory(issue: Issue): 'ada' | 'keyboard' {
  return issue.source === 'keyboard' ? 'keyboard' : 'ada';
}

export function ruleApplies(rule: IgnoreRule, issue: Issue): boolean {
  if (rule.category === 'all') return true;
  return rule.category === issueCategory(issue);
}

export function applyIgnoreRulesToIssues(
  issues: Issue[],
  url: string,
  rules: IgnoreRule[],
): { kept: Issue[]; ignored: IgnoreMatch[] } {
  const matchingRules = rules.filter((rule) => matchesIgnorePattern(rule.pattern, url));
  if (matchingRules.length === 0) return { kept: issues, ignored: [] };

  const kept: Issue[] = [];
  const ignored: IgnoreMatch[] = [];

  for (const issue of issues) {
    const rule = matchingRules.find((candidate) => ruleApplies(candidate, issue));
    if (rule) ignored.push({ rule, issue });
    else kept.push(issue);
  }

  return { kept, ignored };
}

function recomputePage(page: CrawledPage): CrawledPage {
  const adaIssues = page.issues.filter((issue) => issueCategory(issue) === 'ada');
  const keyboardIssues = page.issues.filter((issue) => issueCategory(issue) === 'keyboard');
  const ada = scoreIssues(adaIssues);
  const keyboard = scoreIssues(keyboardIssues);

  return {
    ...page,
    keyboardFindings: keyboardIssues.length,
    scores: { ada, keyboard, overall: overallScore(ada, keyboard) },
    issueCounts: countIssues(page.issues),
  };
}

export function applyIgnoreRulesToPage(
  page: CrawledPage,
  rules: IgnoreRule[],
): AppliedIgnoreResult<CrawledPage> & { ignored: IgnoreMatch[] } {
  const { kept, ignored } = applyIgnoreRulesToIssues(page.issues, page.url, rules);
  const ignoredIssues: Issue[] = ignored.map((match) => ({
    ...match.issue,
    tags: [...new Set([...match.issue.tags, 'ignored'])],
    // Keep ignored issues for transparency in manifests; the UI can dim them.
  }));

  const updated = recomputePage({
    ...page,
    issues: kept,
  });

  // Preserve ignored issues in a separate list by attaching to tags/data via the
  // manifest notice pattern is not enough; instead expose through return value.
  // Callers can choose to keep or drop them. We keep `kept` as active issues.
  void ignoredIssues;

  const byRule = new Map<number, number>();
  for (const match of ignored) byRule.set(match.rule.id, (byRule.get(match.rule.id) ?? 0) + 1);

  return {
    value: updated,
    ignoredCount: ignored.length,
    ignoredByRule: [...byRule.entries()].map(([ruleId, count]) => ({ ruleId, count })),
    ignored,
  };
}

export function applyIgnoreRulesToManifest(
  manifest: CrawlManifest,
  rules: IgnoreRule[],
): AppliedIgnoreResult<CrawlManifest> & { ignoredIssuesByPage: Record<string, Issue[]> } {
  let ignoredCount = 0;
  const byRule = new Map<number, number>();
  const ignoredIssuesByPage: Record<string, Issue[]> = {};
  const pages: CrawledPage[] = [];

  for (const page of manifest.pages) {
    const result = applyIgnoreRulesToPage(page, rules);
    pages.push(result.value);
    ignoredCount += result.ignoredCount;
    if (result.ignored.length > 0) {
      ignoredIssuesByPage[page.url] = result.ignored.map((match) => ({
        ...match.issue,
        tags: [...new Set([...match.issue.tags, 'ignored', `ignore-rule:${match.rule.id}`])],
      }));
    }
    for (const entry of result.ignoredByRule) {
      byRule.set(entry.ruleId, (byRule.get(entry.ruleId) ?? 0) + entry.count);
    }
  }

  const audited = pages.filter((page) => page.audited);
  const avg = (values: number[]): number =>
    values.length === 0 ? 0 : Math.round(values.reduce((a, b) => a + b, 0) / values.length);
  const summaryIssues = audited.flatMap((page) => page.issues);
  const adaScore = avg(audited.map((page) => page.scores.ada));
  const keyboardScore = avg(audited.map((page) => page.scores.keyboard));

  const notices = [...manifest.notices];
  if (ignoredCount > 0) {
    notices.push(`Ignored ${ignoredCount} finding(s) across ${Object.keys(ignoredIssuesByPage).length} page(s) based on ${rules.length} rule(s).`);
  }

  return {
    value: {
      ...manifest,
      pages,
      stats: {
        ...manifest.stats,
        // Keep crawled counts; issue-related stats are reflected in summary/scores.
      },
      summary: {
        adaScore,
        keyboardScore,
        overallScore: overallScore(adaScore, keyboardScore),
        issueCounts: countIssues(summaryIssues),
        keyboardFindings: audited.reduce((total, page) => total + page.keyboardFindings, 0),
      },
      notices,
    },
    ignoredCount,
    ignoredByRule: [...byRule.entries()].map(([ruleId, count]) => ({ ruleId, count })),
    ignoredIssuesByPage,
  };
}
