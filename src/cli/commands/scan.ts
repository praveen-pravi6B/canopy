import { Command } from 'commander';
import pc from 'picocolors';
import { loadConfig } from '../../core/config.js';
import { scanPage } from '../../core/scan.js';
import type { RunManifest } from '../../core/types.js';
import { TOOL_VERSION } from '../../core/version.js';
import {
  applyCommonOptions,
  formatCounts,
  formatScore,
  issuesFail,
  parseFailOn,
  type CommonCliOptions,
} from '../common.js';

interface ScanCliOptions extends CommonCliOptions {
  config?: string;
  json?: boolean;
  quiet?: boolean;
  failOn?: string;
}

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
    .option('--auth <path>', 'scripted login recipe (YAML or JSON)')
    .option('--auth-state <path>', 'reuse a saved Playwright storage state')
    .option('--auth-login-url <url>', 'login URL used to detect an expired session')
    .option('--fail-on <impact>', 'exit 1 on issues at or above this impact', 'none')
    .action(async (url: string, options: ScanCliOptions) => {
      const { config } = loadConfig(options.config);
      applyCommonOptions(config, options);

      const failOn = parseFailOn(options.failOn);

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

      if (issuesFail(manifest.page.issues, failOn)) process.exitCode = 1;
    });
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
