// @vitest-environment node
import { mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'vite';
import { describe, expect, inject, it } from 'vitest';
import { CONTENT_SECURITY_POLICY, SECRET_SEED } from '../vite.config.ts';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const { liveFile } = inject('bundles');

async function buildWith(bundleFile: string): Promise<string> {
  const outDir = mkdtempSync(join(tmpdir(), 'upay-web-dist-'));
  const previous = process.env['UPAY_BUNDLE'];
  process.env['UPAY_BUNDLE'] = bundleFile;
  try {
    await build({ root: ROOT, configFile: join(ROOT, 'vite.config.ts'), logLevel: 'silent', build: { outDir, emptyOutDir: true } });
  } finally {
    if (previous === undefined) delete process.env['UPAY_BUNDLE'];
    else process.env['UPAY_BUNDLE'] = previous;
  }
  return outDir;
}

describe('UI-AC09: the production build holds no secret and loads nothing from the network', () => {
  it('is one self-contained index.html with a no-connect CSP, no secret seed and no external resource', async () => {
    const outDir = await buildWith(liveFile);
    expect(readdirSync(outDir)).toEqual(['index.html']);
    const html = readFileSync(join(outDir, 'index.html'), 'utf8');

    expect(html).toContain(`content="${CONTENT_SECURITY_POLICY.replaceAll("'", '&#39;')}"`);
    expect(CONTENT_SECURITY_POLICY).toContain("connect-src 'none'");
    expect(SECRET_SEED.test(html)).toBe(false);
    expect(html).not.toMatch(/PRIVATE KEY|secretKey|SECRET_KEY/);

    // Outside the inline script and stylesheet, the page references no file or URL at all.
    const markup = html.replace(/<script\b[^>]*>[\s\S]*?<\/script>/g, '').replace(/<style\b[^>]*>[\s\S]*?<\/style>/g, '');
    expect(markup).not.toMatch(/\b(src|href)=/);
    const scripts = html.match(/<script\b[^>]*>[\s\S]*?<\/script>/g) ?? [];
    expect(scripts).toHaveLength(1);
    expect(scripts[0]?.startsWith('<script type="module">')).toBe(true);
    for (const api of ['fetch(', 'XMLHttpRequest', 'WebSocket', 'EventSource', 'sendBeacon']) expect(html).not.toContain(api);

    // The real run is inlined: its close transaction is in the page.
    const bundle = JSON.parse(readFileSync(liveFile, 'utf8')) as { realRun: { settlement: { closeTxHash: string } } };
    expect(html).toContain(bundle.realRun.settlement.closeTxHash);
  });

  it('the Vercel headers repeat the page CSP and forbid framing (SPEC 05 D12)', () => {
    const config = JSON.parse(readFileSync(join(ROOT, 'vercel.json'), 'utf8')) as { headers: { source: string; headers: { key: string; value: string }[] }[] };
    const headers = new Map(config.headers.flatMap((rule) => (rule.source === '/(.*)' ? rule.headers.map((h) => [h.key, h.value] as const) : [])));
    expect(headers.get('Content-Security-Policy')).toBe(`${CONTENT_SECURITY_POLICY}; frame-ancestors 'none'`);
    expect(headers.get('X-Frame-Options')).toBe('DENY');
    expect(headers.get('X-Content-Type-Options')).toBe('nosniff');
    expect(headers.get('Referrer-Policy')).toBe('no-referrer');
  });

  it('refuses a bundle carrying anything shaped like a Stellar secret seed', async () => {
    const tainted = join(mkdtempSync(join(tmpdir(), 'upay-web-bad-')), 'demo-bundle.json');
    const fakeSeed = `S${'A'.repeat(55)}`;
    writeFileSync(tainted, readFileSync(liveFile, 'utf8').replace('"limits":[', `"limits":["${fakeSeed}",`));
    await expect(buildWith(tainted)).rejects.toThrow(/secret seed/);
  });

  it('refuses to build without a bundle and says how to make one', async () => {
    await expect(buildWith(join(tmpdir(), 'upay-no-such-bundle.json'))).rejects.toThrow(/run "corepack pnpm demo" first/);
  });
});
