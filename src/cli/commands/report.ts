import { readFile, stat, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { Command } from 'commander';
import pc from 'picocolors';
import { findingsToCsv, summaryForExport } from '../../core/export.js';
import { writeText } from '../../core/storage.js';
import type { CrawlManifest } from '../../core/types.js';
import { renderViewer } from '../../core/viewer.js';

async function resolveManifestPath(input: string): Promise<string> {
  const path = resolve(input);
  try {
    const s = await stat(path);
    if (s.isDirectory()) return join(path, 'crawl.json');
  } catch {
    // fall through
  }
  return path;
}

async function loadCrawlManifest(input: string): Promise<{ manifest: CrawlManifest; path: string }> {
  const path = await resolveManifestPath(input);
  const raw = JSON.parse(await readFile(path, 'utf8')) as CrawlManifest & { page?: unknown };
  if (raw.schemaVersion !== 1 || !Array.isArray(raw.pages)) {
    if ('page' in raw) throw new Error('report currently supports crawl manifests; scan exports summary.json directly.');
    throw new Error(`Not a Canopy crawl manifest: ${path}`);
  }
  return { manifest: raw, path };
}

export function registerReportCommand(program: Command): void {
  program
    .command('report')
    .description('Export a crawl run as JSON, CSV findings, or self-contained HTML.')
    .argument('<manifest>', 'path to crawl.json or a run directory')
    .option('--format <type>', 'json, csv, or html', 'json')
    .option('--out <path>', 'output file (defaults to stdout for json/csv)')
    .action(async (input: string, options: { format?: string; out?: string }) => {
      const format = options.format ?? 'json';
      if (format !== 'json' && format !== 'csv' && format !== 'html') {
        throw new Error('--format must be json, csv, or html.');
      }

      const { manifest } = await loadCrawlManifest(input);

      let content: string;
      if (format === 'csv') content = findingsToCsv(manifest);
      else if (format === 'html') content = renderViewer(manifest);
      else content = `${JSON.stringify(summaryForExport(manifest), null, 2)}\n`;

      if (options.out) {
        const out = resolve(options.out);
        if (format === 'html') await writeText(out, content);
        else await writeFile(out, content, 'utf8');
        console.log(pc.green(`Wrote ${format.toUpperCase()} report to ${out}`));
        return;
      }

      if (format === 'html') {
        throw new Error('--out is required for --format html.');
      }
      process.stdout.write(content);
    });
}
