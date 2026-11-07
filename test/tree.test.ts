import { describe, expect, it } from 'vitest';
import { buildSiteGraph, buildSiteTree } from '../src/core/tree.js';
import type { CrawlEdge, CrawledPage, Impact } from '../src/core/types.js';

const COUNTS: Record<Impact, number> = { critical: 0, serious: 0, moderate: 0, minor: 0 };

function page(url: string, overrides: Partial<CrawledPage> = {}): CrawledPage {
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
    issues: [],
    keyboardFindings: 0,
    scores: { ada: 100, keyboard: 100, overall: 100 },
    issueCounts: COUNTS,
    artifacts: {},
    timings: { startedAt: '', finishedAt: '', durationMs: 0 },
    ...overrides,
  };
}

describe('buildSiteTree', () => {
  it('nests pages by path segments', () => {
    const root = 'https://example.com/';
    const tree = buildSiteTree(root, [
      page(root, { title: 'Home' }),
      page('https://example.com/about', { title: 'About' }),
      page('https://example.com/docs/a', { title: 'Doc A', depth: 2 }),
      page('https://example.com/docs/b', { title: 'Doc B', depth: 2 }),
    ]);

    expect(tree.url).toBe(root);
    expect(tree.title).toBe('Home');
    expect(tree.children.map((child) => child.name)).toEqual(['about', 'docs']);

    const docs = tree.children.find((child) => child.name === 'docs');
    expect(docs?.children.map((child) => child.name)).toEqual(['a', 'b']);
    expect(docs?.children[0]?.title).toBe('Doc A');
  });

  it('keeps query variants as separate leaves', () => {
    const tree = buildSiteTree('https://example.com/', [
      page('https://example.com/search?q=a'),
      page('https://example.com/search?q=b'),
    ]);

    const search = tree.children.find((child) => child.name === 'search');
    expect(search?.children.map((child) => child.name)).toEqual(['?q=a', '?q=b']);
  });

  it('stores scores only for audited pages', () => {
    const tree = buildSiteTree('https://example.com/', [
      page('https://example.com/not-audited', {
        audited: false,
        scores: { ada: 0, keyboard: 0, overall: 0 },
      }),
    ]);

    const node = tree.children.find((child) => child.name === 'not-audited');
    expect(node?.score).toBeUndefined();
  });
});

describe('buildSiteGraph', () => {
  it('adds crawled pages, external targets, and deduplicated edges', () => {
    const root = 'https://example.com/';
    const pages = [
      page(root, { depth: 0 }),
      page('https://example.com/about', { depth: 1 }),
    ];
    const edges: CrawlEdge[] = [
      { from: root, to: 'https://example.com/about', external: false },
      { from: root, to: 'https://example.com/about', external: false },
      { from: root, to: 'https://other.example/x', external: true },
      { from: 'https://example.com/about', to: root, external: false },
    ];

    const graph = buildSiteGraph(root, pages, edges);

    expect(graph.nodes).toHaveLength(3);
    expect(graph.edges).toEqual([
      { from: root, to: 'https://example.com/about' },
      { from: root, to: 'https://other.example/x' },
      { from: 'https://example.com/about', to: root },
    ]);

    const external = graph.nodes.find((node) => node.id === 'https://other.example/x');
    expect(external?.external).toBe(true);
    expect(external?.audited).toBe(false);
    expect(external?.title).toBe('External link');
  });

  it('labels pages by their path', () => {
    const graph = buildSiteGraph(
      'https://example.com/',
      [page('https://example.com/docs/start', { title: 'Start' })],
      [],
    );
    const node = graph.nodes.find((item) => item.id === 'https://example.com/docs/start');
    expect(node?.label).toBe('/docs/start');
    expect(node?.title).toBe('Start');
  });
});
