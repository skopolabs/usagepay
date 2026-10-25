import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import react from '@vitejs/plugin-react';
import type { Plugin } from 'vite';
import { defineConfig } from 'vitest/config';
import { workspaceAliases } from '../../vitest.aliases.ts';

const DEFAULT_BUNDLE = fileURLToPath(new URL('../demo/out/demo-bundle.json', import.meta.url));
const BUNDLE_MODULE = 'virtual:upay-bundle';

/** A Stellar secret seed (`S` + 55 base32 characters). Nothing like it may ever reach the browser (SPEC 05 D10). */
export const SECRET_SEED = /\bS[A-Z2-7]{55}\b/;

/**
 * Inlines the demo bundle written by `pnpm demo` (or `UPAY_BUNDLE`) into the app at build time, so the page makes
 * no data request at runtime. Refuses a missing bundle or one that carries anything shaped like a secret seed.
 */
function demoBundle(): Plugin {
  return {
    name: 'upay-demo-bundle',
    resolveId: (id) => (id === BUNDLE_MODULE ? `\0${BUNDLE_MODULE}` : undefined),
    load(id) {
      if (id !== `\0${BUNDLE_MODULE}`) return undefined;
      const file = process.env['UPAY_BUNDLE'] ?? DEFAULT_BUNDLE;
      if (!existsSync(file)) this.error(`demo bundle not found at ${file}: run "corepack pnpm demo" first`);
      this.addWatchFile(file);
      const text = readFileSync(file, 'utf8');
      if (SECRET_SEED.test(text)) this.error(`refusing ${file}: it contains something shaped like a Stellar secret seed`);
      return `export default JSON.parse(${JSON.stringify(text)});`;
    },
  };
}

/**
 * The built page may load nothing and connect nowhere (SPEC 05 UI-AC09): only links the user opens leave the page.
 * Added at build time only, because the dev server needs its own module and HMR connections.
 */
export const CONTENT_SECURITY_POLICY = "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data:; connect-src 'none'; base-uri 'none'; form-action 'none'";

/** Folds the entry script and stylesheet into index.html: one self-contained file that opens offline, even from disk. */
function singleFile(): Plugin {
  return {
    name: 'upay-single-file',
    apply: 'build',
    enforce: 'post',
    transformIndexHtml: () => [{ tag: 'meta', attrs: { 'http-equiv': 'Content-Security-Policy', content: CONTENT_SECURITY_POLICY }, injectTo: 'head-prepend' }],
    generateBundle(_options, bundle) {
      const html = bundle['index.html'];
      if (html?.type !== 'asset') return;
      let source = String(html.source);
      for (const [name, file] of Object.entries(bundle)) {
        const tag = (pattern: string) => new RegExp(pattern.replace('NAME', name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
        if (file.type === 'chunk') {
          const code = file.code.replace(/<\/script/gi, '<\\/script');
          source = source.replace(tag('<script[^>]*src="[^"]*NAME"[^>]*></script>'), () => `<script type="module">${code}</script>`);
          delete bundle[name];
        } else if (name.endsWith('.css')) {
          source = source.replace(tag('<link[^>]*href="[^"]*NAME"[^>]*>'), () => `<style>${String(file.source)}</style>`);
          delete bundle[name];
        }
      }
      html.source = source;
    },
  };
}

export default defineConfig({
  base: './',
  plugins: [react(), demoBundle(), singleFile()],
  resolve: { alias: workspaceAliases },
  build: { outDir: 'dist', emptyOutDir: true, modulePreload: { polyfill: false }, assetsInlineLimit: Number.MAX_SAFE_INTEGER },
  test: {
    name: 'web',
    root: fileURLToPath(new URL('.', import.meta.url)),
    environment: 'jsdom',
    include: ['test/**/*.test.{ts,tsx}'],
    globalSetup: ['test/global-setup.ts'],
    testTimeout: 60_000,
    hookTimeout: 120_000,
  },
});
