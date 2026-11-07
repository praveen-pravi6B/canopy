import { createServer, type Server } from 'node:http';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { CanopyConfigSchema, type CanopyConfig } from '../src/core/config.js';
import { crawlSite } from '../src/core/crawl.js';
import { listRuns, openDatabase } from '../src/core/db.js';

let site: Server;
let outside: Server;
let siteOrigin = '';
let outsideOrigin = '';
let requests: string[] = [];
let outsideHits = 0;
const tempDirs: string[] = [];

function html(title: string, body: string): string {
  return `<!doctype html><html lang="en"><head><title>${title}</title></head><body>${body}</body></html>`;
}

function page(index: number, outside: string): string {
  const next = index < 29 ? `/p/${index + 1}` : '/';
  return html(
    `Page ${index}`,
    `<h1>Page ${index}</h1>
     <a href="${next}">next</a>
     <a href="/">home</a>
     <a href="/private/secret">private</a>
     <a href="${outside}/outside">external</a>`,
  );
}

function handleSiteRequest(
  requestUrl: string,
  response: import('node:http').ServerResponse,
): void {
  const url = new URL(requestUrl, 'http://localhost');
  const path = url.pathname;
  requests.push(path);

  const send = (status: number, contentType: string, body: string): void => {
    response.writeHead(status, { 'content-type': contentType }).end(body);
  };

  if (path === '/robots.txt') {
    send(
      200,
      'text/plain',
      `User-agent: *\nDisallow: /private\nSitemap: ${siteOrigin}/sitemap.xml\n`,
    );
    return;
  }

  if (path === '/sitemap.xml') {
    send(
      200,
      'application/xml',
      `<?xml version="1.0"?><urlset>
        <url><loc>${siteOrigin}/p/1</loc></url>
        <url><loc>${siteOrigin}/p/29</loc></url>
      </urlset>`,
    );
    return;
  }

  if (path === '/private/secret') {
    send(200, 'text/html; charset=utf-8', html('Private', '<h1>Private</h1>'));
    return;
  }

  if (path === '/old') {
    response.writeHead(302, { location: '/p/1' }).end();
    return;
  }

  if (path === '/') {
    const extra = url.searchParams.get('redirect') === '1' ? '<a href="/old">old</a>' : '';
    send(
      200,
      'text/html; charset=utf-8',
      html('Page 0', `<h1>Home</h1>${extra}<a href="/p/1">next</a><a href="/private/secret">private</a><a href="${outsideOrigin}/outside">external</a>`),
    );
    return;
  }

  const match = /^\/p\/(\d+)$/.exec(path);
  if (match) {
    const index = Number(match[1]);
    if (index >= 1 && index <= 29) {
      send(200, 'text/html; charset=utf-8', page(index, outsideOrigin));
      return;
    }
  }

  send(404, 'text/plain', 'not found');
}

function configFor(dir: string, overrides: Partial<CanopyConfig['crawl']> = {}): CanopyConfig {
  return CanopyConfigSchema.parse({
    crawl: {
      maxPages: 100,
      maxDepth: 40,
      concurrency: 3,
      requestsPerSecond: 50,
      respectRobots: true,
      auditPages: false,
      ...overrides,
    },
    browser: { timeoutMs: 5000, settleMs: 0 },
    audit: { maxTabs: 10 },
    output: { dir, screenshots: false, domSnapshots: false },
  });
}

async function tempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'canopy-crawl-'));
  tempDirs.push(dir);
  return dir;
}

beforeAll(async () => {
  site = createServer((request, response) => {
    handleSiteRequest(request.url ?? '/', response);
  });

  outside = createServer((_request, response) => {
    outsideHits += 1;
    response.writeHead(200, { 'content-type': 'text/html' }).end(html('Outside', '<p>outside</p>'));
  });

  await new Promise<void>((resolve) => site.listen(0, '127.0.0.1', () => resolve()));
  await new Promise<void>((resolve) => outside.listen(0, '127.0.0.1', () => resolve()));

  const siteAddress = site.address();
  const outsideAddress = outside.address();
  if (!siteAddress || typeof siteAddress === 'string') throw new Error('site server failed');
  if (!outsideAddress || typeof outsideAddress === 'string') throw new Error('outside server failed');

  siteOrigin = `http://127.0.0.1:${siteAddress.port}`;
  outsideOrigin = `http://127.0.0.1:${outsideAddress.port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => site.close(() => resolve()));
  await new Promise<void>((resolve) => outside.close(() => resolve()));
});

beforeEach(() => {
  requests = [];
  outsideHits = 0;
});

afterEach(async () => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) await rm(dir, { recursive: true, force: true });
  }
});

describe('crawlSite', () => {
  it('crawls a 30-page same-origin fixture and respects robots.txt', async () => {
    const outDir = await tempDir();
    const result = await crawlSite({
      url: `${siteOrigin}/`,
      config: configFor(outDir),
      toolVersion: 'test',
      audit: false,
    });

    const { manifest } = result;

    expect(manifest.stats.pages).toBe(30);
    expect(manifest.stats.audited).toBe(0);
    expect(manifest.pages.every((page) => page.url.startsWith(siteOrigin))).toBe(true);
    expect(manifest.stats.blockedByRobots).toBeGreaterThanOrEqual(1);
    expect(manifest.stats.externalLinks).toBeGreaterThanOrEqual(1);
    expect(manifest.stats.errors).toBe(0);

    // Robots-disallowed pages are never requested.
    expect(requests).not.toContain('/private/secret');

    // Out-of-origin links are recorded but never fetched.
    expect(outsideHits).toBe(0);
    expect(manifest.edges.some((edge) => edge.external && edge.to.startsWith(outsideOrigin))).toBe(
      true,
    );

    expect(manifest.tree.children.some((child) => child.name === 'p')).toBe(true);
    expect(manifest.graph.nodes.length).toBeGreaterThanOrEqual(31);

    for (const file of ['crawl.json', 'tree.json', 'graph.json', 'viewer.html']) {
      await stat(join(result.runDir, file)).catch(() => {
        throw new Error(`missing ${file}`);
      });
    }

    const viewer = await readFile(join(result.runDir, 'viewer.html'), 'utf8');
    expect(viewer).toContain('Canopy site report');
    expect(viewer).toContain('Page 0');

    const db = openDatabase(join(outDir, 'canopy.db'));
    try {
      const runs = listRuns(db);
      expect(runs).toHaveLength(1);
      expect(runs[0]?.pages).toBe(30);

      const pageCount = db
        .prepare('SELECT COUNT(*) AS count FROM pages WHERE run_id = ?')
        .get(manifest.id) as { count: number };
      expect(pageCount.count).toBe(30);
    } finally {
      db.close();
    }
  });

  it('honors maxDepth and records the limit', async () => {
    const outDir = await tempDir();
    const { manifest } = await crawlSite({
      url: `${siteOrigin}/`,
      config: configFor(outDir, { maxDepth: 1 }),
      toolVersion: 'test',
      audit: false,
    });

    // Root, plus /p/1 and /p/29 discovered through the sitemap at depth 1.
    expect(manifest.stats.pages).toBe(3);
    expect(manifest.stats.maxDepthReached).toBe(1);
    expect(manifest.notices.some((notice) => notice.includes('Depth limit'))).toBe(true);
  });

  it('crawls disallowed paths when robots.txt is ignored', async () => {
    const outDir = await tempDir();
    const { manifest } = await crawlSite({
      url: `${siteOrigin}/`,
      config: configFor(outDir, { respectRobots: false }),
      toolVersion: 'test',
      audit: false,
    });

    expect(manifest.stats.blockedByRobots).toBe(0);
    expect(requests).toContain('/private/secret');
    expect(manifest.stats.pages).toBe(31);
  });

  it('follows same-origin redirects and records the final URL', async () => {
    const outDir = await tempDir();
    const { manifest } = await crawlSite({
      url: `${siteOrigin}/?redirect=1`,
      config: configFor(outDir),
      toolVersion: 'test',
      audit: false,
    });

    const redirected = manifest.pages.find((page) => page.url === `${siteOrigin}/old`);
    expect(redirected).toBeDefined();
    expect(redirected?.finalUrl).toBe(`${siteOrigin}/p/1`);
    expect(redirected?.status).toBe(200);
  });

  it('stops at maxPages', async () => {
    const outDir = await tempDir();
    const { manifest } = await crawlSite({
      url: `${siteOrigin}/`,
      config: configFor(outDir, { maxPages: 5 }),
      toolVersion: 'test',
      audit: false,
    });

    expect(manifest.stats.pages).toBe(5);
    expect(manifest.notices.some((notice) => notice.includes('maxPages'))).toBe(true);
  });
});
