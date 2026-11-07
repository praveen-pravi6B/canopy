import { describe, expect, it } from 'vitest';
import {
  extractSitemapUrls,
  isPathAllowed,
  parseRobots,
} from '../src/core/robots.js';

const SAMPLE = `
# Example robots.txt
User-agent: *
Disallow: /private
Allow: /private/public
Disallow: /*.pdf$
Disallow:

User-agent: CanopyBot
Disallow: /admin
Crawl-delay: 2

Sitemap: https://example.com/sitemap.xml
Sitemap: https://example.com/news-sitemap.xml
`;

describe('parseRobots', () => {
  it('merges matching groups for the requested agent', () => {
    const rules = parseRobots(SAMPLE, 'CanopyBot');
    expect(rules.disallow).toContain('/private');
    expect(rules.disallow).toContain('/admin');
    expect(rules.allow).toContain('/private/public');
    expect(rules.crawlDelayMs).toBe(2000);
    expect(rules.sitemaps).toEqual([
      'https://example.com/sitemap.xml',
      'https://example.com/news-sitemap.xml',
    ]);
  });

  it('uses only the wildcard group for unknown agents', () => {
    const rules = parseRobots(SAMPLE, 'OtherBot');
    expect(rules.disallow).toContain('/private');
    expect(rules.disallow).not.toContain('/admin');
  });

  it('matches agent versions and prefixes', () => {
    const rules = parseRobots('User-agent: CanopyBot/0.1\nDisallow: /draft\n', 'CanopyBot/0.1');
    expect(rules.disallow).toEqual(['/draft']);
  });

  it('ignores empty disallow rules', () => {
    const rules = parseRobots('User-agent: *\nDisallow:\n', 'CanopyBot');
    expect(rules.disallow).toEqual([]);
  });

  it('handles an empty ruleset', () => {
    const rules = parseRobots('', 'CanopyBot');
    expect(rules.allow).toEqual([]);
    expect(rules.disallow).toEqual([]);
    expect(rules.crawlDelayMs).toBeNull();
    expect(rules.sitemaps).toEqual([]);
  });
});

describe('isPathAllowed', () => {
  const rules = parseRobots(SAMPLE, 'CanopyBot');

  it('blocks disallowed prefixes', () => {
    expect(isPathAllowed('/private/secret', rules)).toBe(false);
    expect(isPathAllowed('/admin/users', rules)).toBe(false);
  });

  it('lets the more specific allow rule win', () => {
    expect(isPathAllowed('/private/public/page', rules)).toBe(true);
  });

  it('supports wildcard and end-anchor patterns', () => {
    expect(isPathAllowed('/docs/report.pdf', rules)).toBe(false);
    expect(isPathAllowed('/docs/report.pdf?download=1', rules)).toBe(true);
    expect(isPathAllowed('/docs/report.html', rules)).toBe(true);
  });

  it('allows unmatched paths', () => {
    expect(isPathAllowed('/', rules)).toBe(true);
    expect(isPathAllowed('/products/1', rules)).toBe(true);
  });

  it('lets a longer allow rule beat a shorter disallow', () => {
    const local = parseRobots('User-agent: *\nDisallow: /a\nAllow: /a/b\n', 'CanopyBot');
    expect(isPathAllowed('/a/b/c', local)).toBe(true);
    expect(isPathAllowed('/a/c', local)).toBe(false);
  });
});

describe('extractSitemapUrls', () => {
  it('extracts absolute and relative loc entries', () => {
    const xml = `<?xml version="1.0"?>
      <urlset>
        <url><loc>https://example.com/a</loc></url>
        <url><loc>/b</loc></url>
        <url><loc>not a url</loc></url>
      </urlset>`;
    expect(extractSitemapUrls(xml, 'https://example.com/sitemap.xml')).toEqual([
      'https://example.com/a',
      'https://example.com/b',
    ]);
  });
});
