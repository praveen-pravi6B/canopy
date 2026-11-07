import { describe, expect, it } from 'vitest';
import {
  assertSafeTarget,
  isLoopbackHost,
  isMetadataHost,
  isPrivateIp,
  normalizeUrl,
  parseTargetUrl,
} from '../src/core/url.js';

describe('normalizeUrl', () => {
  it('adds a scheme and lowercases the host', () => {
    expect(normalizeUrl('HTTP://Example.COM/Path')).toBe('http://example.com/Path');
  });

  it('strips the fragment', () => {
    expect(normalizeUrl('https://example.com/page#section')).toBe('https://example.com/page');
  });

  it('resolves relative URLs against a base', () => {
    expect(normalizeUrl('/about?b=2&a=1', 'https://example.com/docs/page')).toBe(
      'https://example.com/about?a=1&b=2',
    );
  });

  it('drops tracking parameters and sorts the rest', () => {
    const result = normalizeUrl(
      'https://example.com/?utm_source=x&b=2&fbclid=abc&a=1&utm_medium=y',
    );
    expect(result).toBe('https://example.com/?a=1&b=2');
  });

  it('removes default ports', () => {
    expect(normalizeUrl('https://example.com:443/a')).toBe('https://example.com/a');
    expect(normalizeUrl('http://example.com:80/a')).toBe('http://example.com/a');
  });

  it('keeps non-default ports', () => {
    expect(normalizeUrl('http://localhost:3000/a')).toBe('http://localhost:3000/a');
  });

  it('strips trailing slashes except at the root', () => {
    expect(normalizeUrl('https://example.com/a/b/')).toBe('https://example.com/a/b');
    expect(normalizeUrl('https://example.com/')).toBe('https://example.com/');
  });

  it('normalizes a root URL without a trailing slash', () => {
    expect(normalizeUrl('https://example.com')).toBe('https://example.com/');
  });
});

describe('parseTargetUrl', () => {
  it('defaults to http for a bare host', () => {
    const url = parseTargetUrl('localhost:3000');
    expect(url.protocol).toBe('http:');
    expect(url.port).toBe('3000');
  });

  it('keeps https', () => {
    expect(parseTargetUrl('https://example.com').protocol).toBe('https:');
  });

  it('trims whitespace', () => {
    expect(parseTargetUrl('  https://example.com  ').hostname).toBe('example.com');
  });

  it('rejects empty input', () => {
    expect(() => parseTargetUrl('   ')).toThrow(/required/i);
  });

  it('rejects non-http schemes', () => {
    expect(() => parseTargetUrl('ftp://example.com')).toThrow(/http/i);
    expect(() => parseTargetUrl('file:///etc/passwd')).toThrow(/http/i);
    expect(() => parseTargetUrl('javascript:alert(1)')).toThrow(/http/i);
  });
});

describe('IP classification', () => {
  it('detects private IPv4 ranges', () => {
    for (const ip of ['10.0.0.1', '172.16.5.4', '192.168.1.1', '127.0.0.1', '169.254.169.254']) {
      expect(isPrivateIp(ip), ip).toBe(true);
    }
  });

  it('treats public IPv4 as public', () => {
    for (const ip of ['8.8.8.8', '1.1.1.1', '93.184.216.34']) {
      expect(isPrivateIp(ip), ip).toBe(false);
    }
  });

  it('detects loopback and unique-local IPv6', () => {
    expect(isPrivateIp('::1')).toBe(true);
    expect(isPrivateIp('fc00::1')).toBe(true);
    expect(isPrivateIp('fe80::1')).toBe(true);
  });

  it('treats public IPv6 as public', () => {
    expect(isPrivateIp('2606:4700:4700::1111')).toBe(false);
  });

  it('classifies loopback hostnames', () => {
    for (const host of ['localhost', 'app.localhost', '127.0.0.1', '127.8.9.10', '::1']) {
      expect(isLoopbackHost(host), host).toBe(true);
    }
    expect(isLoopbackHost('example.com')).toBe(false);
  });

  it('classifies metadata hosts', () => {
    expect(isMetadataHost('metadata.google.internal')).toBe(true);
    expect(isMetadataHost('169.254.169.254')).toBe(true);
    expect(isMetadataHost('example.com')).toBe(false);
  });
});

describe('assertSafeTarget', () => {
  it('blocks cloud metadata hosts', async () => {
    await expect(
      assertSafeTarget(new URL('http://169.254.169.254/latest/meta-data')),
    ).rejects.toThrow(/metadata/i);
  });

  it('allows loopback without extra flags', async () => {
    await expect(assertSafeTarget(new URL('http://127.0.0.1:3000'))).resolves.toBeUndefined();
    await expect(assertSafeTarget(new URL('http://localhost:8080'))).resolves.toBeUndefined();
  });

  it('blocks private addresses unless explicitly allowed', async () => {
    await expect(assertSafeTarget(new URL('http://10.0.0.5'))).rejects.toThrow(/private/i);
    await expect(
      assertSafeTarget(new URL('http://10.0.0.5'), { allowPrivate: true }),
    ).resolves.toBeUndefined();
  });

  it('allows public IP targets', async () => {
    await expect(assertSafeTarget(new URL('http://8.8.8.8'))).resolves.toBeUndefined();
  });

  it('rejects non-http protocols', async () => {
    await expect(assertSafeTarget(new URL('ftp://example.com'))).rejects.toThrow(/http/i);
  });
});
