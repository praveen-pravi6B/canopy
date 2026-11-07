import { createServer } from 'node:http';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import { CanopyConfigSchema } from '../src/core/config.js';
import { scanPage } from '../src/core/scan.js';
import { TOOL_VERSION } from '../src/core/version.js';

const FIXTURE_DIR = fileURLToPath(new URL('../fixtures/static', import.meta.url));

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
};

function fail(message: string): never {
  throw new Error(`smoke: ${message}`);
}

async function main(): Promise<void> {
  const server = createServer(async (request, response) => {
    try {
      const pathname = new URL(request.url ?? '/', 'http://localhost').pathname;
      const relative = pathname === '/' ? 'index.html' : pathname.replace(/^\/+/, '');
      const filePath = normalize(join(FIXTURE_DIR, relative));

      if (!filePath.startsWith(FIXTURE_DIR)) {
        response.writeHead(403).end('forbidden');
        return;
      }

      const body = await readFile(filePath);
      response.writeHead(200, {
        'content-type': MIME[extname(filePath)] ?? 'application/octet-stream',
      });
      response.end(body);
    } catch {
      response.writeHead(404, { 'content-type': 'text/plain' }).end('not found');
    }
  });

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve());
  });

  const address = server.address();
  if (!address || typeof address === 'string') fail('could not determine server port');

  const origin = `http://127.0.0.1:${address.port}`;
  const outRoot = await mkdtemp(join(tmpdir(), 'canopy-smoke-'));

  const config = CanopyConfigSchema.parse({
    browser: { name: 'chrome', headless: true, timeoutMs: 30_000, settleMs: 250 },
    audit: { maxTabs: 25 },
    output: { dir: outRoot, screenshots: true, domSnapshots: true },
  });

  let succeeded = false;

  try {
    console.log(`smoke: scanning ${origin}/`);

    const { manifest, manifestPath, runDir } = await scanPage({
      url: `${origin}/`,
      config,
      toolVersion: TOOL_VERSION,
      onEvent: (message) => console.log(`smoke:   ${message}`),
    });

    if (manifest.page.error) fail(`scan failed: ${manifest.page.error}`);

    const ruleIds = new Set(manifest.page.issues.map((issue) => issue.ruleId));
    if (!ruleIds.has('image-alt')) {
      fail(`expected axe rule "image-alt", got: ${[...ruleIds].join(', ')}`);
    }

    if (manifest.page.keyboard.findings.length === 0) {
      fail('expected at least one keyboard finding');
    }

    if (manifest.page.keyboard.positiveTabindex.length === 0) {
      fail('expected positive tabindex detection');
    }

    for (const artifact of ['screenshot.png', 'page.html', 'axe.json', 'keyboard.json']) {
      await stat(join(runDir, artifact)).catch(() => fail(`missing artifact ${artifact}`));
    }

    const saved = JSON.parse(await readFile(manifestPath, 'utf8')) as typeof manifest;
    if (saved.page.issues.length !== manifest.page.issues.length) {
      fail('summary.json does not match the in-memory manifest');
    }

    for (const score of [
      manifest.summary.adaScore,
      manifest.summary.keyboardScore,
      manifest.summary.overallScore,
    ]) {
      if (score < 0 || score > 100) fail(`score out of range: ${score}`);
    }

    console.log(
      `smoke: ok — ${ruleIds.size} rules, ${manifest.page.keyboard.findings.length} keyboard findings, run ${runDir}`,
    );
    succeeded = true;
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    if (succeeded) await rm(outRoot, { recursive: true, force: true });
    else console.log(`smoke: artifacts kept in ${outRoot}`);
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
