#!/usr/bin/env node
// Writes the Playwright MCP config for the proxied browser from environment variables (so the credentials stay in .env). Either ONE variable, in the
// form the proxy seller gives it (see proxy-parse.cjs: host;port;user;pass · user:pass@host:port · host:port:user:pass · http://user:pass@host:port …):
//   PLAYWRIGHT_PROXY          the whole proxy in one line
// or the older separate ones (PLAYWRIGHT_PROXY_SERVER may be in any of those shapes too; the login / password variables win when set):
//   PLAYWRIGHT_PROXY_SERVER   host:port  (or a full URL: http://host:port, socks5://host:port)
//   PLAYWRIGHT_PROXY_USER     login      (optional)
//   PLAYWRIGHT_PROXY_PASS     password   (optional)
// and, with either:
//   PLAYWRIGHT_PROXY_BYPASS   comma-separated hosts that skip the proxy (optional)
// Usage: node playwright-proxy-config.cjs /tmp/pw.json
const { writeFileSync } = require('node:fs');
const { parseProxy } = require('./proxy-parse.cjs');

const raw = (process.env.PLAYWRIGHT_PROXY || process.env.PLAYWRIGHT_PROXY_SERVER || '').trim();
if (!raw) {
  console.error('No proxy is set. Put PLAYWRIGHT_PROXY=host;port;user;pass (or host:port, user:pass@host:port, http://user:pass@host:port) in .env, then restart the playwright-mcp-proxy service.');
  process.exit(2);
}
let proxy;
try {
  proxy = parseProxy(raw);
} catch (e) {
  console.error(e.message);
  process.exit(2);
}
if (process.env.PLAYWRIGHT_PROXY_USER) proxy.username = process.env.PLAYWRIGHT_PROXY_USER;
if (process.env.PLAYWRIGHT_PROXY_PASS) proxy.password = process.env.PLAYWRIGHT_PROXY_PASS;
if (process.env.PLAYWRIGHT_PROXY_BYPASS) proxy.bypass = process.env.PLAYWRIGHT_PROXY_BYPASS;
writeFileSync(process.argv[2] || '/tmp/pw-proxy.json', JSON.stringify({ browser: { launchOptions: { proxy } } }), { mode: 0o600 });
console.log(`Playwright proxy: ${proxy.server}${proxy.username ? ` (login ${proxy.username})` : ''}`);
if (proxy.server.startsWith('socks') && proxy.username) console.warn('Warning: Chromium does not support a login on a SOCKS proxy. Use the provider\'s HTTP(S) port for this proxy if pages do not load.');
