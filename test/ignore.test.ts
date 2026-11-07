import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  addIgnoreRule,
  listIgnoreRules,
  openDatabase,
  removeIgnoreRule,
} from '../src/core/db.js';
import {
  applyIgnoreRulesToIssues,
  applyIgnoreRulesToManifest,
  issueCategory,
  matchesIgnorePattern,
  ruleApplies,
} from '../src/core/ignore.js';
import type { CrawlManifest, CrawledPage, IgnoreRule, Issue } from '../src/core/types.js';

const dirs: string[] = [];

afterEach(() => {
  while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true });
});

function issue(source: Issue['source'], ruleId = 'r1'): Issue {
  return {
    source,
    ruleId,
    impact: source === 'keyboard' ? 'serious' : 'moderate',
    description: 'd',
    help: 'h',
    tags: [],
    nodes: [],
  };
}

function page(url: string, issues: Issue[]): CrawledPage {
  return {
    url,
    finalUrl: url,
    status: 200,
    title: 't',
    metaRobots: null,
    depth: 0,
    contentType: 'text/html',
    headers: {},
    links: [],
    externalLinks: [],
    audited: true,
    issues,
    keyboardFindings: issues.filter((i) => i.source === 'keyboard').length,
    scores: { ada: 90, keyboard: 90, overall: 90 },
    issueCounts: { critical: 0, serious: 0, moderate: 0, minor: 0 },
    artifacts: {},
    timings: { startedAt: '', finishedAt: '', durationMs: 0 },
  };
}

describe('matchesIgnorePattern', () => {
  it('matches path globs against URL paths', () => {
    expect(matchesIgnorePattern('/legacy/*', 'https://example.com/legacy/old')).toBe(true);
    expect(matchesIgnorePattern('/legacy/*', 'https://example.com/legacy/old/deep')).toBe(true);
    expect(matchesIgnorePattern('/legacy/**', 'https://example.com/legacy/old/deep')).toBe(true);
    expect(matchesIgnorePattern('/docs/*', 'https://example.com/blog/post')).toBe(false);
  });

  it('matches full URL patterns', () => {
    expect(
      matchesIgnorePattern('https://example.com/admin*', 'https://example.com/admin/users'),
    ).toBe(true);
  });

  it('treats bare patterns as path patterns', () => {
    expect(matchesIgnorePattern('admin/*', 'https://example.com/admin/users')).toBe(true);
  });
});

describe('ruleApplies', () => {
  const rule = (category: IgnoreRule['category']): IgnoreRule => ({
    id: 1,
    pattern: '/*',
    category,
    reason: 'test',
    createdAt: '',
  });

  it('filters by category', () => {
    expect(issueCategory(issue('axe'))).toBe('ada');
    expect(issueCategory(issue('keyboard'))).toBe('keyboard');
    expect(ruleApplies(rule('ada'), issue('axe'))).toBe(true);
    expect(ruleApplies(rule('ada'), issue('keyboard'))).toBe(false);
    expect(ruleApplies(rule('keyboard'), issue('keyboard'))).toBe(true);
    expect(ruleApplies(rule('all'), issue('keyboard'))).toBe(true);
  });
});

describe('applyIgnoreRulesToIssues', () => {
  it('keeps non-matching issues and records ignored ones', () => {
    const rules: IgnoreRule[] = [
      { id: 1, pattern: '/legacy/*', category: 'ada', reason: 'third-party', createdAt: '' },
    ];
    const result = applyIgnoreRulesToIssues(
      [issue('axe', 'a1'), issue('keyboard', 'k1')],
      'https://example.com/legacy/page',
      rules,
    );
    expect(result.kept.map((i) => i.ruleId)).toEqual(['k1']);
    expect(result.ignored).toHaveLength(1);
    expect(result.ignored[0]?.rule.id).toBe(1);
  });
});

describe('applyIgnoreRulesToManifest', () => {
  it('recomputes scores and summary from active issues', () => {
    const rules: IgnoreRule[] = [
      { id: 1, pattern: '/**', category: 'ada', reason: 'noise', createdAt: '' },
    ];
    const manifest: CrawlManifest = {
      schemaVersion: 1,
      id: 'r',
      toolVersion: 't',
      rootUrl: 'https://example.com/',
      startedAt: '',
      finishedAt: '',
      durationMs: 0,
      config: {},
      auth: { enabled: false, loginUrl: null, statePath: null, expired: false },
      stats: { pages: 1, audited: 1, edges: 0, externalLinks: 0, blockedByRobots: 0, errors: 0, maxDepthReached: 0 },
      summary: { adaScore: 0, keyboardScore: 0, overallScore: 0, issueCounts: { critical: 0, serious: 0, moderate: 1, minor: 0 }, keyboardFindings: 0 },
      pages: [page('https://example.com/', [issue('axe', 'image-alt'), issue('keyboard', 'keyboard/no-focus-indicator')])],
      edges: [],
      tree: { name: '/', path: '/', children: [] },
      graph: { nodes: [], edges: [] },
      notices: [],
    };

    const result = applyIgnoreRulesToManifest(manifest, rules);
    expect(result.ignoredCount).toBe(1);
    expect(result.value.pages[0]?.issues.map((i) => i.ruleId)).toEqual(['keyboard/no-focus-indicator']);
    expect(result.value.pages[0]?.scores.ada).toBe(100);
    expect(result.value.pages[0]?.scores.keyboard).toBe(95);
    expect(result.value.summary.adaScore).toBe(100);
    expect(result.value.summary.keyboardFindings).toBe(1);
    expect(result.value.notices[0]).toMatch(/Ignored 1 finding/);
  });
});

describe('ignore rule DB CRUD', () => {
  it('adds, lists, and removes rules', () => {
    const dir = mkdtempSync(join(tmpdir(), 'canopy-db-'));
    dirs.push(dir);
    const db = openDatabase(join(dir, 'canopy.db'));
    try {
      const rule = addIgnoreRule(db, '/legacy/*', 'ada', 'legacy section');
      expect(rule.id).toBeGreaterThan(0);
      expect(listIgnoreRules(db)).toHaveLength(1);
      expect(removeIgnoreRule(db, rule.id)).toBe(true);
      expect(removeIgnoreRule(db, rule.id)).toBe(false);
      expect(listIgnoreRules(db)).toHaveLength(0);
    } finally {
      db.close();
    }
  });
});
