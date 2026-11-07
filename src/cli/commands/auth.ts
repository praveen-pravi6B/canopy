import { resolve } from 'node:path';
import { createInterface } from 'node:readline/promises';
import { Command } from 'commander';
import pc from 'picocolors';
import { AuthError, saveStorageState } from '../../core/auth.js';
import { launchBrowser } from '../../core/browser.js';
import { loadConfig } from '../../core/config.js';
import { openSession } from '../../core/session.js';
import { assertSafeTarget } from '../../core/url.js';
import { USER_AGENT } from '../../core/version.js';
import { applyCommonOptions, type CommonCliOptions } from '../common.js';

interface AuthCliOptions extends CommonCliOptions {
  config?: string;
  recipe?: string;
  state?: string;
  url?: string;
}

export function registerAuthCommand(program: Command): void {
  const auth = program
    .command('auth')
    .description('Run a scripted login or capture a session manually.');

  auth
    .command('test')
    .description('Run a login recipe once and save the session state.')
    .option('-c, --config <path>', 'path to canopy.config.json')
    .option('--recipe <path>', 'scripted login recipe (YAML or JSON)')
    .option('--out <dir>', 'output directory for the saved session')
    .option('--browser <name>', 'chromium, chrome, or msedge')
    .option('--viewport <size>', 'viewport size, for example 1440x900')
    .option('--timeout <ms>', 'navigation timeout in milliseconds')
    .option('--ignore-https-errors', 'ignore invalid TLS certificates')
    .option('--allow-private', 'allow private-network targets')
    .action(async (options: AuthCliOptions) => {
      const { config } = loadConfig(options.config);
      applyCommonOptions(config, options);
      if (options.recipe) config.auth.recipe = options.recipe;

      if (!config.auth.recipe) {
        throw new AuthError('Provide --recipe or set auth.recipe in canopy.config.json.');
      }

      const session = await openSession({
        config,
        onEvent: (message) => console.log(pc.dim(`  ${message}`)),
      });

      try {
        console.log(pc.green('Login succeeded.'));
        console.log(`  Login URL ${session.loginUrl ?? pc.dim('(unknown)')}`);
        console.log(`  State     ${session.statePath ?? pc.dim('(not saved)')}`);
      } finally {
        await session.context.close().catch(() => undefined);
        await session.browser.close().catch(() => undefined);
      }
    });

  auth
    .command('capture')
    .description('Log in manually in a headed browser, then save the session state.')
    .option('-c, --config <path>', 'path to canopy.config.json')
    .option('--url <url>', 'login URL to open')
    .option('--state <path>', 'where to save the Playwright storage state')
    .option('--out <dir>', 'output directory for the saved session')
    .option('--browser <name>', 'chromium, chrome, or msedge')
    .option('--viewport <size>', 'viewport size, for example 1440x900')
    .option('--timeout <ms>', 'navigation timeout in milliseconds')
    .option('--ignore-https-errors', 'ignore invalid TLS certificates')
    .option('--allow-private', 'allow private-network targets')
    .action(async (options: AuthCliOptions) => {
      if (!options.url) throw new Error('auth capture requires --url.');
      if (!process.stdin.isTTY) {
        throw new Error('auth capture needs an interactive terminal.');
      }

      const { config } = loadConfig(options.config);
      applyCommonOptions(config, options);
      config.browser.headless = false;

      const url = new URL(options.url);
      await assertSafeTarget(url, { allowPrivate: config.crawl.allowPrivateNetworks });

      const launched = await launchBrowser(config);

      try {
        const context = await launched.browser.newContext({
          viewport: config.browser.viewport,
          ignoreHTTPSErrors: config.browser.ignoreHTTPSErrors,
          acceptDownloads: false,
          userAgent: USER_AGENT,
        });

        const page = await context.newPage();
        page.setDefaultTimeout(config.browser.timeoutMs);
        await page.goto(url.toString(), { waitUntil: 'domcontentloaded' });

        console.log('Log in in the browser window. Captchas and MFA are fine here.');
        const readline = createInterface({ input: process.stdin, output: process.stdout });

        try {
          await readline.question('Press Enter when you are done...');
        } finally {
          readline.close();
        }

        const statePath = options.state
          ? resolve(options.state)
          : config.auth.statePath
            ? resolve(config.auth.statePath)
            : resolve(config.output.dir, 'auth', 'manual.storage.json');

        await saveStorageState(context, statePath);
        console.log(pc.green(`Saved session state to ${statePath}`));
        console.log(`Reuse it with --auth-state ${statePath}`);
      } finally {
        await launched.browser.close().catch(() => undefined);
      }
    });
}
