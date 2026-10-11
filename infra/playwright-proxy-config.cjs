#!/usr/bin/env node
// Writes the Playwright MCP config for the proxied browser from environment variables (so the credentials stay in .env):
//   PLAYWRIGHT_PROXY_SERVER   host:port  (or a full URL: http://host:port, socks5://host:port)
//   PLAYWRIGHT_PROXY_USER     login      (optional)
//   PLAYWRIGHT_PROXY_PASS     password   (optional)
//   PLAYWRIGHT_PROXY_BYPASS   comma-separated hosts that skip the proxy (optional)
// Usage: node playwright-proxy-config.cjs /tmp/pw.json
const { writeFileSync } = require('node:fs');

const raw = (process.env.PLAYWRIGHT_PROXY_SERVER || '').trim();
if (!raw) {
  console.error('PLAYWRIGHT_PROXY_SERVER is not set (expected host:port). Add it to .env, then restart the playwright-mcp-proxy service.');
  process.exit(2);
}
const server = /^[a-z][a-z0-9+.-]*:\/\//i.test(raw) ? raw : `http://${raw}`;
const proxy = { server };
if (process.env.PLAYWRIGHT_PROXY_USER) proxy.username = process.env.PLAYWRIGHT_PROXY_USER;
if (process.env.PLAYWRIGHT_PROXY_PASS) proxy.password = process.env.PLAYWRIGHT_PROXY_PASS;
if (process.env.PLAYWRIGHT_PROXY_BYPASS) proxy.bypass = process.env.PLAYWRIGHT_PROXY_BYPASS;
writeFileSync(process.argv[2] || '/tmp/pw-proxy.json', JSON.stringify({ browser: { launchOptions: { proxy } } }), { mode: 0o600 });
console.log(`Playwright proxy: ${server}${proxy.username ? ` (login ${proxy.username})` : ''}`);
