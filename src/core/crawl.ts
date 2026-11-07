import { createHash } from 'node:crypto';
import { mkdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import type { APIRequestContext, Page, Response } from 'playwright';
import { auditLoadedPage, redactHeaders } from './audit.js';
import { detectAuthExpiry } from './auth.js';
import type { CanopyConfig } from './config.js';
import { openDatabase, saveCrawlRun } from './db.js';
import { extractDocument } from './html.js';
import { extractRenderedLinks } from './rendered.js';
import {
  ALLOW_ALL,
  extractSitemapUrls,
  fetchRobots,
  isPathAllowed,
  type RobotsRules,
} from './robots.js';
import { countIssues, overallScore } from './score.js';
import { openSession, type AuthSession } from './session.js';
import { createRunDirectory, writeJson, writeText } from './storage.js';
import { buildSiteGraph, buildSiteTree } from './tree.js';
import type {
  CrawlEdge,
  CrawlManifest,
  CrawlStats,
  CrawledPage,
  Impact,
  SiteGraph,
  SiteTreeNode,
} from './types.js';
import { assertSafeTarget, isInScope, normalizeUrl, parseTargetUrl } from './url.js';
import { USER_AGENT } from './version.js';
import { renderViewer } from './viewer.js';

const DESTRUCTIVE_PATTERN = /(logout|log-out|signout|sign-out|delete|destroy|deactivate|unsubscribe)/i;
const AUTH_EXPIRED_MESSAGE = 'Authentication expired. Re-run with a fresh session or auth recipe.';
const MAX_REDIRECTS = 5;
const MAX_HTML_BYTES = 5 * 1024 * 1024;

const EMPTY_IMPACT_COUNTS: Record<Impact, number> = {
  critical: 0,
  serious: 0,
  moderate: 0,
  minor: 0,
};

class RateLimiter {
  private nextAt = 0;

  constructor(private readonly intervalMs: number) {}

  async wait(): Promise<void> {
    const now = Date.now();
    const slot = Math.max(now, this.nextAt);
    this.nextAt = slot + this.intervalMs;

    const waitMs = slot - now;
    if (waitMs > 0) await new Promise((resolvePromise) => setTimeout(resolvePromise, waitMs));
  }
}

interface QueueItem {
  url: string;
  depth: number;
}

interface StaticPage {
  ok: true;
  finalUrl: string;
  status: number;
  headers: Record<string, string>;
  contentType: string;
  body: string | null;
  outOfScope: boolean;
}

interface StaticFailure {
  ok: false;
  error: string;
}

interface DiscoveryResult {
  page: CrawledPage;
  discovered: QueueItem[];
  external: string[];
}

export interface CrawlOptions {
  url: string;
  config: CanopyConfig;
  toolVersion: string;
  audit?: boolean;
  onEvent?: (message: string) => void;
  signal?: AbortSignal;
}

export interface CrawlResult {
  manifest: CrawlManifest;
  runDir: string;
  manifestPath: string;
  authExpired: boolean;
}

function isRedirect(status: number): boolean {
  return status === 301 || status === 302 || status === 303 || status === 307 || status === 308;
}

function isHtmlContentType(contentType: string): boolean {
  const type = contentType.toLowerCase();
  return type.includes('text/html') || type.includes('application/xhtml+xml');
}

async function readStatic(
  response: globalThis.Response,
  outOfScope: boolean,
): Promise<StaticPage> {
  const headers: Record<string, string> = {};
  response.headers.forEach((value, key) => {
    headers[key] = value;
  });

  const contentType = headers['content-type'] ?? '';
  let body: string | null = null;

  if (!outOfScope && isHtmlContentType(contentType)) {
    body = (await response.text()).slice(0, MAX_HTML_BYTES);
  } else {
    await response.body?.cancel().catch(() => undefined);
  }

  return {
    ok: true,
    finalUrl: response.url,
    status: response.status,
    headers,
    contentType,
    body,
    outOfScope,
  };
}

async function fetchStatic(
  startUrl: string,
  root: URL,
  config: CanopyConfig,
  signal?: AbortSignal,
): Promise<StaticPage | StaticFailure> {
  let current = new URL(startUrl);

  try {
    for (let hop = 0; hop <= MAX_REDIRECTS; hop += 1) {
      await assertSafeTarget(current, { allowPrivate: config.crawl.allowPrivateNetworks });

      if (!isInScope(current, root, config.crawl.includeSubdomains)) {
        return {
          ok: true,
          finalUrl: current.toString(),
          status: 0,
          headers: {},
          contentType: '',
          body: null,
          outOfScope: true,
        };
      }

      const timeoutSignal = AbortSignal.timeout(config.browser.timeoutMs);
      const combinedSignal = signal ? AbortSignal.any([signal, timeoutSignal]) : timeoutSignal;

      const response = await fetch(current.toString(), {
        redirect: 'manual',
        headers: {
          'user-agent': USER_AGENT,
          accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.5',
        },
        signal: combinedSignal,
      });

      if (isRedirect(response.status)) {
        const location = response.headers.get('location');
        if (!location) return readStatic(response, false);

        await response.body?.cancel().catch(() => undefined);

        if (hop === MAX_REDIRECTS) {
          return { ok: false, error: 'Too many redirects' };
        }

        current = new URL(location, current);
        continue;
      }

      return readStatic(response, false);
    }
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }

  return { ok: false, error: 'Too many redirects' };
}

async function fetchStaticWithRequest(
  request: APIRequestContext,
  startUrl: string,
  root: URL,
  config: CanopyConfig,
): Promise<StaticPage | StaticFailure> {
  let current = new URL(startUrl);

  try {
    for (let hop = 0; hop <= MAX_REDIRECTS; hop += 1) {
      await assertSafeTarget(current, { allowPrivate: config.crawl.allowPrivateNetworks });

      if (!isInScope(current, root, config.crawl.includeSubdomains)) {
        return {
          ok: true,
          finalUrl: current.toString(),
          status: 0,
          headers: {},
          contentType: '',
          body: null,
          outOfScope: true,
        };
      }

      const response = await request.get(current.toString(), {
        failOnStatusCode: false,
        maxRedirects: 0,
        timeout: config.browser.timeoutMs,
        headers: {
          'user-agent': USER_AGENT,
          accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.5',
        },
      });

      const status = response.status();
      const headers = response.headers();
      const finalUrl = response.url();

      if (isRedirect(status)) {
        const location = headers['location'];
        await response.dispose();

        if (!location) return { ok: false, error: `Redirect without a Location header: ${status}` };
        if (hop === MAX_REDIRECTS) return { ok: false, error: 'Too many redirects' };

        current = new URL(location, current);
        continue;
      }

      const contentType = headers['content-type'] ?? '';
      let body: string | null = null;

      if (isHtmlContentType(contentType)) {
        body = (await response.body()).toString('utf8').slice(0, MAX_HTML_BYTES);
      }

      await response.dispose();

      return {
        ok: true,
        finalUrl,
        status,
        headers,
        contentType,
        body,
        outOfScope: false,
      };
    }
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }

  return { ok: false, error: 'Too many redirects' };
}

function artifactSlug(url: string): string {
  const parsed = new URL(url);
  const base =
    (parsed.pathname + parsed.search)
      .replace(/[^a-z0-9]+/gi, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 48) || 'root';
  const hash = createHash('sha1').update(url).digest('hex').slice(0, 8);
  return `${base}-${hash}`;
}

function average(values: number[]): number {
  if (values.length === 0) return 0;
  return Math.round(values.reduce((total, value) => total + value, 0) / values.length);
}

export async function crawlSite(options: CrawlOptions): Promise<CrawlResult> {
  const { config } = options;
  const auditEnabled = options.audit ?? true;

  const root = parseTargetUrl(options.url);
  await assertSafeTarget(root, { allowPrivate: config.crawl.allowPrivateNetworks });

  const rootUrl = normalizeUrl(root.toString());
  const run = await createRunDirectory(config.output.dir, rootUrl);
  const startedMs = Date.now();
  const startedAt = new Date(startedMs).toISOString();

  const notices: string[] = [];
  const pages: CrawledPage[] = [];
  const edges: CrawlEdge[] = [];
  const edgeKeys = new Set<string>();
  const queue: QueueItem[] = [];
  const seen = new Set<string>();
  const robotsBlocked = new Set<string>();

  let blockedByRobots = 0;
  let skippedDestructive = 0;
  let authExpired = false;
  const sessionState: { promise: Promise<AuthSession> | null; session: AuthSession | null } = {
    promise: null,
    session: null,
  };
  let robots: RobotsRules = ALLOW_ALL;

  const authEnabled = Boolean(config.auth.recipe || config.auth.statePath);

  const checkExpiry = (finalUrl: string, status: number | null): boolean => {
    if (!sessionState.session?.loginUrl) return false;
    if (!detectAuthExpiry(finalUrl, status, sessionState.session.loginUrl)) return false;
    authExpired = true;
    return true;
  };

  const addEdge = (from: string, to: string, external: boolean): void => {
    const key = `${from}\u0000${to}`;
    if (edgeKeys.has(key)) return;
    edgeKeys.add(key);
    edges.push({ from, to, external });
  };

  const enqueue = (link: string, depth: number, from: string): void => {
    let url: URL;
    try {
      url = new URL(link);
    } catch {
      return;
    }

    if (!isInScope(url, root, config.crawl.includeSubdomains)) {
      addEdge(from, link, true);
      return;
    }

    addEdge(from, link, false);

    if (seen.has(link) || robotsBlocked.has(link)) return;

    if (depth > config.crawl.maxDepth) return;

    if (DESTRUCTIVE_PATTERN.test(url.pathname + url.search)) {
      skippedDestructive += 1;
      seen.add(link);
      return;
    }

    if (config.crawl.respectRobots && !isPathAllowed(url.pathname + url.search, robots)) {
      blockedByRobots += 1;
      robotsBlocked.add(link);
      seen.add(link);
      return;
    }

    seen.add(link);
    queue.push({ url: link, depth });
  };

  if (config.crawl.respectRobots) {
    options.onEvent?.('Fetching robots.txt');
    const fetched = await fetchRobots(root.origin, {
      userAgent: USER_AGENT,
      timeoutMs: config.browser.timeoutMs,
      ...(options.signal ? { signal: options.signal } : {}),
    });

    if (fetched) {
      robots = fetched;
    } else {
      notices.push('robots.txt was unavailable; same-origin paths are allowed by default.');
    }
  } else {
    notices.push('robots.txt was intentionally ignored for this run.');
  }

  if (
    config.crawl.respectRobots &&
    !isPathAllowed(root.pathname + root.search, robots)
  ) {
    notices.push(`robots.txt disallows the start URL: ${rootUrl}`);
  } else {
    seen.add(rootUrl);
    queue.push({ url: rootUrl, depth: 0 });
  }

  const maxInterval = 1000 / Math.max(config.crawl.requestsPerSecond, 0.1);
  const limiter = new RateLimiter(Math.max(maxInterval, robots.crawlDelayMs ?? 0));

  const getSession = (): Promise<AuthSession> => {
    sessionState.promise ??= (async () => {
      options.onEvent?.('Launching browser for rendered audits');
      const session = await openSession({
        config,
        ...(options.onEvent ? { onEvent: options.onEvent } : {}),
      });
      sessionState.session = session;
      return session;
    })();

    return sessionState.promise;
  };

  if (authEnabled) {
    const session = await getSession();
    if (session.loginUrl) notices.push('Authenticated crawl: scripted login is active.');
  }

  const auditWithBrowser = async (
    item: QueueItem,
    page: CrawledPage,
    pageStartedMs: number,
  ): Promise<{ links: string[]; external: string[] }> => {
    const rendered: { links: string[]; external: string[] } = { links: [], external: [] };
    options.onEvent?.(`Auditing ${item.url}`);
    const session = await getSession();
    const tab = await session.context.newPage();

    try {
      tab.on('dialog', (dialog) => {
        void dialog.dismiss();
      });
      tab.setDefaultTimeout(config.browser.timeoutMs);
      tab.setDefaultNavigationTimeout(config.browser.timeoutMs);

      let response: Response | null = null;
      try {
        response = await tab.goto(item.url, {
          waitUntil: 'domcontentloaded',
          timeout: config.browser.timeoutMs,
        });
      } catch (error) {
        page.error = error instanceof Error ? error.message : String(error);
        return rendered;
      }

      await tab
        .waitForLoadState('networkidle', {
          timeout: Math.min(5000, config.browser.timeoutMs),
        })
        .catch(() => undefined);
      await tab.waitForTimeout(config.browser.settleMs);

      if (checkExpiry(tab.url(), response?.status() ?? null)) {
        page.error = AUTH_EXPIRED_MESSAGE;
        return rendered;
      }

      const finalUrl = new URL(tab.url());
      await assertSafeTarget(finalUrl, {
        allowPrivate: config.crawl.allowPrivateNetworks,
      });

      if (!isInScope(finalUrl, root, config.crawl.includeSubdomains)) {
        page.error = `Redirected outside the crawl scope: ${finalUrl.toString()}`;
        return rendered;
      }

      try {
        for (const link of await extractRenderedLinks(tab)) {
          const url = new URL(link);
          if (isInScope(url, root, config.crawl.includeSubdomains)) rendered.links.push(link);
          else rendered.external.push(link);
        }
      } catch {
        // Rendered link discovery is best-effort; the static pass already ran.
      }

      const artifactDir = join(run.dir, 'pages', artifactSlug(item.url));
      await mkdir(artifactDir, { recursive: true });

      const audit = await auditLoadedPage({
        page: tab,
        targetUrl: item.url,
        response,
        runDir: run.dir,
        artifactDir,
        config,
        startedMs: pageStartedMs,
        ...(options.onEvent ? { onEvent: options.onEvent } : {}),
      });

      page.audited = true;
      page.finalUrl = audit.finalUrl;
      page.status = audit.status ?? page.status;
      page.title = audit.title || page.title;
      page.metaRobots = audit.metaRobots;
      page.headers = audit.headers;
      page.issues = audit.issues;
      page.keyboardFindings = audit.keyboard.findings.length;
      page.scores = audit.scores;
      page.issueCounts = countIssues(audit.issues);
      page.artifacts = audit.artifacts;

      return rendered;
    } finally {
      await tab.close().catch(() => undefined);
    }
  };

  const crawlOne = async (item: QueueItem): Promise<DiscoveryResult> => {
    const pageStartedMs = Date.now();
    const pageStartedAt = new Date(pageStartedMs).toISOString();
    const discovered: QueueItem[] = [];
    const external: string[] = [];

    const page: CrawledPage = {
      url: item.url,
      finalUrl: item.url,
      status: null,
      title: '',
      metaRobots: null,
      depth: item.depth,
      contentType: '',
      headers: {},
      links: [],
      externalLinks: [],
      audited: false,
      issues: [],
      keyboardFindings: 0,
      scores: { ada: 0, keyboard: 0, overall: 0 },
      issueCounts: { ...EMPTY_IMPACT_COUNTS },
      artifacts: {},
      timings: { startedAt: pageStartedAt, finishedAt: pageStartedAt, durationMs: 0 },
    };

    try {
      await limiter.wait();
      const fetched =
        authEnabled && sessionState.session
          ? await fetchStaticWithRequest(sessionState.session.context.request, item.url, root, config)
          : await fetchStatic(item.url, root, config, options.signal);

      if (!fetched.ok) {
        page.error = fetched.error;
      } else {
        page.finalUrl = fetched.finalUrl;
        page.status = fetched.status;
        page.contentType = fetched.contentType;
        page.headers = redactHeaders(fetched.headers);

        if (checkExpiry(fetched.finalUrl, fetched.status)) {
          page.error = AUTH_EXPIRED_MESSAGE;
        } else if (fetched.outOfScope) {
          page.error = `Redirected outside the crawl scope: ${fetched.finalUrl}`;
          addEdge(item.url, fetched.finalUrl, true);
        } else if (fetched.body !== null) {
          const document = extractDocument(fetched.body, fetched.finalUrl);
          page.title = document.title;
          page.metaRobots = document.metaRobots;

          for (const link of document.links) {
            const url = new URL(link);
            if (isInScope(url, root, config.crawl.includeSubdomains)) {
              page.links.push(link);
              discovered.push({ url: link, depth: item.depth + 1 });
            } else {
              page.externalLinks.push(link);
              external.push(link);
            }
          }
        } else if (fetched.contentType) {
          notices.push(`Skipped non-HTML content at ${item.url} (${fetched.contentType}).`);
        }

        if (
          !authExpired &&
          auditEnabled &&
          fetched.body !== null &&
          fetched.status >= 200 &&
          fetched.status < 400
        ) {
          const rendered = await auditWithBrowser(item, page, pageStartedMs);

          for (const link of rendered.links) {
            if (!page.links.includes(link)) page.links.push(link);
            discovered.push({ url: link, depth: item.depth + 1 });
          }

          for (const link of rendered.external) {
            if (!page.externalLinks.includes(link)) page.externalLinks.push(link);
            external.push(link);
          }
        }
      }
    } catch (error) {
      page.error = error instanceof Error ? error.message : String(error);
    }

    const finishedMs = Date.now();
    page.timings = {
      startedAt: pageStartedAt,
      finishedAt: new Date(finishedMs).toISOString(),
      durationMs: finishedMs - pageStartedMs,
    };

    return { page, discovered, external };
  };

  options.onEvent?.(`Crawling ${rootUrl}`);

  if (config.crawl.respectRobots && robots.sitemaps.length > 0) {
    options.onEvent?.('Reading sitemap.xml');
    for (const sitemap of robots.sitemaps) {
      try {
        const sitemapUrl = new URL(sitemap, root);
        if (!isInScope(sitemapUrl, root, config.crawl.includeSubdomains)) continue;

        const response = await fetch(sitemapUrl.toString(), {
          headers: { 'user-agent': USER_AGENT },
          signal: AbortSignal.timeout(config.browser.timeoutMs),
        });

        if (!response.ok) continue;

        for (const discoveredUrl of extractSitemapUrls(await response.text(), sitemapUrl.toString())) {
          const normalized = normalizeUrl(discoveredUrl);
          enqueue(normalized, 1, rootUrl);
        }
      } catch {
        // Sitemap discovery is best-effort.
      }
    }
  }

  while (queue.length > 0 && pages.length < config.crawl.maxPages && !authExpired) {
    if (options.signal?.aborted) {
      notices.push('Crawl cancelled.');
      break;
    }

    const batch: QueueItem[] = [];
    while (
      batch.length < config.crawl.concurrency &&
      queue.length > 0 &&
      pages.length + batch.length < config.crawl.maxPages
    ) {
      const item = queue.shift();
      if (item) batch.push(item);
    }

    if (batch.length === 0) break;

    const results = await Promise.all(batch.map((item) => crawlOne(item)));

    for (const result of results) {
      pages.push(result.page);
      options.onEvent?.(
        `${result.page.status ?? 'ERR'} ${result.page.url}${result.page.error ? ` — ${result.page.error}` : ''}`,
      );

      for (const item of result.discovered) {
        enqueue(item.url, item.depth, result.page.url);
      }

      for (const link of result.external) {
        addEdge(result.page.url, link, true);
      }
    }
  }

  if (sessionState.promise) {
    const session = await sessionState.promise.catch(() => null);
    if (session) {
      await session.context.close().catch(() => undefined);
      await session.browser.close().catch(() => undefined);
    }
  }

  const finishedMs = Date.now();
  const audited = pages.filter((page) => page.audited);
  const summaryIssues = audited.flatMap((page) => page.issues);
  const issueCounts = countIssues(summaryIssues);
  const adaScore = average(audited.map((page) => page.scores.ada));
  const keyboardScore = average(audited.map((page) => page.scores.keyboard));
  const overall = overallScore(adaScore, keyboardScore);

  if (skippedDestructive > 0) {
    notices.push(
      `Skipped ${skippedDestructive} destructive-looking link(s) (logout/delete/unsubscribe) by default.`,
    );
  }

  if (pages.length >= config.crawl.maxPages && queue.length > 0) {
    notices.push(`Stopped at the maxPages limit (${config.crawl.maxPages}).`);
  }

  const deepestDepth = pages.reduce((max, page) => Math.max(max, page.depth), 0);
  if (config.crawl.maxDepth > 0 && deepestDepth >= config.crawl.maxDepth) {
    notices.push(`Depth limit reached at ${config.crawl.maxDepth}.`);
  }

  if (authExpired) {
    notices.push('Authentication expired; the crawl stopped before auditing the login page.');
  }

  const tree: SiteTreeNode = buildSiteTree(rootUrl, pages);
  const graph: SiteGraph = buildSiteGraph(rootUrl, pages, edges);
  const stats: CrawlStats = {
    pages: pages.length,
    audited: audited.length,
    edges: edges.length,
    externalLinks: edges.filter((edge) => edge.external).length,
    blockedByRobots,
    errors: pages.filter((page) => page.error).length,
    maxDepthReached: pages.reduce((max, page) => Math.max(max, page.depth), 0),
  };

  const manifest: CrawlManifest = {
    schemaVersion: 1,
    id: run.id,
    toolVersion: options.toolVersion,
    rootUrl,
    startedAt,
    finishedAt: new Date(finishedMs).toISOString(),
    durationMs: finishedMs - startedMs,
    config,
    auth: {
      enabled: authEnabled,
      loginUrl: sessionState.session?.loginUrl ?? config.auth.loginUrl ?? null,
      statePath: sessionState.session?.statePath ?? config.auth.statePath ?? null,
      expired: authExpired,
    },
    stats,
    summary: {
      adaScore,
      keyboardScore,
      overallScore: overall,
      issueCounts,
      keyboardFindings: audited.reduce((total, page) => total + page.keyboardFindings, 0),
    },
    pages,
    edges,
    tree,
    graph,
    notices,
  };

  const databasePath = resolve(config.output.dir, 'canopy.db');
  let database: ReturnType<typeof openDatabase> | null = null;

  try {
    database = openDatabase(databasePath);
    saveCrawlRun(database, manifest);
  } catch (error) {
    notices.push(
      `SQLite storage unavailable: ${error instanceof Error ? error.message : String(error)}`,
    );
  } finally {
    database?.close();
  }

  manifest.notices = [...new Set(notices)];

  const manifestPath = join(run.dir, 'crawl.json');
  await writeJson(manifestPath, manifest);
  await writeJson(join(run.dir, 'tree.json'), tree);
  await writeJson(join(run.dir, 'graph.json'), graph);
  await writeText(join(run.dir, 'viewer.html'), renderViewer(manifest));

  return { manifest, runDir: run.dir, manifestPath, authExpired };
}
