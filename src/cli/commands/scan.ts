import { Command } from 'commander';
import pc from 'picocolors';
import { loadConfig } from '../../core/config.js';
import { scanPage } from '../../core/scan.js';
import { IMPACT_ORDER } from '../../core/score.js';
import type { Impact, RunManifest } from '../../core/types.js';
import { TOOL_VERSION } from '../../core/version.js';

interface ScanCliOptions {
  config?: string;
  browser?: string;
  headed?: boolean;
  out?: string;
  json?: boolean;
  quiet?: boolean;
  timeout?: string;
  viewport?: string;
  ignoreHttpsErrors?: boolean;
  allowPrivate?: boolean;
  screenshot?: boolean;
  dom?: boolean;
  failOn?: string;
}

const BROWSERS = new Set(['chromium', 'chrome', 'msedge']);
const FAIL_ON = new Set(['none', 'minor', 'moderate', 'serious', 'critical']);

export function registerScanCommand(program: Command): void {
  program
    .command('scan')
    .description('Scan a single URL and write a local run.')
    .argument('<url>', 'URL to scan (http or https)')
    .option('-c, --config <path>', 'path to canopy.config.json')
    .option('--browser <name>', 'chromium, chrome, or msedge')
    .option('--headed', 'run the browser with a visible window')
    .option('--out <dir>', 'output directory')
    .option('--json', 'print the run manifest as JSON')
    .option('--quiet', 'suppress progress output')
    .option('--timeout <ms>', 'navigation timeout in milliseconds')
    .option('--viewport <size>', 'viewport size, for example 1440x900')
    .option('--ignore-https-errors', 'ignore invalid TLS certificates')
    .option('--allow-private', 'allow private-network targets')
    .option('--no-screenshot', 'skip screenshots')
    .option('--no-dom', 'skip DOM snapshots')
    .option('--fail-on <impact>', 'exit 1 on issues at or above this impact', 'none')
    .action(async (url: string, options: ScanCliOptions) => {
      const { config } = loadConfig(options.config);

      if (options.browser) {
        if (!BROWSERS.has(options.browser)) {
          throw new Error('--browser must be chromium, chrome, or msedge.');
        }
        config.browser.name = options.browser as 'chromium' | 'chrome' | 'msedge';
      }

      if (options.headed) config.browser.headless = false;

      if (options.out) config.output.dir = options.out;

      if (options.timeout) {
        const timeout = Number(options.timeout);
        if (!Number.isFinite(timeout) || timeout < 1000) {
          throw new Error('--timeout must be a number of milliseconds >= 1000.');
        }
        config.browser.timeoutMs = Math.floor(timeout);
      }

      if (options.viewport) {
        config.browser.viewport = parseViewport(options.viewport);
      }

      if (options.ignoreHttpsErrors) config.browser.ignoreHTTPSErrors = true;
      if (options.allowPrivate) config.crawl.allowPrivateNetworks = true;
      if (options.screenshot === false) config.output.screenshots = false;
      if (options.dom === false) config.output.domSnapshots = false;

      const failOn = options.failOn ?? 'none';
      if (!FAIL_ON.has(failOn)) {
        throw new Error('--fail-on must be none, minor, moderate, serious, or critical.');
      }

      const { manifest, runDir } = await scanPage({
        url,
        config,
        toolVersion: TOOL_VERSION,
        onEvent: (message) => {
          if (!options.quiet && !options.json) {
            console.log(pc.dim(`  ${message}`));
          }
        },
      });

      if (options.json) {
        console.log(JSON.stringify(manifest, null, 2));
      } else {
        printSummary(manifest, runDir);
      }

      if (manifest.page.error) {
        process.exitCode = 2;
        return;
      }

      if (failOn !== 'none') {
        const minimum = IMPACT_ORDER[failOn as Impact];
        const failed = manifest.page.issues.some(
          (issue) => IMPACT_ORDER[issue.impact] >= minimum,
        );
        if (failed) process.exitCode = 1;
      }
    });
}

function parseViewport(value: string): { width: number; height: number } {
  const match = /^(\d+)x(\d+)$/i.exec(value.trim());
  if (!match) throw new Error('--viewport must look like 1440x900.');

  const width = Number(match[1]);
  const height = Number(match[2]);

  if (!Number.isFinite(width) || !Number.isFinite(height) || width < 320 || height < 240) {
    throw new Error('--viewport width must be >= 320 and height >= 240.');
  }

  return { width: Math.floor(width), height: Math.floor(height) };
}

function printSummary(manifest: RunManifest, runDir: string): void {
  const page = manifest.page;

  console.log('');
  console.log(`${pc.bold('Canopy')} ${pc.dim(manifest.toolVersion)}`);
  console.log(`  Target    ${manifest.targetUrl}`);
  console.log(`  Final     ${page.finalUrl}`);
  console.log(`  Status    ${page.status ?? pc.yellow('unknown')}`);
  console.log(`  Title     ${page.title || pc.dim('(none)')}`);
  console.log(`  ADA       ${formatScore(manifest.summary.adaScore)}`);
  console.log(`  Keyboard  ${formatScore(manifest.summary.keyboardScore)}`);
  console.log(`  Issues    ${formatCounts(manifest.summary.issueCounts)}`);
  console.log(`  Run       ${runDir}`);

  if (page.error) {
    console.log(`  ${pc.red('Error')}     ${page.error}`);
  }

  console.log('');
}

function formatScore(score: number): string {
  const text = `${score}/100`;
  if (score >= 90) return pc.green(text);
  if (score >= 70) return pc.yellow(text);
  return pc.red(text);
}

function formatCounts(counts: RunManifest['summary']['issueCounts']): string {
  return (['critical', 'serious', 'moderate', 'minor'] as const)
    .map((impact) => `${counts[impact]} ${impact}`)
    .join(pc.dim(' · '));
}
