export interface RobotsRule {
  type: 'allow' | 'disallow';
  path: string;
}

export interface RobotsRules {
  allow: string[];
  disallow: string[];
  crawlDelayMs: number | null;
  sitemaps: string[];
}

export const ALLOW_ALL: RobotsRules = {
  allow: [],
  disallow: [],
  crawlDelayMs: null,
  sitemaps: [],
};

interface RobotsGroup {
  agents: string[];
  rules: RobotsRule[];
  crawlDelaySeconds: number | null;
}

function matchesPattern(pattern: string, path: string): boolean {
  if (pattern === '') return false;

  const anchored = pattern.endsWith('$');
  const body = anchored ? pattern.slice(0, -1) : pattern;

  const escaped = body.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*');

  return new RegExp(`^${escaped}${anchored ? '$' : ''}`).test(path);
}

/**
 * Minimal RFC 9309 parser. Longest matching rule wins; Allow wins ties.
 */
export function parseRobots(text: string, userAgent = 'CanopyBot'): RobotsRules {
  const groups: RobotsGroup[] = [];
  const sitemaps: string[] = [];
  let current: RobotsGroup | null = null;
  let lastWasAgent = false;

  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.replace(/#.*$/, '').trim();
    if (!line) continue;

    const separator = line.indexOf(':');
    if (separator === -1) continue;

    const key = line.slice(0, separator).trim().toLowerCase();
    const value = line.slice(separator + 1).trim();

    if (key === 'user-agent') {
      if (!current || !lastWasAgent) {
        current = { agents: [], rules: [], crawlDelaySeconds: null };
        groups.push(current);
      }
      current.agents.push(value.toLowerCase());
      lastWasAgent = true;
      continue;
    }

    lastWasAgent = false;
    if (key === 'sitemap') {
      if (value) sitemaps.push(value);
      continue;
    }

    if (!current) continue;

    if (key === 'allow' || key === 'disallow') {
      if (value !== '') current.rules.push({ type: key, path: value });
      continue;
    }

    if (key === 'crawl-delay') {
      const seconds = Number(value);
      if (Number.isFinite(seconds) && seconds > 0) current.crawlDelaySeconds = seconds;
    }
  }

  const agentName = userAgent.toLowerCase();
  const selected = groups.filter((group) =>
    group.agents.some(
      (agent) =>
        agent === '*' ||
        agentName.includes(agent) ||
        (agent.includes('/') && agentName.startsWith(agent.split('/')[0] ?? '')),
    ),
  );

  const allow: string[] = [];
  const disallow: string[] = [];
  let crawlDelayMs: number | null = null;

  for (const group of selected) {
    for (const rule of group.rules) {
      if (rule.type === 'allow') allow.push(rule.path);
      else disallow.push(rule.path);
    }

    if (group.crawlDelaySeconds !== null) {
      crawlDelayMs = Math.max(crawlDelayMs ?? 0, group.crawlDelaySeconds * 1000);
    }
  }

  return {
    allow: [...new Set(allow)],
    disallow: [...new Set(disallow)],
    crawlDelayMs,
    sitemaps: [...new Set(sitemaps)],
  };
}

export function isPathAllowed(pathWithQuery: string, rules: RobotsRules): boolean {
  const path = pathWithQuery || '/';

  let bestLength = -1;
  let allowed = true;

  for (const pattern of rules.disallow) {
    if (!matchesPattern(pattern, path)) continue;
    if (pattern.length > bestLength) {
      bestLength = pattern.length;
      allowed = false;
    }
  }

  for (const pattern of rules.allow) {
    if (!matchesPattern(pattern, path)) continue;
    if (pattern.length >= bestLength) {
      bestLength = pattern.length;
      allowed = true;
    }
  }

  return allowed;
}

export interface FetchRobotsOptions {
  userAgent?: string;
  timeoutMs?: number;
  signal?: AbortSignal;
}

export async function fetchRobots(
  origin: string,
  options: FetchRobotsOptions = {},
): Promise<RobotsRules | null> {
  const userAgent = options.userAgent ?? 'CanopyBot';
  const timeoutMs = options.timeoutMs ?? 10_000;

  try {
    const response = await fetch(`${origin}/robots.txt`, {
      redirect: 'follow',
      headers: { 'user-agent': userAgent, accept: 'text/plain' },
      signal: AbortSignal.timeout(timeoutMs),
    });

    if (!response.ok) return null;

    return parseRobots(await response.text(), userAgent);
  } catch {
    return null;
  }
}

export function extractSitemapUrls(xml: string, baseUrl: string): string[] {
  const urls = new Set<string>();
  const pattern = /<loc>\s*([^<\s]+)\s*<\/loc>/gi;

  let match: RegExpExecArray | null;
  while ((match = pattern.exec(xml)) !== null) {
    const value = match[1];
    if (!value) continue;

    try {
      const url = new URL(value, baseUrl);
      if (url.protocol === 'http:' || url.protocol === 'https:') urls.add(url.toString());
    } catch {
      // Ignore malformed sitemap entries.
    }
  }

  return [...urls];
}
