import { describe, expect, it } from 'vitest';
import { renderViewer } from '../src/core/viewer.js';
import type { CrawlManifest } from '../src/core/types.js';

function manifest(): CrawlManifest {
  return {
    schemaVersion: 1,
    id: 'run-1',
    toolVersion: 'test',
    rootUrl: 'https://example.com/',
    startedAt: '2026-01-01T00:00:00.000Z',
    finishedAt: '2026-01-01T00:00:01.000Z',
    durationMs: 1000,
    config: {},
    auth: { enabled: false, loginUrl: null, statePath: null, expired: false },
    stats: {
      pages: 1,
      audited: 1,
      edges: 0,
      externalLinks: 0,
      blockedByRobots: 0,
      errors: 0,
      maxDepthReached: 0,
    },
    summary: {
      adaScore: 90,
      keyboardScore: 95,
      overallScore: 93,
      issueCounts: { critical: 0, serious: 1, moderate: 0, minor: 0 },
      keyboardFindings: 0,
    },
    pages: [
      {
        url: 'https://example.com/',
        finalUrl: 'https://example.com/',
        status: 200,
        title: 'Home',
        metaRobots: null,
        depth: 0,
        contentType: 'text/html',
        headers: {},
        links: [],
        externalLinks: [],
        audited: true,
        issues: [
          {
            source: 'axe',
            ruleId: 'image-alt',
            impact: 'serious',
            description: 'Images must have alternate text',
            help: 'Add alt text',
            helpUrl: 'https://dequeuniversity.com/rules/axe/4.10/image-alt',
            tags: ['wcag2a', 'wcag111', 'section508'],
            nodes: [
              {
                target: ['img.hero'],
                html: '<img class="hero" src="/x.png">',
                rect: { x: 10, y: 20, width: 100, height: 50 },
              },
            ],
          },
        ],
        keyboardFindings: 0,
        scores: { ada: 90, keyboard: 95, overall: 93 },
        issueCounts: { critical: 0, serious: 1, moderate: 0, minor: 0 },
        artifacts: { screenshot: 'pages/home/screenshot.png', dom: 'pages/home/page.html' },
        timings: {
          startedAt: '2026-01-01T00:00:00.000Z',
          finishedAt: '2026-01-01T00:00:01.000Z',
          durationMs: 1000,
        },
      },
    ],
    edges: [],
    tree: { name: '/', path: '/', url: 'https://example.com/', title: 'Home', status: 200, score: 93, children: [] },
    graph: {
      nodes: [
        {
          id: 'https://example.com/',
          label: 'example.com',
          title: 'Home',
          depth: 0,
          status: 200,
          score: 93,
          audited: true,
          external: false,
        },
      ],
      edges: [],
    },
    notices: [],
  };
}

describe('renderViewer', () => {
  it('renders a self-contained HTML report with issue and highlight data', () => {
    const html = renderViewer(manifest());

    expect(html).toContain('<!doctype html>');
    expect(html).toContain('Canopy site report');
    expect(html).toContain('https://example.com/');
    expect(html).not.toMatch(/<script[^>]+src=/);
    expect(html).not.toMatch(/<link[^>]+href=["']https?:/);

    // Embedded data drives the detail panel and screenshot highlights.
    expect(html).toContain('image-alt');
    expect(html).toContain('img.hero');
    expect(html).toContain('pages/home/screenshot.png');
    expect(html).toContain('wcag111');
    expect(html).toContain('"rect"');
    expect(html).toContain('"width":100');
  });

  it('escapes HTML-sensitive content in the embedded payload', () => {
    const m = manifest();
    m.rootUrl = 'https://example.com/?q=<script>alert(1)</script>';
    m.pages[0]!.issues[0]!.nodes[0]!.html = '<img onerror=alert(1) src=x>';
    const html = renderViewer(m);
    // The embedded JSON must not contain raw < that could break out of the script tag.
    const payload = html.split('id="canopy-data">')[1]?.split('</script>')[0] ?? '';
    expect(payload).not.toContain('<script>alert(1)</script>');
    expect(payload).toContain('\\u003c');
  });

  it('includes auth state when enabled', () => {
    const m = manifest();
    m.auth = {
      enabled: true,
      loginUrl: 'https://example.com/login',
      statePath: '.canopy/auth/state.json',
      expired: false,
    };
    expect(renderViewer(m)).toContain('session');
  });
});
