import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import Database from 'better-sqlite3';
import type { CrawlManifest, IgnoreCategory, IgnoreRule } from './types.js';

export type CanopyDatabase = Database.Database;

export interface RunRow {
  id: string;
  toolVersion: string;
  rootUrl: string;
  startedAt: string;
  finishedAt: string;
  pages: number;
  overallScore: number;
}

export function openDatabase(path: string): CanopyDatabase {
  mkdirSync(dirname(path), { recursive: true });
  const db = new Database(path);

  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');

  db.exec(`
    CREATE TABLE IF NOT EXISTS runs (
      id TEXT PRIMARY KEY,
      tool_version TEXT NOT NULL,
      root_url TEXT NOT NULL,
      started_at TEXT NOT NULL,
      finished_at TEXT NOT NULL,
      pages INTEGER NOT NULL,
      overall_score INTEGER NOT NULL,
      config_json TEXT NOT NULL,
      summary_json TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS pages (
      run_id TEXT NOT NULL,
      url TEXT NOT NULL,
      final_url TEXT NOT NULL,
      title TEXT NOT NULL,
      status INTEGER,
      depth INTEGER NOT NULL,
      audited INTEGER NOT NULL,
      ada_score INTEGER NOT NULL,
      keyboard_score INTEGER NOT NULL,
      overall_score INTEGER NOT NULL,
      issue_count INTEGER NOT NULL,
      data_json TEXT NOT NULL,
      PRIMARY KEY (run_id, url),
      FOREIGN KEY (run_id) REFERENCES runs(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS edges (
      run_id TEXT NOT NULL,
      from_url TEXT NOT NULL,
      to_url TEXT NOT NULL,
      external INTEGER NOT NULL,
      PRIMARY KEY (run_id, from_url, to_url),
      FOREIGN KEY (run_id) REFERENCES runs(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS issues (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      run_id TEXT NOT NULL,
      page_url TEXT NOT NULL,
      source TEXT NOT NULL,
      rule_id TEXT NOT NULL,
      impact TEXT NOT NULL,
      description TEXT NOT NULL,
      help TEXT NOT NULL,
      help_url TEXT,
      selectors_json TEXT NOT NULL,
      node_count INTEGER NOT NULL,
      FOREIGN KEY (run_id) REFERENCES runs(id) ON DELETE CASCADE
    );

    CREATE INDEX IF NOT EXISTS issues_run_rule ON issues(run_id, rule_id);

    CREATE TABLE IF NOT EXISTS ignore_rules (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      pattern TEXT NOT NULL,
      category TEXT NOT NULL,
      reason TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
  `);

  return db;
}

export function saveCrawlRun(db: CanopyDatabase, manifest: CrawlManifest): void {
  const insertRun = db.prepare(`
    INSERT OR REPLACE INTO runs
      (id, tool_version, root_url, started_at, finished_at, pages, overall_score, config_json, summary_json)
    VALUES
      (@id, @toolVersion, @rootUrl, @startedAt, @finishedAt, @pages, @overallScore, @config, @summary)
  `);

  const insertPage = db.prepare(`
    INSERT OR REPLACE INTO pages
      (run_id, url, final_url, title, status, depth, audited, ada_score, keyboard_score, overall_score, issue_count, data_json)
    VALUES
      (@runId, @url, @finalUrl, @title, @status, @depth, @audited, @adaScore, @keyboardScore, @overallScore, @issueCount, @data)
  `);

  const insertEdge = db.prepare(`
    INSERT OR IGNORE INTO edges (run_id, from_url, to_url, external)
    VALUES (@runId, @from, @to, @external)
  `);

  const insertIssue = db.prepare(`
    INSERT INTO issues
      (run_id, page_url, source, rule_id, impact, description, help, help_url, selectors_json, node_count)
    VALUES
      (@runId, @pageUrl, @source, @ruleId, @impact, @description, @help, @helpUrl, @selectors, @nodeCount)
  `);

  const deleteIssues = db.prepare('DELETE FROM issues WHERE run_id = ?');
  const deletePages = db.prepare('DELETE FROM pages WHERE run_id = ?');
  const deleteEdges = db.prepare('DELETE FROM edges WHERE run_id = ?');

  const transaction = db.transaction((data: CrawlManifest) => {
    deleteIssues.run(data.id);
    deletePages.run(data.id);
    deleteEdges.run(data.id);

    insertRun.run({
      id: data.id,
      toolVersion: data.toolVersion,
      rootUrl: data.rootUrl,
      startedAt: data.startedAt,
      finishedAt: data.finishedAt,
      pages: data.stats.pages,
      overallScore: data.summary.overallScore,
      config: JSON.stringify(data.config),
      summary: JSON.stringify(data.summary),
    });

    for (const page of data.pages) {
      insertPage.run({
        runId: data.id,
        url: page.url,
        finalUrl: page.finalUrl,
        title: page.title,
        status: page.status,
        depth: page.depth,
        audited: page.audited ? 1 : 0,
        adaScore: page.scores.ada,
        keyboardScore: page.scores.keyboard,
        overallScore: page.scores.overall,
        issueCount: page.issues.length,
        data: JSON.stringify(page),
      });

      for (const issue of page.issues) {
        insertIssue.run({
          runId: data.id,
          pageUrl: page.url,
          source: issue.source,
          ruleId: issue.ruleId,
          impact: issue.impact,
          description: issue.description,
          help: issue.help,
          helpUrl: issue.helpUrl ?? null,
          selectors: JSON.stringify(issue.nodes.map((node) => node.target.join(' '))),
          nodeCount: issue.nodes.length,
        });
      }
    }

    for (const edge of data.edges) {
      insertEdge.run({
        runId: data.id,
        from: edge.from,
        to: edge.to,
        external: edge.external ? 1 : 0,
      });
    }
  });

  transaction(manifest);
}

export function listRuns(db: CanopyDatabase, limit = 20): RunRow[] {
  return db
    .prepare(
      `SELECT id, tool_version AS toolVersion, root_url AS rootUrl, started_at AS startedAt,
              finished_at AS finishedAt, pages, overall_score AS overallScore
       FROM runs ORDER BY started_at DESC LIMIT ?`,
    )
    .all(limit) as RunRow[];
}

export function getRun(db: CanopyDatabase, id: string): RunRow | null {
  const row = db
    .prepare(
      `SELECT id, tool_version AS toolVersion, root_url AS rootUrl, started_at AS startedAt,
              finished_at AS finishedAt, pages, overall_score AS overallScore
       FROM runs WHERE id = ?`,
    )
    .get(id) as RunRow | undefined;

  return row ?? null;
}

export function addIgnoreRule(
  db: CanopyDatabase,
  pattern: string,
  category: IgnoreCategory,
  reason: string,
): IgnoreRule {
  const createdAt = new Date().toISOString();
  const result = db
    .prepare(
      'INSERT INTO ignore_rules (pattern, category, reason, created_at) VALUES (?, ?, ?, ?)',
    )
    .run(pattern, category, reason, createdAt);

  return {
    id: Number(result.lastInsertRowid),
    pattern,
    category,
    reason,
    createdAt,
  };
}

export function listIgnoreRules(db: CanopyDatabase): IgnoreRule[] {
  return db
    .prepare(
      'SELECT id, pattern, category, reason, created_at AS createdAt FROM ignore_rules ORDER BY id',
    )
    .all() as IgnoreRule[];
}

export function removeIgnoreRule(db: CanopyDatabase, id: number): boolean {
  return db.prepare('DELETE FROM ignore_rules WHERE id = ?').run(id).changes > 0;
}
