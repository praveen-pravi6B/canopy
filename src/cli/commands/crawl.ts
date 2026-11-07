import { Command } from 'commander';
import pc from 'picocolors';
import { loadConfig } from '../../core/config.js';
import { crawlSite } from '../../core/crawl.js';
import type { CrawlManifest } from '../../core/types.js';
import { TOOL_VERSION } from '../../core/version.js';
import {
  applyCommonOptions,
  formatCounts,
  formatScore,
  issuesFail,
  parseFailOn,
  parsePositiveInteger,
  type CommonCliOptions,
} from '../common.js';

interface CrawlCliOptions extends CommonCliOptions {
  config?: string;
  json?: boolean;
  quiet?: boolean;
  maxPages?: string;
  maxDepth?: string;
  concurrency?: string;
  rps?: string;
  audit?: boolean;
  ignoreRobots?: boolean;
  failOn?: string;
}

export function registerCrawlCommand(program: Command): void {
  program
    .command('crawl')
    .description('Crawl a same-origin site, audit every page, and build a local tree.')
    .argument('<url>', 'root URL to crawl (http or https)')
    .option('-c, --config <path>', 'path to canopy.config.json')
    .option('--browser <name>', 'chromium, chrome, or msedge')
    .option('--headed', 'run the browser with a visible window')
    .option('--out <dir>', 'output directory')
    .option('--json', 'print the crawl manifest as JSON')
    .option('--quiet', 'suppress progress output')
    .option('--timeout <ms>', 'navigation timeout in milliseconds')
    .option('--viewport <size>', 'viewport size, for example 1440x900')
    .option('--ignore-https-errors', 'ignore invalid TLS certificates')
    .option('--allow-private', 'allow private-network targets')
    .option('--no-screenshot', 'skip screenshots')
    .option('--no-dom', 'skip DOM snapshots')
    .option('--no-audit', 'crawl structure only; skip rendered accessibility audits')
    .option('--max-pages <n>', 'maximum pages to crawl')
    .option('--max-depth <n>', 'maximum link depth')
    .option('--concurrency <n>', 'parallel page fetches')
    .option('--rps <n>', 'maximum requests per second')
    .option('--ignore-robots', 'ignore robots.txt (only for sites you own)')
    .option('--fail-on <impact>', 'exit 1 on issues at or above this impact', 'none')
    .action(async (url: string, options: CrawlCliOptions) => {
      const { config } = loadConfig(options.config);
      applyCommonOptions(config, options);

      if (options.maxPages) {
        config.crawl.maxPages = parsePositiveInteger(options.maxPages, '--max-pages', 100_000);
      }
      if (options.maxDepth) {
        config.crawl.maxDepth = parsePositiveInteger(options.maxDepth, '--max-depth', 100);
      }
      if (options.concurrency) {
        config.crawl.concurrency = parsePositiveInteger(options.concurrency, '--concurrency', 10);
      }
      if (options.rps) {
        const parsed = Number(options.rps);
        if (!Number.isFinite(parsed) || parsed <= 0 || parsed > 50) {
          throw new Error('--rps must be a number between 0 and 50.');
        }
        config.crawl.requestsPerSecond = parsed;
      }
      if (options.ignoreRobots) config.crawl.respectRobots = false;
      if (options.audit === false) config.crawl.auditPages = false;

      const failOn = parseFailOn(options.failOn);
      const onEvent = (message: string): void => {
        if (!options.quiet && !options.json) console.log(pc.dim(`  ${message}`));
      };

      const { manifest, runDir } = await crawlSite({
        url,
        config,
        toolVersion: TOOL_VERSION,
        audit: config.crawl.auditPages,
        onEvent,
      });

      if (options.json) {
        console.log(JSON.stringify(manifest, null, 2));
      } else {
        printCrawlSummary(manifest, runDir);
      }

      if (manifest.stats.pages === 0 || manifest.stats.errors === manifest.stats.pages) {
        process.exitCode = 2;
        return;
      }

      const issues = manifest.pages.flatMap((page) => page.issues);
      if (issuesFail(issues, failOn)) process.exitCode = 1;
    });
}

function printCrawlSummary(manifest: CrawlManifest, runDir: string): void {
  console.log('');
  console.log(`${pc.bold('Canopy crawl')} ${pc.dim(manifest.toolVersion)}`);
  console.log(`  Root      ${manifest.rootUrl}`);
  console.log(
    `  Pages     ${manifest.stats.pages} (${manifest.stats.audited} audited)`,
  );
  console.log(
    `  Links     ${manifest.stats.edges} (${manifest.stats.externalLinks} external)`,
  );
  console.log(`  Blocked   ${manifest.stats.blockedByRobots} by robots.txt`);
  console.log(`  Errors    ${manifest.stats.errors}`);
  console.log(`  ADA       ${formatScore(manifest.summary.adaScore)}`);
  console.log(`  Keyboard  ${formatScore(manifest.summary.keyboardScore)}`);
  console.log(`  Issues    ${formatCounts(manifest.summary.issueCounts)}`);
  console.log(`  Viewer    ${runDir}/viewer.html`);
  console.log(`  Run       ${runDir}`);

  for (const notice of manifest.notices) {
    console.log(`  ${pc.yellow('Notice')}    ${notice}`);
  }

  console.log('');
}
