import { createServer, type Server } from 'node:http';
import { mkdtemp, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { CanopyConfigSchema, type CanopyConfig } from '../src/core/config.js';
import { crawlSite } from '../src/core/crawl.js';

let server: Server;
let origin = '';
let loginPosts = 0;
const tempDirs: string[] = [];

function html(title: string, body: string): string {
  return `<!doctype html><html lang="en"><head><title>${title}</title></head><body>${body}</body></html>`;
}

function cookieHeader(request: import('node:http').IncomingMessage): string {
  return request.headers.cookie ?? '';
}

async function readBody(request: import('node:http').IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks).toString('utf8');
}

function send(
  response: import('node:http').ServerResponse,
  status: number,
  contentType: string,
  body: string,
  headers: Record<string, string> = {},
): void {
  response.writeHead(status, { 'content-type': contentType, ...headers }).end(body);
}

async function handle(
  request: import('node:http').IncomingMessage,
  response: import('node:http').ServerResponse,
): Promise<void> {
  const url = new URL(request.url ?? '/', 'http://localhost');

  if (request.method === 'POST' && url.pathname === '/login') {
    loginPosts += 1;
    const form = new URLSearchParams(await readBody(request));
    if (form.get('email') === 'ada@example.com' && form.get('password') === 'correct horse') {
      response.writeHead(302, {
        location: '/dashboard',
        'set-cookie': 'sid=ok; Path=/; HttpOnly; SameSite=Lax',
      });
      response.end();
      return;
    }
    send(response, 401, 'text/html; charset=utf-8', html('Denied', '<h1>Denied</h1>'));
    return;
  }

  if (url.pathname === '/login') {
    send(
      response,
      200,
      'text/html; charset=utf-8',
      html(
        'Sign in',
        `<h1>Sign in</h1>
         <form method="post" action="/login">
           <input id="email" name="email" type="email" />
           <input id="password" name="password" type="password" />
           <button type="submit">Sign in</button>
         </form>`,
      ),
    );
    return;
  }

  if (url.pathname === '/dashboard') {
    if (!cookieHeader(request).includes('sid=ok')) {
      response.writeHead(302, { location: '/login' }).end();
      return;
    }
    send(
      response,
      200,
      'text/html; charset=utf-8',
      html('Dashboard', '<h1>Dashboard</h1><div id="ok">Signed in</div>'),
    );
    return;
  }

  if (url.pathname === '/expired') {
    send(response, 401, 'text/html; charset=utf-8', html('Expired', '<h1>Session expired</h1>'));
    return;
  }

  if (url.pathname === '/') {
    const expiredLink = url.searchParams.get('expiry') === '1' ? '<a href="/expired">expired</a>' : '';
    send(
      response,
      200,
      'text/html; charset=utf-8',
      html('Home', `<h1>Home</h1><a href="/dashboard">dashboard</a>${expiredLink}`),
    );
    return;
  }

  send(response, 404, 'text/plain', 'not found');
}

beforeAll(async () => {
  server = createServer((request, response) => {
    void handle(request, response);
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('auth fixture failed to listen');
  origin = `http://127.0.0.1:${address.port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

beforeEach(() => {
  loginPosts = 0;
  vi.stubEnv('CANOPY_TEST_USER', 'ada@example.com');
  vi.stubEnv('CANOPY_TEST_PASSWORD', 'correct horse');
  vi.stubEnv('CANOPY_TEST_ORIGIN', origin);
});

afterEach(async () => {
  vi.unstubAllEnvs();
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) await rm(dir, { recursive: true, force: true });
  }
});

async function tempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'canopy-auth-crawl-'));
  tempDirs.push(dir);
  return dir;
}

async function writeRecipe(dir: string): Promise<string> {
  const path = join(dir, 'auth.yml');
  await writeFile(
    path,
    `login:
  url: \${CANOPY_TEST_ORIGIN}/login
  steps:
    - fill: { selector: "#email", value: "\${CANOPY_TEST_USER}" }
    - fill: { selector: "#password", value: "\${CANOPY_TEST_PASSWORD}" }
    - click: { selector: "button[type=submit]" }
  success:
    waitForUrl: /dashboard
`,
    'utf8',
  );
  return path;
}

function configFor(dir: string, recipe: string): CanopyConfig {
  return CanopyConfigSchema.parse({
    crawl: {
      maxPages: 10,
      maxDepth: 3,
      concurrency: 1,
      requestsPerSecond: 50,
      respectRobots: false,
      auditPages: false,
    },
    browser: { headless: true, timeoutMs: 10_000, settleMs: 0 },
    output: { dir, screenshots: false, domSnapshots: false },
    auth: { recipe },
  });
}

describe('scripted login crawl', () => {
  it(
    'logs in with a recipe, crawls protected pages, and saves a 0600 session state',
    async () => {
      const outDir = await tempDir();
      const recipe = await writeRecipe(outDir);

      const result = await crawlSite({
        url: `${origin}/`,
        config: configFor(outDir, recipe),
        toolVersion: 'test',
        audit: false,
      });

      const { manifest } = result;

      expect(loginPosts).toBe(1);
      expect(result.authExpired).toBe(false);
      expect(manifest.auth.enabled).toBe(true);
      expect(manifest.auth.expired).toBe(false);
      expect(manifest.auth.loginUrl).toBe(`${origin}/login`);
      expect(manifest.auth.statePath).toBeTruthy();

      const dashboard = manifest.pages.find((page) => page.url === `${origin}/dashboard`);
      expect(dashboard).toBeDefined();
      expect(dashboard?.status).toBe(200);
      expect(dashboard?.title).toBe('Dashboard');
      expect(manifest.stats.errors).toBe(0);

      const statePath = manifest.auth.statePath;
      if (!statePath) throw new Error('missing state path');
      const mode = (await stat(statePath)).mode & 0o777;
      expect(mode).toBe(0o600);
    },
    120_000,
  );

  it(
    'stops the crawl when a protected page reports an expired session',
    async () => {
      const outDir = await tempDir();
      const recipe = await writeRecipe(outDir);

      const result = await crawlSite({
        url: `${origin}/?expiry=1`,
        config: configFor(outDir, recipe),
        toolVersion: 'test',
        audit: false,
      });

      const { manifest } = result;

      expect(result.authExpired).toBe(true);
      expect(manifest.auth.expired).toBe(true);

      const expired = manifest.pages.find((page) => page.url === `${origin}/expired`);
      expect(expired).toBeDefined();
      expect(expired?.status).toBe(401);
      expect(expired?.error).toMatch(/Authentication expired/);

      expect(manifest.pages.some((page) => page.url === `${origin}/login`)).toBe(false);
      expect(manifest.notices.some((notice) => notice.includes('Authentication expired'))).toBe(
        true,
      );
    },
    120_000,
  );
});
