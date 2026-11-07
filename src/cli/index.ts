#!/usr/bin/env node
import { Command } from 'commander';
import { AuthError } from '../core/auth.js';
import { TOOL_VERSION } from '../core/version.js';
import { registerAuthCommand } from './commands/auth.js';
import { registerCrawlCommand } from './commands/crawl.js';
import { registerDoctorCommand } from './commands/doctor.js';
import { registerIgnoreCommand } from './commands/ignore.js';
import { registerInitCommand } from './commands/init.js';
import { registerScanCommand } from './commands/scan.js';
import { registerSimulateCommand } from './commands/simulate.js';

const program = new Command();

program
  .name('canopy')
  .description('Local, black-box site tree and accessibility auditor.')
  .version(TOOL_VERSION, '-v, --version');

registerScanCommand(program);
registerCrawlCommand(program);
registerAuthCommand(program);
registerIgnoreCommand(program);
registerSimulateCommand(program);
registerDoctorCommand(program);
registerInitCommand(program);

program.showHelpAfterError();

program.parseAsync(process.argv).catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = error instanceof AuthError ? 3 : 2;
});
