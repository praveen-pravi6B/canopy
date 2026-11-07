import { createServer, type Server } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { CanopyConfigSchema, type CanopyConfig } from '../src/core/config.js';
import { crawlSite } from '../src/core/crawl.js';

let server: Server;
let origin = '';
const tempDirs: string[] = [];

function html(title: string, body: string): string {
  return `<!doctype html><html lang="en"><head><title>${title}</title></head><body>${body}</body></html>`;
}

const SHADOW_PAGE = html(
  'Shadow home',
  `<h1>Shadow home</h1>
   <div id="host"></div>
   <script>
     (function () {
       var outer = document.getElementById('host').attachShadow({ mode: 'open' });
       outer.innerHTML = '<a href="/shadow-child">shadow child</a>';
       var nested = document.createElement('div');
       outer.appendChild(nested);
       var inner = nested.attachShadow({ mode: 'open' });
       inner.innerHTML = '<a href="deep-child">deep child</a>';
     })();
   </script>`,
);

beforeAll(async () => {
  server = createServer((request, response) => {
    const url = new URL(request.url ?? '/', 'http://localhost');

    if (url.pathname === '/') {
      response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }).end(SHADOW_PAGE);
      return;
    }

    if (url.pathname === '/shadow-child' || url.pathname === '/deep-child') {
      response
        .writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
        .end(html(url.pathname, `<h1>${url.pathname}</h1><a href="/">home</a>`));
      return;
    }

    response.writeHead(404, { 'content-type': 'text/plain' }).end('not found');
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('shadow fixture failed to listen');
  origin = `http://127.0.0.1:${address.port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

afterEach(async () => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) await rm(dir, { recursive: true, force: true });
  }
});

async function tempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'canopy-shadow-'));
  tempDirs.push(dir);
  return dir;
}

function configFor(dir: string): CanopyConfig {
  return CanopyConfigSchema.parse({
    crawl: {
      maxPages: 10,
      maxDepth: 3,
      concurrency: 1,
      requestsPerSecond: 50,
      respectRobots: false,
      auditPages: true,
    },
    audit: { maxTabs: 5 },
    browser: { timeoutMs: 15_000, settleMs: 100 },
    output: { dir, screenshots: false, domSnapshots: false },
  });
}

describe('rendered link discovery', () => {
  it(
    'finds links inside open shadow roots and nested shadow roots',
    async () => {
      const outDir = await tempDir();
      const { manifest } = await crawlSite({
        url: `${origin}/`,
        config: configFor(outDir),
        toolVersion: 'test',
      });

      const urls = manifest.pages.map((page) => page.url);
      expect(urls).toContain(`${origin}/shadow-child`);
      expect(urls).toContain(`${origin}/deep-child`);

      const rootPage = manifest.pages.find((page) => page.url === `${origin}/`);
      expect(rootPage?.links).toContain(`${origin}/shadow-child`);
      expect(rootPage?.links).toContain(`${origin}/deep-child`);
      expect(rootPage?.audited).toBe(true);
    },
    150_000,
  );
});
