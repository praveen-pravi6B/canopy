import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { z } from 'zod';

export const BrowserConfigSchema = z
  .object({
    name: z.enum(['chromium', 'chrome', 'msedge']).default('chromium'),
    headless: z.boolean().default(true),
    viewport: z
      .object({
        width: z.number().int().min(320).max(7680).default(1440),
        height: z.number().int().min(240).max(4320).default(900),
      })
      .prefault({}),
    ignoreHTTPSErrors: z.boolean().default(false),
    timeoutMs: z.number().int().min(1000).max(300_000).default(30_000),
    settleMs: z.number().int().min(0).max(30_000).default(400),
  })
  .prefault({});

export const AuditConfigSchema = z
  .object({
    profile: z.enum(['ada', 'wcag22aa', 'best-practice']).default('ada'),
    includeBestPractices: z.boolean().default(true),
    maxTabs: z.number().int().min(1).max(1000).default(100),
  })
  .prefault({});

export const CrawlConfigSchema = z
  .object({
    maxPages: z.number().int().min(1).max(100_000).default(500),
    maxDepth: z.number().int().min(0).max(100).default(5),
    concurrency: z.number().int().min(1).max(10).default(2),
    requestsPerSecond: z.number().positive().max(50).default(1),
    respectRobots: z.boolean().default(true),
    includeSubdomains: z.boolean().default(false),
    allowPrivateNetworks: z.boolean().default(false),
    allowFileUrls: z.boolean().default(false),
    auditPages: z.boolean().default(true),
  })
  .prefault({});

export const OutputConfigSchema = z
  .object({
    dir: z.string().min(1).default('.canopy'),
    screenshots: z.boolean().default(true),
    domSnapshots: z.boolean().default(true),
  })
  .prefault({});

export const AuthConfigSchema = z
  .object({
    recipe: z.string().min(1).nullable().default(null),
    statePath: z.string().min(1).nullable().default(null),
    loginUrl: z.string().min(1).nullable().default(null),
  })
  .prefault({});

export const CanopyConfigSchema = z
  .object({
    crawl: CrawlConfigSchema,
    audit: AuditConfigSchema,
    browser: BrowserConfigSchema,
    output: OutputConfigSchema,
    auth: AuthConfigSchema,
  })
  .prefault({});

export type CanopyConfig = z.infer<typeof CanopyConfigSchema>;

export const DEFAULT_CONFIG: CanopyConfig = CanopyConfigSchema.parse({});

export function findConfig(startDir = process.cwd()): string | null {
  let dir = resolve(startDir);

  while (true) {
    const candidate = join(dir, 'canopy.config.json');
    if (existsSync(candidate)) return candidate;

    const parent = dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

export function loadConfig(explicitPath?: string): {
  config: CanopyConfig;
  path: string | null;
} {
  const path = explicitPath ? resolve(explicitPath) : findConfig();
  if (!path) {
    return { config: CanopyConfigSchema.parse({}), path: null };
  }

  const raw = JSON.parse(readFileSync(path, 'utf8')) as unknown;
  return { config: CanopyConfigSchema.parse(raw), path };
}
