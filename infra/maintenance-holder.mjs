#!/usr/bin/env node
// Aigentron "updating" page. While an update has the real server stopped (the long dark part: a graceful stop, a database copy, migrations, the switch),
// the installer runs this on the SAME ports so that anyone who opens or reloads the dashboard sees what is going on and when it ends, instead of an error:
//   * every page → the "Updating Aigentron" screen (HTTP 503 + Retry-After), which polls and reloads by itself when the new version answers;
//   * /api/health → 503 {"status":"updating"} (the installer's own health wait must not take this for the new server);
//   * any other /api/* and /socket.io/* → 503 {"updating":true} with the header `x-aigentron-updating: 1`, which the dashboard of an already open tab turns into a banner.
// Only the steps the installer announces are shown (no log lines, no paths): the page is reachable by anyone who can reach the server.
// No dependencies. Started and stopped by install.sh; it also stops itself after MAX_MINUTES in case the installer dies.
//
// usage: node maintenance-holder.mjs --version 0.1.96 [--from 0.1.95] [--port 3001] [--host 0.0.0.0] [--secrets <dir>] [--progress <file>] [--max-minutes 20]
import { createServer as http } from 'node:http';
import { createServer as https } from 'node:https';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

/** What the installer announces, in order. `key` is what it writes into the progress file; `text` is what a person reads. */
export const STEPS = [
  { key: 'stopping', text: 'Stopping the running version (running agents get a graceful stop)' },
  { key: 'snapshot', text: 'Saving a copy of the database' },
  { key: 'migrate', text: 'Updating the database' },
  { key: 'switch', text: 'Switching to the new version' },
  { key: 'start', text: 'Starting the new version' },
];

/** The progress file → which step is current: lines of `<epoch ms> <key>`; `rollback` / `done` end the list. */
export function readProgress(text) {
  const seen = [];
  let at = null;
  for (const line of String(text || '').split('\n')) {
    const m = /^(\d{10,})\s+([a-z]+)\s*$/.exec(line.trim());
    if (!m) continue;
    seen.push(m[2]);
    at = Number(m[1]);
  }
  const rollback = seen.includes('rollback');
  const last = [...seen].reverse().find((k) => STEPS.some((s) => s.key === k));
  const idx = last ? STEPS.findIndex((s) => s.key === last) : -1;
  return {
    steps: STEPS.map((s, i) => ({ text: s.text, state: rollback ? (i <= idx ? 'done' : 'todo') : i < idx ? 'done' : i === idx ? 'doing' : 'todo' })),
    rollback,
    done: seen.includes('done'),
    lastAt: at,
  };
}

const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

/** The step list as markup (also drawn by the page's own script, from the same data). */
export function stepsHtml(steps) {
  return steps.map((x) => `<li class="${x.state}"><span class="dot">${x.state === 'done' ? '✓' : ''}</span>${esc(x.text)}</li>`).join('');
}

export function page({ version, from, progress }) {
  const to = esc(version || '');
  const was = from ? ` from ${esc(from)}` : '';
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Updating Aigentron…</title>
<style>
:root{--bg:#ece5d8;--card:#f2ece0;--text:#2c2820;--dim:#7d7364;--accent:#2f6f68;--sd:rgba(120,100,70,.3);--sl:rgba(255,255,255,.7)}
@media (prefers-color-scheme:dark){:root{--bg:#1a1d23;--card:#1e2229;--text:#e8eaed;--dim:#8a909c;--accent:#45c4b0;--sd:rgba(0,0,0,.55);--sl:rgba(255,255,255,.045)}}
*{box-sizing:border-box}body{margin:0;min-height:100vh;display:grid;place-items:center;padding:16px;background:var(--bg);color:var(--text);font:15px/1.5 system-ui,-apple-system,Segoe UI,sans-serif}
.card{width:min(460px,100%);padding:26px;border-radius:20px;background:var(--card);box-shadow:7px 7px 16px var(--sd),-5px -5px 12px var(--sl)}
h1{margin:0 0 4px;font-size:20px}p{margin:0 0 14px;color:var(--dim)}ul{list-style:none;margin:16px 0;padding:0}
li{display:flex;gap:10px;align-items:center;padding:6px 0;color:var(--dim)}li.doing{color:var(--text);font-weight:600}li.done{color:var(--text)}
.dot{flex:none;width:18px;height:18px;border-radius:50%;border:2px solid var(--dim);display:grid;place-items:center;font-size:11px}
.done .dot{background:var(--accent);border-color:var(--accent);color:var(--card)}
.doing .dot{border-color:var(--accent);border-top-color:transparent;animation:spin 1s linear infinite}
@keyframes spin{to{transform:rotate(360deg)}}
.note{font-size:13px;color:var(--dim);margin-top:14px}.bad{color:#af4238;font-weight:600}
@media (prefers-reduced-motion:reduce){.doing .dot{animation:none}}
</style></head><body><main class="card">
<h1>⏳ Updating Aigentron to ${to}</h1>
<p id="lead">The server is down while it switches versions${was}. This page reconnects by itself — no need to reload or restart anything.</p>
<ul id="steps" aria-live="polite">${stepsHtml((progress || readProgress('')).steps)}</ul>
<div id="msg" class="note"></div>
<div class="note" id="time"></div>
</main>
<script>
(function(){
var t0=Date.now();
function el(i){return document.getElementById(i)}
function draw(s){
  var h='';for(var i=0;i<s.steps.length;i++){var x=s.steps[i];h+='<li class="'+x.state+'"><span class="dot">'+(x.state==='done'?'✓':'')+'</span>'+x.text.replace(/[&<>]/g,'')+'</li>'}
  el('steps').innerHTML=h;
  el('msg').className='note'+(s.rollback?' bad':'');
  el('msg').textContent=s.rollback?'The new version did not start; the previous one is being restored. The dashboard comes back in a minute.':'';
}
function tick(){var m=Math.floor((Date.now()-t0)/1000);el('time').textContent='Waiting for '+Math.floor(m/60)+':'+('0'+m%60).slice(-2)+' (usually 1–3 minutes)'}
function poll(){
  fetch('/api/health',{cache:'no-store'}).then(function(r){
    if(r.status===503){return fetch('/__update/status',{cache:'no-store'}).then(function(x){return x.json()}).then(draw)}
    if(r.ok){location.reload();return}
    throw new Error('status '+r.status)
  }).catch(function(){
    // the page that was holding the port has gone and the new server is not up yet (or the connection dropped): the last step, shown as such
    el('msg').textContent='Starting the new version…'
  });
}
poll();setInterval(poll,2000);setInterval(tick,1000);tick();
})();
</script></body></html>`;
}

/** The progress file's text ('' when there is none yet: the first step is not announced). */
function readFileSafe(file) {
  try {
    return file && existsSync(file) ? readFileSync(file, 'utf8') : '';
  } catch {
    return '';
  }
}

export function createHandler({ version, from, progressFile }) {
  const started = Date.now();
  return (req, res) => {
    const url = (req.url || '/').split('?')[0];
    const send = (status, type, body, extra = {}) => {
      res.writeHead(status, { 'content-type': type, 'cache-control': 'no-store', 'x-aigentron-updating': '1', 'retry-after': '10', ...extra });
      res.end(req.method === 'HEAD' ? undefined : body);
    };
    if (url === '/api/health') return send(503, 'application/json', JSON.stringify({ status: 'updating', version: version || null, from: from || null, startedAt: new Date(started).toISOString() }));
    if (url === '/__update/status') {
      return send(200, 'application/json', JSON.stringify({ version: version || null, from: from || null, ...readProgress(readFileSafe(progressFile)) }));
    }
    if (url.startsWith('/api/') || url.startsWith('/socket.io/')) return send(503, 'application/json', JSON.stringify({ updating: true, message: `Aigentron is updating${version ? ` to ${version}` : ''} — it is back in a minute or two.` }));
    return send(503, 'text/html; charset=utf-8', page({ version, from, progress: readProgress(readFileSafe(progressFile)) }));
  };
}

/** The ports the real server holds: the API port, plus the HTTP / HTTPS ports of the web-server settings (HTTPS only when its certificate is there). */
export function portsOf({ port, secrets }) {
  const out = { api: port, http: 0, https: 0, tls: null };
  if (!secrets) return out;
  try {
    const cfg = JSON.parse(readFileSync(join(secrets, 'web-server.json'), 'utf8'));
    out.http = Number.isInteger(cfg.httpPort) ? cfg.httpPort : 0;
    out.https = Number.isInteger(cfg.httpsPort) ? cfg.httpsPort : 443;
  } catch {
    out.https = 443; // the default when nothing was ever saved
  }
  const cert = join(secrets, 'tls', 'fullchain.pem');
  const key = join(secrets, 'tls', 'privkey.pem');
  if (out.https && existsSync(cert) && existsSync(key)) {
    try {
      out.tls = { cert: readFileSync(cert), key: readFileSync(key) };
    } catch {
      out.https = 0;
    }
  } else out.https = 0;
  return out;
}

function arg(name, def = '') {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] !== undefined ? process.argv[i + 1] : def;
}

async function main() {
  const version = arg('version');
  const handler = createHandler({ version, from: arg('from'), progressFile: arg('progress') || null });
  const host = arg('host') || undefined;
  const p = portsOf({ port: Number(arg('port', '3001')), secrets: arg('secrets') || null });
  const servers = [];
  const listen = (srv, port, label) =>
    new Promise((resolve) => {
      srv.on('error', (e) => {
        console.error(`holder: could not listen on ${label} ${port}: ${e.code || e.message}`);
        resolve(false);
      });
      srv.listen(port, host, () => resolve(true));
    });
  for (const [srv, port, label] of [
    [http(handler), p.api, 'API'],
    ...(p.http ? [[http(handler), p.http, 'HTTP']] : []),
    ...(p.https && p.tls ? [[https({ ...p.tls, minVersion: 'TLSv1.2' }, handler), p.https, 'HTTPS']] : []),
  ]) {
    if (await listen(srv, port, label)) servers.push(srv);
  }
  console.log(`holder: serving the updating page on ${servers.length} port(s)`);
  const stop = () => {
    for (const s of servers) {
      s.close();
      s.closeAllConnections?.();
    }
    setTimeout(() => process.exit(0), 200).unref();
  };
  process.on('SIGTERM', stop);
  process.on('SIGINT', stop);
  setTimeout(stop, Number(arg('max-minutes', '20')) * 60_000).unref();
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main();
