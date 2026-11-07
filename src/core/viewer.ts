import type { CrawlManifest, Issue } from './types.js';

interface ViewerPage {
  url: string;
  title: string;
  status: number | null;
  depth: number;
  audited: boolean;
  score: number | null;
  scores?: { ada: number; keyboard: number; overall: number };
  issueCount: number;
  issueCounts?: { critical: number; serious: number; moderate: number; minor: number };
  keyboardFindings?: number;
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
  auth: CrawlManifest['auth'];
  pages: ViewerPage[];
  tree: CrawlManifest['tree'];
  graph: CrawlManifest['graph'];
  notices: string[];
}


function toViewerData(manifest: CrawlManifest): ViewerData {
  return {
    id: manifest.id,
    rootUrl: manifest.rootUrl,
    generatedAt: manifest.finishedAt,
    summary: manifest.summary,
    stats: manifest.stats,
    auth: manifest.auth,
    pages: manifest.pages.map((page) => ({
      url: page.url,
      title: page.title,
      status: page.status,
      depth: page.depth,
      audited: page.audited,
      score: page.audited ? page.scores.overall : null,
      ...(page.audited ? { scores: page.scores } : {}),
      issueCount: page.issues.length,
      ...(page.audited ? { issueCounts: page.issueCounts } : {}),
      ...(page.audited ? { keyboardFindings: page.keyboardFindings } : {}),
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

  var state = { query: '', selected: null, highlight: -1 };

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

  function renderSummary() {
    var summary = document.getElementById('summary-chips');
    summary.textContent = '';
    var chips = [
      ['Pages', data.stats.pages],
      ['Audited', data.stats.audited],
      ['Links', data.stats.edges],
      ['ADA', data.summary.adaScore + '/100'],
      ['Keyboard', data.summary.keyboardScore + '/100'],
      ['Errors', data.stats.errors]
    ];
    if (data.auth && data.auth.enabled) {
      chips.push(['Auth', data.auth.expired ? 'expired' : 'session']);
    }
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
        if (state.selected === page.url) button.classList.add('selected');
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
    return el('span', 'badge ' + scoreClass(page.score), page.score === null ? '–' : page.score);
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
        if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); select(node.id); }
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
    state.highlight = -1;
    renderTree();
    renderGraph();
    renderDetails();
  }

  function impactColor(impact) {
    if (impact === 'critical') return '#b42318';
    if (impact === 'serious') return '#d92d20';
    if (impact === 'moderate') return '#b54708';
    return '#667085';
  }

  function renderScreenshot(page) {
    if (!page.screenshot) return null;
    var wrap = el('div', 'screenshot-wrap');
    wrap.appendChild(el('h3', null, 'Screenshot & highlights'));

    var stage = el('div', 'screenshot-stage');
    var img = document.createElement('img');
    img.src = page.screenshot;
    img.alt = 'Full-page screenshot of ' + page.url;
    img.loading = 'lazy';
    stage.appendChild(img);

    var overlay = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    overlay.setAttribute('class', 'highlight-overlay');
    overlay.setAttribute('aria-hidden', 'true');
    stage.appendChild(overlay);
    wrap.appendChild(stage);

    var legend = el('p', 'muted small', 'Highlight boxes show elements with recorded positions. Some findings (cross-frame, dynamic) may not have a box.');
    wrap.appendChild(legend);

    function draw() {
      overlay.textContent = '';
      if (!img.naturalWidth) return;
      overlay.setAttribute('viewBox', '0 0 ' + img.naturalWidth + ' ' + img.naturalHeight);
      overlay.style.width = img.clientWidth + 'px';
      overlay.style.height = img.clientHeight + 'px';

      var idx = 0;
      page.issues.forEach(function (issue, issueIndex) {
        (issue.nodes || []).forEach(function (node, nodeIndex) {
          if (!node.rect) return;
          var r = document.createElementNS('http://www.w3.org/2000/svg', 'rect');
          r.setAttribute('x', String(node.rect.x));
          r.setAttribute('y', String(node.rect.y));
          r.setAttribute('width', String(Math.max(2, node.rect.width)));
          r.setAttribute('height', String(Math.max(2, node.rect.height)));
          r.setAttribute('fill', impactColor(issue.impact));
          r.setAttribute('fill-opacity', state.highlight === idx ? '0.28' : '0.12');
          r.setAttribute('stroke', impactColor(issue.impact));
          r.setAttribute('stroke-width', state.highlight === idx ? '4' : '2');
          r.setAttribute('data-hi', String(idx));
          r.style.cursor = 'pointer';
          r.addEventListener('click', function () {
            state.highlight = Number(r.getAttribute('data-hi'));
            draw();
            var target = document.querySelector('[data-issue-index="' + issueIndex + '"]');
            if (target) { target.open = true; target.scrollIntoView({ block: 'nearest', behavior: 'smooth' }); }
          });
          overlay.appendChild(r);
          idx += 1;
        });
      });
    }

    img.addEventListener('load', draw);
    if (img.complete) draw();
    window.addEventListener('resize', draw);
    return wrap;
  }

  function renderDetails() {
    var panel = document.getElementById('details');
    panel.textContent = '';
    state.highlight = -1;

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
    if (page.scores) {
      meta.appendChild(el('span', 'score-chip ' + scoreClass(page.scores.ada), 'ADA ' + page.scores.ada));
      meta.appendChild(el('span', 'score-chip ' + scoreClass(page.scores.keyboard), 'Keyboard ' + page.scores.keyboard));
      meta.appendChild(el('span', 'score-chip ' + scoreClass(page.scores.overall), 'Overall ' + page.scores.overall));
    } else {
      meta.appendChild(el('span', null, page.audited ? 'Score ' + page.score + '/100' : 'Not audited'));
    }
    if (page.issueCounts) {
      meta.appendChild(el('span', null, page.issueCounts.critical + ' critical'));
      meta.appendChild(el('span', null, page.issueCounts.serious + ' serious'));
    }
    panel.appendChild(meta);

    var actions = el('div', 'actions');
    var open = el('a', 'button', 'Open page');
    open.href = page.url; open.target = '_blank'; open.rel = 'noreferrer noopener';
    actions.appendChild(open);
    if (page.dom) {
      var dom = el('a', 'button', 'Saved DOM');
      dom.href = page.dom; dom.target = '_blank'; dom.rel = 'noreferrer noopener';
      actions.appendChild(dom);
    }
    var focus = el('button', 'button', 'Show in graph');
    focus.type = 'button';
    focus.addEventListener('click', function () {
      document.getElementById('graph').scrollIntoView({ behavior: 'smooth', block: 'center' });
    });
    actions.appendChild(focus);
    panel.appendChild(actions);

    if (!page.audited) {
      panel.appendChild(el('p', 'muted', 'This page was crawled for structure only.'));
      return;
    }

    var shot = renderScreenshot(page);
    if (shot) panel.appendChild(shot);

    if (!page.issues.length) {
      panel.appendChild(el('p', 'clean', 'No automated findings on this page.'));
      return;
    }

    panel.appendChild(el('h3', null, 'Findings (' + page.issues.length + ')'));

    page.issues.forEach(function (issue, issueIndex) {
      var details = el('details', 'issue impact-' + issue.impact);
      details.setAttribute('data-issue-index', String(issueIndex));
      var summary = el('summary');
      summary.appendChild(el('span', 'impact', issue.impact));
      summary.appendChild(el('span', 'source', issue.source));
      summary.appendChild(el('span', 'rule', issue.ruleId));
      details.appendChild(summary);

      details.appendChild(el('p', null, issue.description));
      details.appendChild(el('p', 'help', issue.help));

      if (issue.tags && issue.tags.length) {
        var tags = el('div', 'tags');
        issue.tags.slice(0, 8).forEach(function (tag) { tags.appendChild(el('span', 'tag', tag)); });
        details.appendChild(tags);
      }

      if (issue.helpUrl) {
        var link = el('a', null, 'Guidance');
        link.href = issue.helpUrl; link.target = '_blank'; link.rel = 'noreferrer noopener';
        details.appendChild(link);
      }

      (issue.nodes || []).slice(0, 12).forEach(function (node) {
        var card = el('div', 'node-card');
        if (node.target && node.target.length) {
          card.appendChild(el('code', 'selector', node.target.join(' ')));
        }
        if (node.rect) {
          card.appendChild(el('span', 'rect-info', ' @ ' + node.rect.x + ',' + node.rect.y + ' ' + node.rect.width + '×' + node.rect.height));
        }
        if (node.failureSummary) {
          card.appendChild(el('p', 'failure', node.failureSummary));
        }
        if (node.html) {
          var pre = el('pre', 'node-html');
          pre.textContent = String(node.html).slice(0, 400);
          card.appendChild(pre);
        }
        details.appendChild(card);
      });

      if ((issue.nodes || []).length > 12) {
        details.appendChild(el('p', 'muted small', '… and ' + (issue.nodes.length - 12) + ' more node(s)'));
      }

      panel.appendChild(details);
    });
  }

  function renderNotices() {
    if (!data.notices.length) return;
    var host = document.getElementById('notices');
    host.textContent = '';
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

function escapeHtml(value: string): string {
  return value.replace(
    /[&<>"']/g,
    (character) =>
      ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character] ??
      character,
  );
}

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
    --bg: #f7f8fa; --panel: #fff; --ink: #101828; --muted: #667085;
    --line: #d0d5dd; --accent: #1a56db; --good: #067647; --warn: #b54708; --bad: #b42318; --focus: #1a56db;
  }
  * { box-sizing: border-box; }
  body { margin: 0; background: var(--bg); color: var(--ink); font: 15px/1.5 system-ui, -apple-system, "Segoe UI", sans-serif; }
  a { color: var(--accent); }
  :focus-visible { outline: 3px solid var(--focus); outline-offset: 2px; }
  header { background: var(--panel); border-bottom: 1px solid var(--line); padding: 1rem 1.5rem; position: sticky; top: 0; z-index: 5; }
  header h1 { margin: 0 0 0.25rem; font-size: 1.15rem; }
  header p { margin: 0; color: var(--muted); overflow-wrap: anywhere; }
  .chips { display: flex; flex-wrap: wrap; gap: 0.5rem; margin-top: 0.75rem; }
  .chip { border: 1px solid var(--line); border-radius: 999px; padding: 0.15rem 0.7rem; background: var(--bg); font-size: 0.85rem; }
  .chip strong { font-variant-numeric: tabular-nums; }
  .bar { display: flex; flex-wrap: wrap; gap: 0.75rem; align-items: center; padding: 0.75rem 1.5rem; background: var(--panel); border-bottom: 1px solid var(--line); }
  .bar label { font-weight: 600; }
  .bar input { min-width: 16rem; padding: 0.45rem 0.6rem; border: 1px solid var(--line); border-radius: 7px; font: inherit; }
  .bar span { color: var(--muted); font-size: 0.85rem; }
  #layout { display: grid; grid-template-columns: minmax(220px, 300px) minmax(0, 1fr) minmax(320px, 420px); gap: 1rem; padding: 1rem 1.5rem 2rem; align-items: start; }
  @media (max-width: 1100px) { #layout { grid-template-columns: 1fr; } }
  .panel { background: var(--panel); border: 1px solid var(--line); border-radius: 12px; padding: 0.9rem 1rem; max-height: calc(100vh - 13rem); overflow: auto; }
  .panel h2 { margin: 0 0 0.35rem; font-size: 1.05rem; overflow-wrap: anywhere; }
  .panel h3 { margin: 1rem 0 0.5rem; font-size: 0.95rem; }
  .url { color: var(--muted); font-size: 0.8rem; overflow-wrap: anywhere; margin: 0 0 0.75rem; }
  ul { list-style: none; margin: 0; padding-left: 0.9rem; }
  #tree > ul { padding-left: 0; }
  .tree-group > summary { cursor: pointer; padding: 0.15rem 0.25rem; border-radius: 5px; font-weight: 600; color: var(--muted); }
  .tree-group > summary:hover { background: var(--bg); }
  .tree-page { display: flex; gap: 0.5rem; align-items: center; width: 100%; text-align: left; border: 0; background: none; padding: 0.2rem 0.25rem; border-radius: 5px; color: var(--ink); font: inherit; cursor: pointer; overflow-wrap: anywhere; }
  .tree-page:hover { background: var(--bg); }
  .tree-page.selected { background: #e8efff; color: #0b3a9c; }
  .badge { flex: none; min-width: 2rem; text-align: center; border-radius: 999px; padding: 0 0.35rem; font-size: 0.75rem; font-weight: 700; background: var(--bg); color: var(--muted); }
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
  .small { font-size: 0.8rem; }
  .clean { color: var(--good); font-weight: 600; }
  .meta { display: flex; flex-wrap: wrap; gap: 0.4rem; margin: 0.25rem 0 0.75rem; }
  .meta span, .score-chip { background: var(--bg); border: 1px solid var(--line); border-radius: 999px; padding: 0.1rem 0.55rem; font-size: 0.78rem; }
  .score-chip.score-good { border-color: #abefc6; background: #ecfdf3; }
  .score-chip.score-warn { border-color: #fedf89; background: #fffaeb; }
  .score-chip.score-bad { border-color: #fecdca; background: #fef3f2; }
  .actions { display: flex; gap: 0.5rem; flex-wrap: wrap; margin-bottom: 0.75rem; }
  .button { display: inline-block; border: 1px solid var(--line); background: var(--panel); color: var(--ink); border-radius: 7px; padding: 0.35rem 0.65rem; font: inherit; font-size: 0.85rem; text-decoration: none; cursor: pointer; }
  .button:hover { background: var(--bg); }
  .screenshot-wrap { margin: 0.75rem 0 1rem; }
  .screenshot-stage { position: relative; display: inline-block; max-width: 100%; border: 1px solid var(--line); border-radius: 8px; overflow: hidden; background: #fff; }
  .screenshot-stage img { display: block; max-width: 100%; height: auto; }
  .highlight-overlay { position: absolute; left: 0; top: 0; pointer-events: all; }
  .issue { border-top: 1px solid var(--line); padding: 0.45rem 0; }
  .issue summary { cursor: pointer; display: flex; gap: 0.5rem; align-items: baseline; flex-wrap: wrap; }
  .issue .impact { text-transform: uppercase; font-size: 0.66rem; font-weight: 700; letter-spacing: 0.03em; }
  .issue .source { font-size: 0.66rem; color: var(--muted); text-transform: uppercase; }
  .impact-critical .impact { color: #912018; }
  .impact-serious .impact { color: #b42318; }
  .impact-moderate .impact { color: #b54708; }
  .impact-minor .impact { color: #475467; }
  .issue .rule { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 0.8rem; }
  .issue p { margin: 0.35rem 0; font-size: 0.85rem; }
  .issue .help { color: var(--muted); }
  .tags { display: flex; flex-wrap: wrap; gap: 0.3rem; margin: 0.35rem 0; }
  .tag { font-size: 0.72rem; background: var(--bg); border: 1px solid var(--line); border-radius: 4px; padding: 0 0.35rem; }
  .node-card { margin: 0.4rem 0; padding: 0.45rem 0.55rem; background: var(--bg); border-radius: 6px; font-size: 0.82rem; }
  .selector { display: block; font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 0.75rem; overflow-wrap: anywhere; }
  .rect-info { color: var(--muted); font-size: 0.72rem; }
  .failure { white-space: pre-wrap; margin: 0.25rem 0; }
  .node-html { margin: 0.25rem 0 0; padding: 0.35rem; background: #fff; border: 1px solid var(--line); border-radius: 4px; font-size: 0.72rem; overflow: auto; max-height: 8rem; white-space: pre-wrap; overflow-wrap: anywhere; }
  .notices p { margin: 0.5rem 1.5rem; background: #fff8e5; border: 1px solid #f5c76b; border-radius: 7px; padding: 0.5rem 0.75rem; }
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
