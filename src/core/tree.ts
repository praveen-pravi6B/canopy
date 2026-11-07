import type {
  CrawlEdge,
  CrawledPage,
  SiteGraph,
  SiteGraphEdge,
  SiteGraphNode,
  SiteTreeNode,
} from './types.js';

function segmentFor(page: CrawledPage): string[] {
  const url = new URL(page.url);
  const segments = url.pathname.split('/').filter(Boolean);
  if (url.search) segments.push(url.search);
  return segments;
}

function childFor(parent: SiteTreeNode, name: string, path: string): SiteTreeNode {
  const existing = parent.children.find((child) => child.name === name);
  if (existing) return existing;

  const child: SiteTreeNode = { name, path, children: [] };
  parent.children.push(child);
  return child;
}

export function buildSiteTree(rootUrl: string, pages: CrawledPage[]): SiteTreeNode {
  const rootUrlObject = new URL(rootUrl);
  const root: SiteTreeNode = {
    name: rootUrlObject.pathname === '/' ? '/' : rootUrlObject.pathname,
    path: '/',
    children: [],
  };

  for (const page of pages) {
    const segments = segmentFor(page);
    let node = root;
    let path = '';

    for (const segment of segments) {
      path += segment.startsWith('?') ? segment : `/${segment}`;
      node = childFor(node, segment, path);
    }

    node.url = page.url;
    node.title = page.title;
    node.status = page.status;
    node.score = page.audited ? page.scores.overall : undefined;

    if (page.url === rootUrl) {
      root.url = page.url;
      root.title = page.title;
      root.status = page.status;
      root.score = page.audited ? page.scores.overall : undefined;
    }
  }

  sortTree(root);
  return root;
}

function sortTree(node: SiteTreeNode): void {
  node.children.sort((a, b) => a.name.localeCompare(b.name));
  for (const child of node.children) sortTree(child);
}

function labelFor(url: string): string {
  const parsed = new URL(url);
  if (parsed.pathname === '/' || parsed.pathname === '') return parsed.host;
  return decodeURIComponent(parsed.pathname);
}

export function buildSiteGraph(
  rootUrl: string,
  pages: CrawledPage[],
  edges: CrawlEdge[],
): SiteGraph {
  const nodes = new Map<string, SiteGraphNode>();
  const pageByUrl = new Map(pages.map((page) => [page.url, page]));

  const addNode = (url: string, external: boolean, depth: number): void => {
    if (nodes.has(url)) return;

    const page = pageByUrl.get(url);
    nodes.set(url, {
      id: url,
      label: labelFor(url),
      title: page?.title ?? (external ? 'External link' : ''),
      depth: page?.depth ?? depth,
      status: page?.status ?? null,
      score: page?.audited ? page.scores.overall : null,
      audited: page?.audited ?? false,
      external,
    });
  };

  addNode(rootUrl, false, 0);
  for (const page of pages) addNode(page.url, false, page.depth);

  const graphEdges: SiteGraphEdge[] = [];
  const seenEdges = new Set<string>();

  for (const edge of edges) {
    const depth = (pageByUrl.get(edge.from)?.depth ?? 0) + 1;
    addNode(edge.to, edge.external, depth);

    const key = `${edge.from}\u0000${edge.to}`;
    if (seenEdges.has(key)) continue;
    seenEdges.add(key);
    graphEdges.push({ from: edge.from, to: edge.to });
  }

  return { nodes: [...nodes.values()], edges: graphEdges };
}
