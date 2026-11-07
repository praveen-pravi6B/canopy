import { readFile, stat } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { Command } from 'commander';
import pc from 'picocolors';
import { diffCrawls, type CrawlDiff } from '../../core/diff.js';
import type { CrawlManifest } from '../../core/types.js';

async function load(input: string): Promise<CrawlManifest> {
  let path = resolve(input);
  try {
    if ((await stat(path)).isDirectory()) path = join(path, 'crawl.json');
  } catch {}
  const raw = JSON.parse(await readFile(path, 'utf8')) as CrawlManifest;
  if (raw.schemaVersion !== 1 || !Array.isArray(raw.pages)) {
    throw new Error(`Not a Canopy crawl manifest: ${path}`);
  }
  return raw;
}

function delta(n: number): string {
  if (n === 0) return pc.dim('0');
  const text = n > 0 ? `+${n}` : String(n);
  return n > 0 ? pc.green(text) : pc.red(text);
}

function issueDelta(n: number): string {
  if (n === 0) return pc.dim('0');
  const text = n > 0 ? `+${n}` : String(n);
  // More issues is bad.
  return n > 0 ? pc.red(text) : pc.green(text);
}

function printDiff(diff: CrawlDiff): void {
  console.log('');
  console.log(pc.bold('Canopy diff'));
  console.log(`  Before  ${diff.beforeRoot} ${pc.dim(`(${diff.beforeId})`)}`);
  console.log(`  After   ${diff.afterRoot} ${pc.dim(`(${diff.afterId})`)}`);
  console.log(`  Score   ${delta(diff.summary.scoreDelta)} overall (ADA ${delta(diff.summary.adaDelta)}, Keyboard ${delta(diff.summary.keyboardDelta)})`);
  console.log(`  Issues  ${issueDelta(diff.summary.issueDelta)} (${diff.summary.beforeIssues} → ${diff.summary.afterIssues})`);
  console.log(`  Pages   ${diff.summary.changedPages} changed, ${diff.summary.addedPages} added, ${diff.summary.removedPages} removed`);

  if (diff.newRules.length) console.log(`  New     ${diff.newRules.join(', ')}`);
  if (diff.fixedRules.length) console.log(`  Fixed   ${diff.fixedRules.join(', ')}`);

  const changed = diff.pages.filter((p) => p.status !== 'unchanged');
  if (changed.length) {
    console.log('');
    for (const page of changed.slice(0, 50)) {
      const mark =
        page.status === 'added' ? pc.green('+') : page.status === 'removed' ? pc.red('-') : pc.yellow('~');
      const detail =
        page.status === 'changed'
          ? ` score ${delta(page.scoreDelta ?? 0)}, issues ${issueDelta(page.issueDelta ?? 0)}`
          : '';
      console.log(`  ${mark} ${page.url}${detail}`);
    }
    if (changed.length > 50) console.log(pc.dim(`  … ${changed.length - 50} more`));
  }
  console.log('');
}

export function registerDiffCommand(program: Command): void {
  program
    .command('diff')
    .description('Compare two crawl manifests and show score/issue changes.')
    .argument('<before>', 'baseline crawl.json or run directory')
    .argument('<after>', 'current crawl.json or run directory')
    .option('--json', 'print the diff as JSON')
    .action(async (before: string, after: string, options: { json?: boolean }) => {
      const diff = diffCrawls(await load(before), await load(after));
      if (options.json) console.log(JSON.stringify(diff, null, 2));
      else printDiff(diff);
    });
}
