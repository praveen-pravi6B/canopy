import type { CrawlManifest } from './types.js';

export interface PageDiff {
  url: string;
  status: 'added' | 'removed' | 'changed' | 'unchanged';
  beforeScore?: number;
  afterScore?: number;
  scoreDelta?: number;
  beforeIssues?: number;
  afterIssues?: number;
  issueDelta?: number;
  newRules?: string[];
  fixedRules?: string[];
}

export interface CrawlDiff {
  beforeId: string;
  afterId: string;
  beforeRoot: string;
  afterRoot: string;
  summary: {
    scoreDelta: number;
    adaDelta: number;
    keyboardDelta: number;
    beforeIssues: number;
    afterIssues: number;
    issueDelta: number;
    addedPages: number;
    removedPages: number;
    changedPages: number;
  };
  pages: PageDiff[];
  newRules: string[];
  fixedRules: string[];
}

function ruleSet(manifest: CrawlManifest, url: string): Set<string> {
  const page = manifest.pages.find((item) => item.url === url);
  return new Set((page?.issues ?? []).map((issue) => `${issue.source}:${issue.ruleId}`));
}

export function diffCrawls(before: CrawlManifest, after: CrawlManifest): CrawlDiff {
  const urls = new Set([...before.pages.map((p) => p.url), ...after.pages.map((p) => p.url)]);
  const pages: PageDiff[] = [];
  const globalNew = new Set<string>();
  const globalFixed = new Set<string>();

  for (const url of [...urls].sort()) {
    const a = before.pages.find((p) => p.url === url);
    const b = after.pages.find((p) => p.url === url);

    if (!a && b) {
      pages.push({ url, status: 'added', afterScore: b.scores.overall, afterIssues: b.issues.length });
      for (const issue of b.issues) globalNew.add(`${issue.source}:${issue.ruleId}`);
      continue;
    }
    if (a && !b) {
      pages.push({ url, status: 'removed', beforeScore: a.scores.overall, beforeIssues: a.issues.length });
      for (const issue of a.issues) globalFixed.add(`${issue.source}:${issue.ruleId}`);
      continue;
    }
    if (!a || !b) continue;

    const beforeRules = ruleSet(before, url);
    const afterRules = ruleSet(after, url);
    const newRules = [...afterRules].filter((r) => !beforeRules.has(r)).sort();
    const fixedRules = [...beforeRules].filter((r) => !afterRules.has(r)).sort();
    for (const r of newRules) globalNew.add(r);
    for (const r of fixedRules) globalFixed.add(r);

    const changed =
      a.scores.overall !== b.scores.overall ||
      a.issues.length !== b.issues.length ||
      newRules.length > 0 ||
      fixedRules.length > 0;

    pages.push({
      url,
      status: changed ? 'changed' : 'unchanged',
      beforeScore: a.scores.overall,
      afterScore: b.scores.overall,
      scoreDelta: b.scores.overall - a.scores.overall,
      beforeIssues: a.issues.length,
      afterIssues: b.issues.length,
      issueDelta: b.issues.length - a.issues.length,
      ...(newRules.length ? { newRules } : {}),
      ...(fixedRules.length ? { fixedRules } : {}),
    });
  }

  const beforeIssues = before.pages.reduce((n, p) => n + p.issues.length, 0);
  const afterIssues = after.pages.reduce((n, p) => n + p.issues.length, 0);

  return {
    beforeId: before.id,
    afterId: after.id,
    beforeRoot: before.rootUrl,
    afterRoot: after.rootUrl,
    summary: {
      scoreDelta: after.summary.overallScore - before.summary.overallScore,
      adaDelta: after.summary.adaScore - before.summary.adaScore,
      keyboardDelta: after.summary.keyboardScore - before.summary.keyboardScore,
      beforeIssues,
      afterIssues,
      issueDelta: afterIssues - beforeIssues,
      addedPages: pages.filter((p) => p.status === 'added').length,
      removedPages: pages.filter((p) => p.status === 'removed').length,
      changedPages: pages.filter((p) => p.status === 'changed').length,
    },
    pages,
    newRules: [...globalNew].sort(),
    fixedRules: [...globalFixed].sort(),
  };
}
