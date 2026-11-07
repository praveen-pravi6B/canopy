import { mkdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { createInterface } from 'node:readline/promises';
import { Command } from 'commander';
import pc from 'picocolors';
import { loadConfig } from '../../core/config.js';
import { openSession } from '../../core/session.js';
import { enableSimulation, type SimulationMode } from '../../core/simulate.js';
import { createRunDirectory } from '../../core/storage.js';
import { assertSafeTarget, parseTargetUrl } from '../../core/url.js';
import { applyCommonOptions, type CommonCliOptions } from '../common.js';

interface SimCliOptions extends CommonCliOptions {
  config?: string;
  mode?: string;
  keepOpen?: boolean;
}

function parseMode(value: string | undefined): SimulationMode {
  const mode = value ?? 'both';
  if (mode === 'ada' || mode === 'keyboard' || mode === 'both') return mode;
  throw new Error('--mode must be ada, keyboard, or both.');
}

export function registerSimulateCommand(program: Command): void {
  program
    .command('simulate')
    .description('Open a page in a headed browser and apply reversible accessibility/keyboard simulation.')
    .argument('<url>', 'URL to open')
    .option('-c, --config <path>', 'path to canopy.config.json')
    .option('--mode <mode>', 'ada, keyboard, or both', 'both')
    .option('--browser <name>', 'chromium, chrome, or msedge')
    .option('--out <dir>', 'output directory for before/after screenshots')
    .option('--viewport <size>', 'viewport size, for example 1440x900')
    .option('--timeout <ms>', 'navigation timeout in milliseconds')
    .option('--ignore-https-errors', 'ignore invalid TLS certificates')
    .option('--allow-private', 'allow private-network targets')
    .option('--auth <path>', 'scripted login recipe (YAML or JSON)')
    .option('--auth-state <path>', 'reuse a saved Playwright storage state')
    .option('--auth-login-url <url>', 'login URL used to detect an expired session')
    .option('--no-keep-open', 'close after saving screenshots')
    .action(async (url: string, options: SimCliOptions) => {
      const { config } = loadConfig(options.config);
      applyCommonOptions(config, options);
      config.browser.headless = false;

      const mode = parseMode(options.mode);
      const target = parseTargetUrl(url);
      await assertSafeTarget(target, { allowPrivate: config.crawl.allowPrivateNetworks });

      const run = await createRunDirectory(config.output.dir, target.toString());
      const outDir = join(run.dir, 'simulation');
      await mkdir(outDir, { recursive: true });

      const session = await openSession({
        config,
        onEvent: (message) => console.log(pc.dim(`  ${message}`)),
      });

      try {
        const page = await session.context.newPage();
        page.on('dialog', (dialog) => void dialog.dismiss());
        page.setDefaultTimeout(config.browser.timeoutMs);

        console.log(pc.dim(`  Navigating to ${target.toString()}`));
        await page.goto(target.toString(), { waitUntil: 'domcontentloaded', timeout: config.browser.timeoutMs });
        await page.waitForLoadState('networkidle', { timeout: Math.min(5000, config.browser.timeoutMs) }).catch(() => undefined);
        await page.waitForTimeout(config.browser.settleMs);

        const beforePath = join(outDir, 'before.png');
        await page.screenshot({ path: beforePath, fullPage: true, animations: 'disabled' });

        await enableSimulation(page, mode);
        await page.waitForTimeout(250);

        const afterPath = join(outDir, 'after.png');
        await page.screenshot({ path: afterPath, fullPage: true, animations: 'disabled' });

        console.log('');
        console.log(pc.bold('Canopy simulation'));
        console.log(`  URL     ${page.url()}`);
        console.log(`  Mode    ${mode}`);
        console.log(`  Before  ${beforePath}`);
        console.log(`  After   ${afterPath}`);
        console.log('');
        console.log('Simulation is active in the headed browser. A "Restore" button is injected;');
        console.log('the exact restore is a page reload (the button reloads).');

        if (options.keepOpen === false || !process.stdin.isTTY) return;

        const readline = createInterface({ input: process.stdin, output: process.stdout });
        try {
          await readline.question('Press Enter to close the browser...');
        } finally {
          readline.close();
        }
      } finally {
        await session.context.close().catch(() => undefined);
        await session.browser.close().catch(() => undefined);
      }
    });
}
