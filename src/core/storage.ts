import { mkdir, writeFile } from 'node:fs/promises';
import { relative, resolve } from 'node:path';

export interface RunDirectory {
  id: string;
  dir: string;
}

function slugify(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9.-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80);
}

export async function createRunDirectory(root: string, targetUrl: string): Promise<RunDirectory> {
  const host = new URL(targetUrl).hostname;
  const id = `${new Date().toISOString().replace(/[:.]/g, '-')}-${slugify(host)}`;
  const dir = resolve(root, 'runs', id);

  await mkdir(dir, { recursive: true });

  return { id, dir };
}

export async function writeJson(path: string, data: unknown): Promise<void> {
  await writeFile(path, `${JSON.stringify(data, null, 2)}\n`, 'utf8');
}

export async function writeText(path: string, data: string): Promise<void> {
  await writeFile(path, data, 'utf8');
}

export function relativeArtifact(runDir: string, filePath: string): string {
  return relative(runDir, filePath).replaceAll('\\', '/');
}
