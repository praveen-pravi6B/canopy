import { describe, expect, it } from 'vitest';
import { diffCrawls } from '../src/core/diff.js';
import { findingsToCsv, summaryForExport } from '../src/core/export.js';
import type { CrawlManifest, CrawledPage, Issue } from '../src/core/types.js';

function issue(ruleId: string, impact: Issue['impact'] = 'serious'): Issue {
  return {
    source: 'axe',
    ruleId,
    impact,
    description: `${ruleId} description`,
    help: 'help',
    helpUrl: 'https://example.com/help',
    tags: ['wcag2a'],
    nodes: [{ target: ['#a'], html: '<div id="a"></div>' }],
  };
}

function page(url: string, issues: Issue[], score = 90): CrawledPage {
  return {
    url,
    finalUrl: url,
    status: 200,
    title: url,
    metaRobots: null,
    depth: 0,
    contentType: 'text/html',
    headers: {},
    links: [],
    externalLinks: [],
    audited: true,
    issues,
    keyboardFindings: 0,
    scores: { ada: score, keyboard: score, overall: score },
    issueCounts: { critical: 0, serious: issues.length, moderate: 0, minor: 0 },
    artifacts: {},
    timings: { startedAt: '', finishedAt: '', durationMs: 0 },
  };
}

function manifest(id: string, pages: CrawledPage[]): CrawlManifest {
  const issueCount = pages.reduce((n, p) => n + p.issues.length, 0);
  return {
    schemaVersion: 1,
    id,
    toolVersion: 'test',
    rootUrl: 'https://example.com/',
    startedAt: '2026-01-01T00:00:00.000Z',
    finishedAt: '2026-01-01T00:00:01.000Z',
    durationMs: 1000,
    config: {},
    auth: { enabled: false, loginUrl: null, statePath: null, expired: false },
    stats: { pages: pages.length, audited: pages.length, edges: 0, externalLinks: 0, blockedByRobots: 0, errors: 0, maxDepthReached: 0 },
    summary: { adaScore: 90, keyboardScore: 90, overallScore: 90, issueCounts: { critical: 0, serious: issueCount, moderate: 0, minor: 0 }, keyboardFindings: 0 },
    pages,
    edges: [],
    tree: { name: '/', path: '/', children: [] },
    graph: { nodes: [], edges: [] },
    notices: [],
  };
}

describe('findingsToCsv', () => {
  it('escapes fields and includes finding rows', () => {
    const m = manifest('r1', [page('https://example.com/', [issue('image-alt')])]);
    m.pages[0]!.issues[0]!.description = 'Has, comma and "quotes"';
    const csv = findingsToCsv(m);
    expect(csv.split('\n')[0]).toBe('page_url,page_title,source,rule_id,impact,description,help,help_url,selectors,tags,node_count');
    expect(csv).toContain('"Has, comma and ""quotes"""');
    expect(csv).toContain('image-alt');
    expect(csv).toContain('#a');
  });
});

describe('summaryForExport', () => {
  it('produces a compact run summary without full issue payloads', () => {
    const m = manifest('r1', [page('https://example.com/', [issue('image-alt')])]);
    const summary = summaryForExport(m) as { pages: Array<Record<string, unknown>> };
    expect(summary.pages[0]).toMatchObject({ url: 'https://example.com/', issueCount: 1 });
    expect(summary.pages[0]).not.toHaveProperty('issues');
  });
});

describe('diffCrawls', () => {
  it('reports added, removed, changed pages and rule deltas', () => {
    const before = manifest('before', [
      page('https://example.com/', [issue('image-alt')], 90),
      page('https://example.com/old', [issue('label')], 85),
    ]);
    const after = manifest('after', [
      page('https://example.com/', [issue('label')], 95),
      page('https://example.com/new', [issue('link-name')], 92),
    ]);
    after.summary.overallScore = 94;
    after.summary.adaScore = 94;
    after.summary.keyboardScore = 94;

    const diff = diffCrawls(before, after);
    expect(diff.summary.addedPages).toBe(1);
    expect(diff.summary.removedPages).toBe(1);
    expect(diff.summary.changedPages).toBe(1);
    expect(diff.summary.issueDelta).toBe(0);
    expect(diff.summary.scoreDelta).toBe(4);
    expect(diff.newRules).toContain('axe:link-name');
    expect(diff.fixedRules).toContain('axe:image-alt');

    const home = diff.pages.find((p) => p.url === 'https://example.com/');
    expect(home?.status).toBe('changed');
    expect(home?.newRules).toEqual(['axe:label']);
    expect(home?.fixedRules).toEqual(['axe:image-alt']);
  });
});
