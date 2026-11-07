import type { CrawlManifest, Issue } from './types.js';

interface ViewerPage {
  url: string;
  title: string;
  status: number | null;
  depth: number;
  audited: boolean;
  score: number | null;
  issueCount: number;
  issues: Issue[];
  screenshot?: string;
  dom?: string;
}

interface ViewerData {
  id: string;
  rootUrl: string;
  generatedAt: string;
  summary: CrawlManifest['summary'];
  stats: CrawlManifest['stats'];
  pages: ViewerPage[];
  tree: CrawlManifest['tree'];
  graph: CrawlManifest['graph'];
  notices: string[];
}

function escapeHtml(value: string): string {
  return value.replace(
    /[&<>"']/g,
    (character) =>
      ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character] ??
      character,
  );
}

function toViewerData(manifest: CrawlManifest): ViewerData {
  return {
    id: manifest.id,
    rootUrl: manifest.rootUrl,
    generatedAt: manifest.finishedAt,
    summary: manifest.summary,
    stats: manifest.stats,
    pages: manifest.pages.map((page) => ({
      url: page.url,
      title: page.title,
      status: page.status,
      depth: page.depth,
      audited: page.audited,
      score: page.audited ? page.scores.overall : null,
      issueCount: page.issues.length,
      issues: page.issues,
      ...(page.artifacts.screenshot ? { screenshot: page.artifacts.screenshot } : {}),
      ...(page.artifacts.dom ? { dom: page.artifacts.dom } : {}),
    })),
    tree: manifest.tree,
    graph: manifest.graph,
    notices: manifest.notices,
  };
}

const CLIENT_JS = String.raw`
(function () {
  'use strict';

  var data = JSON.parse(document.getElementById('canopy-data').textContent);
  var pageByUrl = {};
  data.pages.forEach(function (page) { pageByUrl[page.url] = page; });

  var state = { query: '', selected: null };

  function el(tag, className, text) {
    var node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined && text !== null) node.textContent = String(text);
    return node;
  }

  function scoreClass(score) {
    if (score === null || score === undefined) return 'score-na';
    if (score >= 90) return 'score-good';
    if (score >= 70) return 'score-warn';
    return 'score-bad';
  }

  function matches(page) {
    if (!state.query) return true;
    var query = state.query.toLowerCase();
    return (
      page.url.toLowerCase().indexOf(query) !== -1 ||
      (page.title || '').toLowerCase().indexOf(query) !== -1
    );
  }

  function issueLabel(issue) {
    return issue.impact.toUpperCase() + ' · ' + issue.ruleId;
  }

  function renderSummary() {
    var summary = document.getElementById('summary-chips');
    var chips = [
      ['Pages', data.stats.pages],
      ['Audited', data.stats.audited],
      ['Links', data.stats.edges],
      ['ADA', data.summary.adaScore + '/100'],
      ['Keyboard', data.summary.keyboardScore + '/100'],
      ['Errors', data.stats.errors]
    ];
    chips.forEach(function (pair) {
      var chip = el('span', 'chip');
      chip.appendChild(el('strong', null, pair[1]));
      chip.appendChild(document.createTextNode(' ' + pair[0]));
      summary.appendChild(chip);
    });
  }

  function renderTree() {
    var host = document.getElementById('tree');
    host.textContent = '';

    function walkInto(node, depth, list) {
      var wrapper = el('li', 'tree-branch');
      var hasChildren = node.children && node.children.length > 0;

      if (!hasChildren) {
        var page = pageByUrl[node.url];
        if (!page || !matches(page)) return;
        var button = el('button', 'tree-page', node.name);
        button.type = 'button';
        button.title = node.title || node.url;
        button.appendChild(scoreBadge(page));
        if (state.selected === node.url) button.classList.add('selected');
        button.addEventListener('click', function () { select(node.url); });
        wrapper.appendChild(button);
        list.appendChild(wrapper);
        return;
      }

      if (node.url) {
        var pageNode = pageByUrl[node.url];
        if (pageNode && !matches(pageNode) && !subtreeMatches(node)) return;
      } else if (!subtreeMatches(node)) {
        return;
      }

      var details = el('details', 'tree-group');
      details.open = depth < 2;
      details.appendChild(el('summary', null, node.name));
      var childList = el('ul');
      node.children.forEach(function (child) { walkInto(child, depth + 1, childList); });
      details.appendChild(childList);
      wrapper.appendChild(details);
      list.appendChild(wrapper);
    }

    function renderRoot() {
      var list = el('ul');
      var rootNode = data.tree;
      var page = rootNode.url ? pageByUrl[rootNode.url] : null;
      if (page && matches(page)) {
        var button = el('button', 'tree-page', '/ (home)');
        button.type = 'button';
        button.appendChild(scoreBadge(page));
        button.addEventListener('click', function () { select(page.url); });
        var item = el('li');
        item.appendChild(button);
        list.appendChild(item);
      }
      rootNode.children.forEach(function (child) { walkInto(child, 0, list); });
      host.appendChild(list);
    }

    renderRoot();
  }

  function subtreeMatches(node) {
    if (node.url) {
      var page = pageByUrl[node.url];
      if (page && matches(page)) return true;
    }
    return (node.children || []).some(subtreeMatches);
  }

  function scoreBadge(page) {
    var badge = el('span', 'badge ' + scoreClass(page.score), page.score === null ? '–' : page.score);
    return badge;
  }

  function renderGraph() {
    var svg = document.getElementById('graph');
    svg.textContent = '';
    var NS = 'http://www.w3.org/2000/svg';

    var nodes = data.graph.nodes.filter(function (node) {
      var page = pageByUrl[node.id];
      return !page || matches(page);
    });
    var visible = {};
    nodes.forEach(function (node) { visible[node.id] = true; });

    var layers = {};
    nodes.forEach(function (node) {
      var depth = Math.max(0, node.depth || 0);
      if (!layers[depth]) layers[depth] = [];
      layers[depth].push(node);
    });

    var columnWidth = 230;
    var rowHeight = 58;
    var offscreen = document.createElementNS(NS, 'g');
    var width = 280;
    var height = 200;
    var positions = {};

    Object.keys(layers).map(Number).sort(function (a, b) { return a - b; }).forEach(function (depth) {
      var column = layers[depth];
      column.sort(function (a, b) { return a.label.localeCompare(b.label); });
      column.forEach(function (node, index) {
        var x = 32 + depth * columnWidth;
        var y = 40 + index * rowHeight;
        positions[node.id] = { x: x, y: y };
        width = Math.max(width, x + columnWidth);
        height = Math.max(height, y + rowHeight + 20);
      });
    });

    data.graph.edges.forEach(function (edge) {
      if (!visible[edge.from] || !visible[edge.to]) return;
      var from = positions[edge.from];
      var to = positions[edge.to];
      if (!from || !to) return;
      var line = document.createElementNS(NS, 'line');
      line.setAttribute('x1', String(from.x + 92));
      line.setAttribute('y1', String(from.y + 15));
      line.setAttribute('x2', String(to.x));
      line.setAttribute('y2', String(to.y + 15));
      line.setAttribute('class', 'edge');
      offscreen.appendChild(line);
    });

    nodes.forEach(function (node) {
      var position = positions[node.id];
      if (!position) return;
      var group = document.createElementNS(NS, 'g');
      group.setAttribute('class', 'node ' + (node.external ? 'external' : scoreClass(node.score)));
      group.setAttribute('tabindex', '0');
      group.setAttribute('role', 'button');
      group.setAttribute('aria-label', node.label + (node.title ? ', ' + node.title : ''));

      var rect = document.createElementNS(NS, 'rect');
      rect.setAttribute('x', String(position.x));
      rect.setAttribute('y', String(position.y));
      rect.setAttribute('width', '150');
      rect.setAttribute('height', '32');
      rect.setAttribute('rx', '7');
      group.appendChild(rect);

      var label = document.createElementNS(NS, 'text');
      label.setAttribute('x', String(position.x + 10));
      label.setAttribute('y', String(position.y + 20));
      var text = node.label.length > 22 ? node.label.slice(0, 21) + '…' : node.label;
      label.textContent = text;
      group.appendChild(label);

      group.addEventListener('click', function () { select(node.id); });
      group.addEventListener('keydown', function (event) {
        if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault();
          select(node.id);
        }
      });

      if (state.selected === node.id) group.classList.add('selected');
      offscreen.appendChild(group);
    });

    svg.setAttribute('viewBox', '0 0 ' + width + ' ' + height);
    svg.setAttribute('width', String(width));
    svg.setAttribute('height', String(height));
    svg.appendChild(offscreen);
  }

  function select(url) {
    state.selected = url;
    renderTree();
    renderGraph();
    renderDetails();
  }

  function renderDetails() {
    var panel = document.getElementById('details');
    panel.textContent = '';

    if (!state.selected) {
      panel.appendChild(el('p', 'muted', 'Select a page in the tree or graph.'));
      return;
    }

    var page = pageByUrl[state.selected];
    var graphNode = data.graph.nodes.filter(function (node) { return node.id === state.selected; })[0];
    var title = page ? page.title : (graphNode ? graphNode.title : state.selected);

    panel.appendChild(el('h2', null, title || '(untitled)'));
    panel.appendChild(el('p', 'url', state.selected));

    if (!page) {
      panel.appendChild(el('p', 'muted', 'External link — not crawled.'));
      return;
    }

    var meta = el('div', 'meta');
    meta.appendChild(el('span', null, 'Status ' + (page.status === null ? 'unknown' : page.status)));
    meta.appendChild(el('span', null, 'Depth ' + page.depth));
    meta.appendChild(el('span', null, page.audited ? 'Score ' + page.score + '/100' : 'Not audited'));
    meta.appendChild(el('span', null, page.issueCount + ' findings'));
    panel.appendChild(meta);

    var actions = el('div', 'actions');
    var open = el('a', 'button', 'Open page');
    open.href = page.url;
    open.target = '_blank';
    open.rel = 'noreferrer noopener';
    actions.appendChild(open);

    if (graphNode) {
      var focus = el('button', 'button', 'Show in graph');
      focus.type = 'button';
      focus.addEventListener('click', function () {
        document.getElementById('graph').scrollIntoView({ behavior: 'smooth', block: 'center' });
        select(page.url);
      });
      actions.appendChild(focus);
    }
    panel.appendChild(actions);

    if (!page.audited) {
      panel.appendChild(el('p', 'muted', 'This page was crawled for structure only.'));
      return;
    }

    if (!page.issues.length) {
      panel.appendChild(el('p', 'clean', 'No automated findings on this page.'));
      return;
    }

    var heading = el('h3', null, 'Findings');
    panel.appendChild(heading);

    page.issues.forEach(function (issue) {
      var details = el('details', 'issue ' + 'impact-' + issue.impact);
      var summary = el('summary');
      summary.appendChild(el('span', 'impact', issue.impact));
      summary.appendChild(el('span', 'rule', issue.ruleId));
      details.appendChild(summary);
      details.appendChild(el('p', null, issue.description));
      details.appendChild(el('p', 'help', issue.help));

      if (issue.helpUrl) {
        var link = el('a', null, 'WCAG guidance');
        link.href = issue.helpUrl;
        link.target = '_blank';
        link.rel = 'noreferrer noopener';
        details.appendChild(link);
      }

      var selectors = [];
      issue.nodes.forEach(function (node) {
        if (node.target && node.target.length) selectors.push(node.target.join(' '));
      });
      if (selectors.length) {
        var list = el('ul', 'selectors');
        selectors.slice(0, 12).forEach(function (selector) {
          list.appendChild(el('li', null, selector));
        });
        details.appendChild(list);
      }

      panel.appendChild(details);
    });
  }

  function renderNotices() {
    if (!data.notices.length) return;
    var host = document.getElementById('notices');
    data.notices.forEach(function (message) { host.appendChild(el('p', null, message)); });
  }

  document.getElementById('search').addEventListener('input', function (event) {
    state.query = event.target.value.trim();
    renderTree();
    renderGraph();
  });

  document.getElementById('run-id').textContent = data.id;
  document.getElementById('generated').textContent = new Date(data.generatedAt).toLocaleString();
  renderSummary();
  renderNotices();
  renderTree();
  renderGraph();
  renderDetails();
})();
`;

export function renderViewer(manifest: CrawlManifest): string {
  const data = toViewerData(manifest);
  const json = JSON.stringify(data).replace(/</g, '\\u003c');
  const rootUrl = escapeHtml(manifest.rootUrl);

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>Canopy — ${rootUrl}</title>
<style>
  :root {
    color-scheme: light;
    --bg: #f7f8fa;
    --panel: #ffffff;
    --ink: #101828;
    --muted: #667085;
    --line: #d0d5dd;
    --accent: #1a56db;
    --good: #067647;
    --warn: #b54708;
    --bad: #b42318;
    --focus: #1a56db;
  }
  * { box-sizing: border-box; }
  body {
    margin: 0;
    background: var(--bg);
    color: var(--ink);
    font: 15px/1.5 system-ui, -apple-system, "Segoe UI", sans-serif;
  }
  a { color: var(--accent); }
  :focus-visible { outline: 3px solid var(--focus); outline-offset: 2px; }
  header {
    background: var(--panel);
    border-bottom: 1px solid var(--line);
    padding: 1rem 1.5rem;
    position: sticky;
    top: 0;
    z-index: 5;
  }
  header h1 { margin: 0 0 0.25rem; font-size: 1.15rem; }
  header p { margin: 0; color: var(--muted); overflow-wrap: anywhere; }
  .chips { display: flex; flex-wrap: wrap; gap: 0.5rem; margin-top: 0.75rem; }
  .chip {
    border: 1px solid var(--line);
    border-radius: 999px;
    padding: 0.15rem 0.7rem;
    background: var(--bg);
    font-size: 0.85rem;
  }
  .chip strong { font-variant-numeric: tabular-nums; }
  .bar {
    display: flex;
    flex-wrap: wrap;
    gap: 0.75rem;
    align-items: center;
    padding: 0.75rem 1.5rem;
    background: var(--panel);
    border-bottom: 1px solid var(--line);
  }
  .bar label { font-weight: 600; }
  .bar input {
    min-width: 16rem;
    padding: 0.45rem 0.6rem;
    border: 1px solid var(--line);
    border-radius: 7px;
    font: inherit;
  }
  .bar span { color: var(--muted); font-size: 0.85rem; }
  #layout {
    display: grid;
    grid-template-columns: minmax(240px, 320px) minmax(0, 1fr) minmax(280px, 360px);
    gap: 1rem;
    padding: 1rem 1.5rem 2rem;
    align-items: start;
  }
  @media (max-width: 1100px) {
    #layout { grid-template-columns: 1fr; }
  }
  .panel {
    background: var(--panel);
    border: 1px solid var(--line);
    border-radius: 12px;
    padding: 0.9rem 1rem;
    max-height: calc(100vh - 13rem);
    overflow: auto;
  }
  .panel h2 { margin: 0 0 0.35rem; font-size: 1.05rem; overflow-wrap: anywhere; }
  .panel h3 { margin: 1rem 0 0.5rem; font-size: 0.95rem; }
  .url { color: var(--muted); font-size: 0.8rem; overflow-wrap: anywhere; margin: 0 0 0.75rem; }
  ul { list-style: none; margin: 0; padding-left: 0.9rem; }
  #tree > ul { padding-left: 0; }
  .tree-group > summary {
    cursor: pointer;
    padding: 0.15rem 0.25rem;
    border-radius: 5px;
    font-weight: 600;
    color: var(--muted);
  }
  .tree-group > summary:hover { background: var(--bg); }
  .tree-page {
    display: flex;
    gap: 0.5rem;
    align-items: center;
    width: 100%;
    text-align: left;
    border: 0;
    background: none;
    padding: 0.2rem 0.25rem;
    border-radius: 5px;
    color: var(--ink);
    font: inherit;
    cursor: pointer;
    overflow-wrap: anywhere;
  }
  .tree-page:hover { background: var(--bg); }
  .tree-page.selected { background: #e8efff; color: #0b3a9c; }
  .badge {
    flex: none;
    min-width: 2rem;
    text-align: center;
    border-radius: 999px;
    padding: 0 0.35rem;
    font-size: 0.75rem;
    font-weight: 700;
    background: var(--bg);
    color: var(--muted);
  }
  .score-good { color: var(--good); }
  .score-warn { color: var(--warn); }
  .score-bad { color: var(--bad); }
  .node.score-good rect { fill: #e8f7ef; stroke: #067647; }
  .node.score-warn rect { fill: #fff4e5; stroke: #b54708; }
  .node.score-bad rect { fill: #fdeceb; stroke: #b42318; }
  .node.score-na rect, .node.external rect { fill: #f2f4f7; stroke: #98a2b3; stroke-dasharray: 4 3; }
  .node text { fill: var(--ink); font: 12px system-ui, sans-serif; }
  .node { cursor: pointer; }
  .node.selected rect { stroke-width: 3; }
  .edge { stroke: #b8c0cc; stroke-width: 1.2; }
  #graph-wrap { overflow: auto; }
  #graph { display: block; min-width: 100%; }
  .muted { color: var(--muted); }
  .clean { color: var(--good); font-weight: 600; }
  .meta { display: flex; flex-wrap: wrap; gap: 0.4rem; margin: 0.25rem 0 0.75rem; }
  .meta span {
    background: var(--bg);
    border: 1px solid var(--line);
    border-radius: 999px;
    padding: 0.1rem 0.55rem;
    font-size: 0.78rem;
  }
  .actions { display: flex; gap: 0.5rem; margin-bottom: 0.75rem; }
  .button {
    display: inline-block;
    border: 1px solid var(--line);
    background: var(--panel);
    color: var(--ink);
    border-radius: 7px;
    padding: 0.35rem 0.65rem;
    font: inherit;
    font-size: 0.85rem;
    text-decoration: none;
    cursor: pointer;
  }
  .button:hover { background: var(--bg); }
  .issue { border-top: 1px solid var(--line); padding: 0.45rem 0; }
  .issue summary { cursor: pointer; display: flex; gap: 0.5rem; align-items: baseline; }
  .issue .impact {
    text-transform: uppercase;
    font-size: 0.66rem;
    font-weight: 700;
    letter-spacing: 0.03em;
  }
  .impact-critical .impact { color: #912018; }
  .impact-serious .impact { color: #b42318; }
  .impact-moderate .impact { color: #b54708; }
  .impact-minor .impact { color: #475467; }
  .issue .rule { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 0.8rem; }
  .issue p { margin: 0.35rem 0; font-size: 0.85rem; }
  .issue .help { color: var(--muted); }
  .selectors { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 0.75rem; }
  .selectors li { padding: 0.1rem 0; overflow-wrap: anywhere; }
  .notices { margin: 0 1.5rem; }
  .notices p { background: #fff8e5; border: 1px solid #f5c76b; border-radius: 7px; padding: 0.5rem 0.75rem; }
</style>
</head>
<body>
<header>
  <h1>Canopy site report</h1>
  <p>${rootUrl}</p>
  <div class="chips" id="summary-chips"></div>
</header>
<div class="bar">
  <label for="search">Filter pages</label>
  <input id="search" type="search" placeholder="URL or title" autocomplete="off" />
  <span>Run <code id="run-id"></code></span>
  <span>Generated <span id="generated"></span></span>
</div>
<main id="main">
  <div id="notices"></div>
  <div id="layout">
    <section class="panel" aria-label="Site tree">
      <h2>Tree</h2>
      <div id="tree"></div>
    </section>
    <section class="panel" id="graph-wrap" aria-label="Link graph">
      <h2>Link graph</h2>
      <svg id="graph" role="img" aria-label="Same-origin link graph"></svg>
    </section>
    <aside class="panel" id="details" aria-live="polite" aria-label="Page details"></aside>
  </div>
</main>
<script type="application/json" id="canopy-data">${json}</script>
<script>${CLIENT_JS}</script>
</body>
</html>
`;
}
