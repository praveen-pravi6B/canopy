import type { Page } from 'playwright';
import { resolveLink } from './html.js';

interface RawLink {
  href: string;
  rel: string;
  download: boolean;
}

/**
 * Collect links from the rendered DOM, including open shadow roots. This is
 * the rendered fallback for client-rendered sites and web components that do
 * not expose their links in the initial HTML.
 */
export async function extractRenderedLinks(page: Page): Promise<string[]> {
  const raw = await page.evaluate(() => {
    const out: Array<{ href: string; rel: string; download: boolean }> = [];
    const seen = new Set<Element>();

    const visit = (root: Document | ShadowRoot): void => {
      const nodes = root.querySelectorAll('a[href], area[href], iframe[src], form[action]');
      for (const element of Array.from(nodes)) {
        if (seen.has(element)) continue;
        seen.add(element);

        const isForm = element.tagName.toLowerCase() === 'form';
        if (isForm && (element.getAttribute('method') ?? 'get').toLowerCase() !== 'get') continue;

        const href = isForm
          ? (element.getAttribute('action') ?? '')
          : (element.getAttribute('href') ?? element.getAttribute('src') ?? '');

        out.push({
          href,
          rel: (element.getAttribute('rel') ?? '').toLowerCase(),
          download: element.hasAttribute('download'),
        });
      }

      for (const element of Array.from(root.querySelectorAll('*'))) {
        const shadow = (element as HTMLElement).shadowRoot;
        if (shadow) visit(shadow);
      }
    };

    visit(document);
    return out;
  });

  const links = new Set<string>();
  const baseUrl = page.url();

  for (const link of raw as RawLink[]) {
    if (link.download || link.rel.includes('nofollow')) continue;
    const resolved = resolveLink(link.href, baseUrl);
    if (resolved) links.add(resolved);
  }

  return [...links];
}
