import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { Command } from 'commander';
import pc from 'picocolors';
import { loadConfig } from '../../core/config.js';
import {
  addIgnoreRule,
  listIgnoreRules,
  openDatabase,
  removeIgnoreRule,
} from '../../core/db.js';
import { applyIgnoreRulesToManifest } from '../../core/ignore.js';
import { writeJson, writeText } from '../../core/storage.js';
import { buildSiteGraph, buildSiteTree } from '../../core/tree.js';
import type { CrawlManifest, IgnoreCategory } from '../../core/types.js';
import { renderViewer } from '../../core/viewer.js';

function dbPath(out: string): string {
  return resolve(out, 'canopy.db');
}

function parseCategory(value: string): IgnoreCategory {
  if (value === 'ada' || value === 'keyboard' || value === 'all') return value;
  throw new Error('--category must be ada, keyboard, or all.');
}

export function registerIgnoreCommand(program: Command): void {
  const ignore = program.command('ignore').description('Manage per-node ignore rules (stored in SQLite).');

  ignore
    .command('add')
    .description('Ignore findings for pages matching a URL/path pattern.')
    .argument('<pattern>', 'URL or path glob (e.g. "/legacy/*", "**/admin*")')
    .requiredOption('--category <name>', 'ada, keyboard, or all')
    .requiredOption('--reason <text>', 'why this is ignored (shown in reports)')
    .option('-c, --config <path>', 'path to canopy.config.json')
    .option('--out <dir>', 'output directory containing canopy.db')
    .action(async (pattern: string, options: { category: string; reason: string; config?: string; out?: string }) => {
      const { config } = loadConfig(options.config);
      if (options.out) config.output.dir = options.out;

      const db = openDatabase(dbPath(config.output.dir));
      try {
        const rule = addIgnoreRule(db, pattern, parseCategory(options.category), options.reason);
        console.log(pc.green(`Added ignore rule #${rule.id}`));
        console.log(`  Pattern   ${rule.pattern}`);
        console.log(`  Category  ${rule.category}`);
        console.log(`  Reason    ${rule.reason}`);
      } finally {
        db.close();
      }
    });

  ignore
    .command('list')
    .description('List ignore rules.')
    .option('-c, --config <path>', 'path to canopy.config.json')
    .option('--out <dir>', 'output directory containing canopy.db')
    .option('--json', 'print rules as JSON')
    .action(async (options: { config?: string; out?: string; json?: boolean }) => {
      const { config } = loadConfig(options.config);
      if (options.out) config.output.dir = options.out;

      const db = openDatabase(dbPath(config.output.dir));
      try {
        const rules = listIgnoreRules(db);
        if (options.json) {
          console.log(JSON.stringify(rules, null, 2));
          return;
        }
        if (rules.length === 0) {
          console.log('No ignore rules.');
          return;
        }
        for (const rule of rules) {
          console.log(`#${rule.id} ${pc.bold(rule.pattern)} ${pc.dim(`[${rule.category}]`)}`);
          console.log(`  ${rule.reason}`);
        }
      } finally {
        db.close();
      }
    });

  ignore
    .command('remove')
    .description('Remove an ignore rule by id.')
    .argument('<id>', 'rule id')
    .option('-c, --config <path>', 'path to canopy.config.json')
    .option('--out <dir>', 'output directory containing canopy.db')
    .action(async (id: string, options: { config?: string; out?: string }) => {
      const { config } = loadConfig(options.config);
      if (options.out) config.output.dir = options.out;
      const numeric = Number(id);
      if (!Number.isInteger(numeric) || numeric < 1) throw new Error('Rule id must be a positive integer.');

      const db = openDatabase(dbPath(config.output.dir));
      try {
        const removed = removeIgnoreRule(db, numeric);
        if (!removed) {
          console.log(pc.yellow(`No ignore rule with id ${numeric}.`));
          process.exitCode = 1;
          return;
        }
        console.log(pc.green(`Removed ignore rule #${numeric}.`));
      } finally {
        db.close();
      }
    });

  ignore
    .command('apply')
    .description('Apply ignore rules to a crawl manifest and rewrite its viewer/scores.')
    .argument('<manifest>', 'path to crawl.json')
    .option('-c, --config <path>', 'path to canopy.config.json')
    .option('--out <dir>', 'output directory containing canopy.db')
    .option('--in-place', 'overwrite the manifest (default writes crawl.ignored.json)')
    .action(async (manifestPath: string, options: { config?: string; out?: string; inPlace?: boolean }) => {
      const { config } = loadConfig(options.config);
      if (options.out) config.output.dir = options.out;
      const path = resolve(manifestPath);

      const manifest = JSON.parse(await readFile(path, 'utf8')) as CrawlManifest;
      if (manifest.schemaVersion !== 1 || !Array.isArray(manifest.pages)) {
        throw new Error('Expected a Canopy crawl manifest (schemaVersion 1).');
      }

      const db = openDatabase(dbPath(config.output.dir));
      try {
        const rules = listIgnoreRules(db);
        const result = applyIgnoreRulesToManifest(manifest, rules);
        result.value.tree = buildSiteTree(result.value.rootUrl, result.value.pages);
        result.value.graph = buildSiteGraph(result.value.rootUrl, result.value.pages, result.value.edges);

        const target = options.inPlace ? path : path.replace(/\.json$/i, '') + '.ignored.json';
        await writeJson(target, result.value);
        const runDir = resolve(path, '..');
        await writeText(resolve(runDir, options.inPlace ? 'viewer.html' : 'viewer.ignored.html'), renderViewer(result.value));

        console.log(pc.green(`Applied ${rules.length} rule(s), ignored ${result.ignoredCount} finding(s).`));
        console.log(`  Manifest  ${target}`);
      } finally {
        db.close();
      }
    });
}
