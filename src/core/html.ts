import { parse } from 'node-html-parser';
import { normalizeUrl } from './url.js';

export interface ExtractedDocument {
  title: string;
  metaRobots: string | null;
  links: string[];
}

const SKIP_SCHEMES = /^(mailto|tel|sms|javascript|data|blob|about):/i;

function resolveLink(raw: string | undefined | null, baseUrl: string): string | null {
  if (!raw) return null;

  const href = raw.trim();
  if (!href || href === '#' || SKIP_SCHEMES.test(href)) return null;

  try {
    const url = new URL(href, baseUrl);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
    return normalizeUrl(url.toString());
  } catch {
    return null;
  }
}

/**
 * Static-first link discovery. Runs before any browser render so the crawler
 * can map a site without executing JavaScript.
 */
export function extractDocument(html: string, baseUrl: string): ExtractedDocument {
  const root = parse(html, { comment: false });

  const title = root.querySelector('title')?.text.trim() ?? '';
  const metaRobots = root.querySelector('meta[name="robots"]')?.getAttribute('content') ?? null;

  const links = new Set<string>();

  for (const element of root.querySelectorAll('a[href], area[href]')) {
    if (element.getAttribute('download') !== undefined) continue;

    const rel = element.getAttribute('rel')?.toLowerCase() ?? '';
    if (rel.includes('nofollow')) continue;

    const resolved = resolveLink(element.getAttribute('href'), baseUrl);
    if (resolved) links.add(resolved);
  }

  for (const element of root.querySelectorAll('iframe[src]')) {
    const resolved = resolveLink(element.getAttribute('src'), baseUrl);
    if (resolved) links.add(resolved);
  }

  for (const form of root.querySelectorAll('form')) {
    const method = (form.getAttribute('method') ?? 'get').toLowerCase();
    if (method !== 'get') continue;

    const resolved = resolveLink(form.getAttribute('action'), baseUrl);
    if (resolved) links.add(resolved);
  }

  return { title, metaRobots, links: [...links] };
}
