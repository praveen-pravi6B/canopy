import type { LookupAddress } from 'node:dns';
import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';

const TRACKING_PARAMS = new Set([
  'fbclid',
  'gclid',
  'dclid',
  'msclkid',
  'mc_cid',
  'mc_eid',
  'igshid',
  'ref_src',
  'ref_url',
]);

const DEFAULT_PORTS: Record<string, string> = {
  'http:': '80',
  'https:': '443',
};

function isTrackingParam(key: string): boolean {
  const lower = key.toLowerCase();
  return lower.startsWith('utm_') || TRACKING_PARAMS.has(lower);
}

export function normalizeUrl(input: string, base?: string): string {
  const url = new URL(input, base);

  url.hash = '';
  url.hostname = url.hostname.toLowerCase();

  const defaultPort = DEFAULT_PORTS[url.protocol];
  if (defaultPort && url.port === defaultPort) url.port = '';

  for (const key of [...url.searchParams.keys()]) {
    if (isTrackingParam(key)) url.searchParams.delete(key);
  }
  url.searchParams.sort();

  if (url.pathname.length > 1) {
    url.pathname = url.pathname.replace(/\/+$/, '');
  }

  return url.toString();
}

export function isSameOrigin(candidate: URL, root: URL): boolean {
  return candidate.origin === root.origin;
}

export function isInScope(candidate: URL, root: URL, includeSubdomains = false): boolean {
  if (candidate.protocol !== root.protocol) return false;

  const candidatePort = candidate.port || DEFAULT_PORTS[candidate.protocol] || '';
  const rootPort = root.port || DEFAULT_PORTS[root.protocol] || '';
  if (candidatePort !== rootPort) return false;

  const candidateHost = candidate.hostname.toLowerCase();
  const rootHost = root.hostname.toLowerCase();

  if (candidateHost === rootHost) return true;
  if (!includeSubdomains) return false;

  // Avoid treating lookalikes such as evil-example.com as subdomains.
  return candidateHost.endsWith(`.${rootHost}`);
}

export function parseTargetUrl(input: string): URL {
  const trimmed = input.trim();
  if (!trimmed) throw new Error('A target URL is required.');

  if (trimmed.includes('://') && !/^https?:\/\//i.test(trimmed)) {
    throw new Error('Only http:// and https:// targets are supported.');
  }

  const withScheme = /^https?:\/\//i.test(trimmed) ? trimmed : `http://${trimmed}`;

  let url: URL;
  try {
    url = new URL(withScheme);
  } catch {
    throw new Error('Only http:// and https:// targets are supported.');
  }

  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error('Only http:// and https:// targets are supported.');
  }

  return url;
}

function ipv4ToInt(ip: string): number | null {
  const parts = ip.split('.');
  if (parts.length !== 4) return null;

  const numbers = parts.map((part) => Number(part));
  if (numbers.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) {
    return null;
  }

  return (
    ((numbers[0]! << 24) >>> 0) +
    (numbers[1]! << 16) +
    (numbers[2]! << 8) +
    numbers[3]!
  );
}

function ipv4InCidr(ip: number, base: string, bits: number): boolean {
  const baseInt = ipv4ToInt(base);
  if (baseInt === null) return false;

  const mask = bits === 0 ? 0 : (~0 << (32 - bits)) >>> 0;
  return ((ip & mask) >>> 0) === ((baseInt & mask) >>> 0);
}

const PRIVATE_IPV4_RANGES: Array<[string, number]> = [
  ['0.0.0.0', 8],
  ['10.0.0.0', 8],
  ['100.64.0.0', 10],
  ['127.0.0.0', 8],
  ['169.254.0.0', 16],
  ['172.16.0.0', 12],
  ['192.0.0.0', 24],
  ['192.0.2.0', 24],
  ['192.168.0.0', 16],
  ['198.18.0.0', 15],
  ['198.51.100.0', 24],
  ['203.0.113.0', 24],
  ['224.0.0.0', 4],
  ['240.0.0.0', 4],
];

function isPrivateIpv4(ip: string): boolean {
  const value = ipv4ToInt(ip);
  if (value === null) return false;

  if (value === 0xffffffff) return true;

  return PRIVATE_IPV4_RANGES.some(([base, bits]) => ipv4InCidr(value, base, bits));
}

function isPrivateIpv6(ip: string): boolean {
  const address = ip.toLowerCase().replace(/\[|\]/g, '').split('%')[0] ?? '';

  if (address === '::' || address === '::1') return true;

  if (address.startsWith('::ffff:')) {
    const mapped = address.slice('::ffff:'.length);
    return isIP(mapped) === 4 ? isPrivateIpv4(mapped) : false;
  }

  const firstGroup = address.split(':')[0] ?? '';
  const first = Number.parseInt(firstGroup || '0', 16);

  if (!Number.isFinite(first)) return false;

  // fc00::/7 unique-local
  if ((first & 0xfe00) === 0xfc00) return true;

  // fe80::/10 link-local
  if ((first & 0xffc0) === 0xfe80) return true;

  // 2001:db8::/32 documentation
  if (address.startsWith('2001:db8')) return true;

  return false;
}

export function isPrivateIp(ip: string): boolean {
  const version = isIP(ip);
  if (version === 4) return isPrivateIpv4(ip);
  if (version === 6) return isPrivateIpv6(ip);
  return false;
}

export function isLoopbackHost(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/\[|\]/g, '');

  return (
    host === 'localhost' ||
    host.endsWith('.localhost') ||
    host === '::1' ||
    (isIP(host) === 4 && host.startsWith('127.'))
  );
}

const METADATA_HOSTS = new Set([
  'metadata',
  'metadata.google.internal',
  '169.254.169.254',
  '100.100.100.200',
  'fd00:ec2::254',
]);

export function isMetadataHost(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/\[|\]/g, '');
  return METADATA_HOSTS.has(host);
}

export async function assertSafeTarget(
  url: URL,
  options: { allowPrivate?: boolean } = {},
): Promise<void> {
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error('Only http:// and https:// targets are supported.');
  }

  const host = url.hostname.toLowerCase().replace(/\[|\]/g, '');

  if (isMetadataHost(host)) {
    throw new Error(`Blocked cloud metadata host: ${host}`);
  }

  if (isLoopbackHost(host)) return;

  if (isIP(host)) {
    if (isPrivateIp(host) && !options.allowPrivate) {
      throw new Error(
        `Blocked private network target: ${host}. Re-run with --allow-private if this is intentional.`,
      );
    }
    return;
  }

  let records: LookupAddress[];
  try {
    records = await lookup(host, { all: true, verbatim: true });
  } catch {
    // Let navigation surface DNS errors; there is nothing to connect to yet.
    return;
  }

  for (const record of records) {
    if (isMetadataHost(record.address)) {
      throw new Error(`Blocked cloud metadata address: ${record.address}`);
    }

    if (isPrivateIp(record.address) && !options.allowPrivate) {
      throw new Error(
        `Blocked private network address ${record.address} for ${host}. Re-run with --allow-private if this is intentional.`,
      );
    }
  }
}
