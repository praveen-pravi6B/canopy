import { existsSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { Command } from 'commander';
import pc from 'picocolors';
import { DEFAULT_CONFIG } from '../../core/config.js';

export function registerInitCommand(program: Command): void {
  program
    .command('init')
    .description('Create a canopy.config.json in the current directory.')
    .option('-f, --force', 'overwrite an existing config')
    .action(async (options: { force?: boolean }) => {
      const target = resolve(process.cwd(), 'canopy.config.json');

      if (existsSync(target) && !options.force) {
        console.log(pc.yellow(`Config already exists: ${target}`));
        console.log('Use --force to overwrite it.');
        return;
      }

      await writeFile(target, `${JSON.stringify(DEFAULT_CONFIG, null, 2)}\n`, 'utf8');
      console.log(pc.green(`Created ${target}`));
    });
}
