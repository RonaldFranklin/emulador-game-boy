import { createHash } from 'node:crypto';
import { AsyncLocalStorage } from 'node:async_hooks';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import type { ServerResponse } from 'node:http';
import type { Plugin } from 'vite';

const header = 'Content-Security-Policy-Report-Only';
export function policy(html: string, development = false) {
  const hashes = (tag: string) => [...html.matchAll(new RegExp(`<${tag}\\b([^>]*)>([\\s\\S]*?)<\\/${tag}>`, 'gi'))]
    .filter(match => !/\bsrc\s*=/.test(match[1]) && match[2].trim())
    .map(match => `'sha256-${createHash('sha256').update(match[2]).digest('base64')}'`).join(' ');
  return ["default-src 'none'", `script-src 'self' 'wasm-unsafe-eval' ${hashes('script')}`,
    `style-src-elem 'self' ${development ? "'unsafe-inline'" : hashes('style')}`,
    "style-src-attr 'unsafe-inline'", "img-src 'self' blob: data:", "font-src 'self'",
    `connect-src 'self'${development ? ' ws://127.0.0.1:* ws://localhost:*' : ''}`,
    "worker-src 'self'", "media-src 'self' blob:", "object-src 'none'", "base-uri 'none'",
    "frame-ancestors 'none'", "form-action 'self'"].join('; ');
}

/** Report-only on the document, not just API responses. No user data enters this policy. */
export function documentCsp(): Plugin {
  const responses = new AsyncLocalStorage<ServerResponse>();
  let root = '', outDir = '';
  return {
    name: 'document-csp',
    enforce: 'post',
    configResolved(config) { root = config.root; outDir = config.build.outDir; },
    configureServer(server) {
      server.middlewares.use((_request, response, next) => responses.run(response, next));
    },
    transformIndexHtml: { order: 'post', handler(html, context) {
      if (context.server) responses.getStore()?.setHeader(header, policy(html, true));
      return html;
    } },
    generateBundle(_options, bundle) {
      const html = bundle['index.html'];
      if (html?.type === 'asset') this.emitFile({ type: 'asset', fileName: 'csp-policy.json',
        source: JSON.stringify({ header, value: policy(String(html.source)) }, null, 2) + '\n' });
    },
    async configurePreviewServer(server) {
      const csp = JSON.parse(await readFile(resolve(root, outDir, 'csp-policy.json'), 'utf8'));
      server.middlewares.use((_request, response, next) => { response.setHeader(header, csp.value); next(); });
    },
  };
}
