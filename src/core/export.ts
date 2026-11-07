import type { CrawlManifest, Issue } from './types.js';

export interface FindingRow {
  pageUrl: string;
  pageTitle: string;
  source: Issue['source'];
  ruleId: string;
  impact: Issue['impact'];
  description: string;
  help: string;
  helpUrl: string;
  selectors: string;
  tags: string;
  nodeCount: number;
}

function csvEscape(value: string | number): string {
  const text = String(value);
  if (/[",\n\r]/.test(text)) return `"${text.replace(/"/g, '""')}"`;
  return text;
}

export function crawlFindings(manifest: CrawlManifest): FindingRow[] {
  const rows: FindingRow[] = [];
  for (const page of manifest.pages) {
    for (const issue of page.issues) {
      rows.push({
        pageUrl: page.url,
        pageTitle: page.title,
        source: issue.source,
        ruleId: issue.ruleId,
        impact: issue.impact,
        description: issue.description,
        help: issue.help,
        helpUrl: issue.helpUrl ?? '',
        selectors: issue.nodes.map((node) => node.target.join(' ')).join(' | '),
        tags: issue.tags.join(' '),
        nodeCount: issue.nodes.length,
      });
    }
  }
  return rows;
}

export function findingsToCsv(manifest: CrawlManifest): string {
  const header = [
    'page_url',
    'page_title',
    'source',
    'rule_id',
    'impact',
    'description',
    'help',
    'help_url',
    'selectors',
    'tags',
    'node_count',
  ];
  const lines = [header.join(',')];
  for (const row of crawlFindings(manifest)) {
    lines.push(
      [
        row.pageUrl,
        row.pageTitle,
        row.source,
        row.ruleId,
        row.impact,
        row.description,
        row.help,
        row.helpUrl,
        row.selectors,
        row.tags,
        row.nodeCount,
      ]
        .map(csvEscape)
        .join(','),
    );
  }
  return `${lines.join('\n')}\n`;
}

export function summaryForExport(manifest: CrawlManifest): Record<string, unknown> {
  return {
    schemaVersion: manifest.schemaVersion,
    id: manifest.id,
    toolVersion: manifest.toolVersion,
    rootUrl: manifest.rootUrl,
    startedAt: manifest.startedAt,
    finishedAt: manifest.finishedAt,
    durationMs: manifest.durationMs,
    auth: manifest.auth,
    stats: manifest.stats,
    summary: manifest.summary,
    notices: manifest.notices,
    pages: manifest.pages.map((page) => ({
      url: page.url,
      finalUrl: page.finalUrl,
      status: page.status,
      title: page.title,
      depth: page.depth,
      audited: page.audited,
      scores: page.scores,
      issueCounts: page.issueCounts,
      keyboardFindings: page.keyboardFindings,
      issueCount: page.issues.length,
      error: page.error ?? null,
    })),
  };
}
