import { mkdir } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { Command } from 'commander';
import pc from 'picocolors';
import { launchBrowser } from '../../core/browser.js';
import { DEFAULT_CONFIG } from '../../core/config.js';

const require = createRequire(import.meta.url);

export function registerDoctorCommand(program: Command): void {
  program
    .command('doctor')
    .description('Check Node, Playwright, and browser setup.')
    .action(async () => {
      const major = Number(process.versions.node.split('.')[0]);
      console.log(pc.bold('Canopy doctor'));
      console.log(
        `  Node       ${process.version}${major >= 20 ? pc.green(' ok') : pc.red(' (need >= 20)')}`,
      );

      let playwrightVersion = 'unknown';
      try {
        const pkg = require('playwright/package.json') as { version?: string };
        playwrightVersion = pkg.version ?? 'unknown';
      } catch {
        playwrightVersion = 'unknown';
      }
      console.log(`  Playwright ${playwrightVersion}`);

      const config = structuredClone(DEFAULT_CONFIG);
      config.browser.name = 'chromium';
      config.browser.headless = true;

      try {
        const { browser, used } = await launchBrowser(config);
        await browser.close();
        console.log(`  Browser    ${used} ${pc.green('ok')}`);
        if (used === 'chrome') {
          console.log(
            pc.dim('             using system Google Chrome; no Playwright download required'),
          );
        }
      } catch (error) {
        console.log(`  Browser    ${pc.red('failed')}`);
        console.log('');
        console.log(error instanceof Error ? error.message : String(error));
        console.log('');
        console.log('Fix: pnpm exec playwright install chromium');
        process.exitCode = major >= 20 ? 1 : 2;
        return;
      }

      try {
        const outputDir = resolve(config.output.dir, 'runs');
        await mkdir(outputDir, { recursive: true });
        console.log(`  Output     ${outputDir} ${pc.green('ok')}`);
      } catch (error) {
        console.log(`  Output     ${pc.red('not writable')}`);
        console.log(error instanceof Error ? error.message : String(error));
        process.exitCode = 1;
      }

      if (major < 20) process.exitCode = 2;
    });
}
