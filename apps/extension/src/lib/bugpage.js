// Functions that run INSIDE the page for the bug report (chrome.scripting.executeScript({ func })). They are serialised, so each one is self-contained:
// no imports, no variables from outside. Nothing is recorded until the person presses "Start recording" on that tab, and only until the page is reloaded.

/** MAIN world: starts collecting console errors / warnings, uncaught errors, failed requests (fetch, XHR, resources). Safe to call twice. */
export function installRecorder() {
  if (window.__aigentronRec) return { ok: true, already: true };
  const MAX = 50;
  const rec = { console: [], network: [], errors: [], startedAt: Date.now() };
  window.__aigentronRec = rec;
  const cut = (v, n) => String(v ?? '').slice(0, n);
  const push = (list, item) => {
    list.push(item);
    if (list.length > MAX) list.shift();
  };
  // addresses lose their query and fragment (they carry tokens); the path stays
  const clean = (u) => {
    try {
      const x = new URL(String(u), location.href);
      return `${x.origin}${x.pathname}`.slice(0, 300);
    } catch {
      return cut(u, 300);
    }
  };
  const fmt = (a) => {
    try {
      return typeof a === 'string' ? a : a instanceof Error ? `${a.name}: ${a.message}` : JSON.stringify(a);
    } catch {
      return String(a);
    }
  };
  for (const level of ['error', 'warn']) {
    const orig = console[level];
    console[level] = function (...args) {
      push(rec.console, { level, text: cut(args.map(fmt).join(' '), 500), at: Date.now() - rec.startedAt });
      return orig.apply(this, args);
    };
  }
  window.addEventListener('error', (e) => {
    if (e.target && e.target !== window && (e.target.src || e.target.href)) {
      push(rec.network, { method: 'GET', url: clean(e.target.src || e.target.href), status: 0, note: `${e.target.tagName.toLowerCase()} failed to load`, at: Date.now() - rec.startedAt });
    } else {
      push(rec.errors, { message: cut(e.message, 300), source: clean(e.filename || ''), line: e.lineno || 0, at: Date.now() - rec.startedAt });
    }
  }, true);
  window.addEventListener('unhandledrejection', (e) => {
    push(rec.errors, { message: cut(`Unhandled rejection: ${e.reason?.message ?? e.reason}`, 300), source: '', line: 0, at: Date.now() - rec.startedAt });
  });
  const origFetch = window.fetch;
  window.fetch = function (input, init) {
    const method = String(init?.method ?? (input && input.method) ?? 'GET').toUpperCase();
    const url = clean(input && input.url ? input.url : input);
    return origFetch.apply(this, arguments).then(
      (r) => {
        if (!r.ok) push(rec.network, { method, url, status: r.status, at: Date.now() - rec.startedAt });
        return r;
      },
      (err) => {
        push(rec.network, { method, url, status: 0, note: cut(err?.message, 100), at: Date.now() - rec.startedAt });
        throw err;
      },
    );
  };
  const open = XMLHttpRequest.prototype.open;
  XMLHttpRequest.prototype.open = function (method, url) {
    this.addEventListener('loadend', () => {
      if (this.status === 0 || this.status >= 400) push(rec.network, { method: String(method).toUpperCase(), url: clean(url), status: this.status, at: Date.now() - rec.startedAt });
    });
    return open.apply(this, arguments);
  };
  return { ok: true };
}

/** MAIN world: how much has been collected so far. */
export function peekRecorder() {
  const r = window.__aigentronRec;
  return r ? { recording: true, console: r.console.length, network: r.network.length, errors: r.errors.length } : { recording: false, console: 0, network: 0, errors: 0 };
}

/** MAIN world: everything collected, plus failed resources the page already had before recording, plus the environment. Redacts tokens. */
export function collectReport() {
  const r = window.__aigentronRec ?? { console: [], network: [], errors: [] };
  const redact = (s) =>
    String(s)
      .replace(/(bearer|token|authorization|api[_-]?key|password|secret)(["'\s:=]+)[A-Za-z0-9._~+/=-]{8,}/gi, '$1$2[redacted]')
      .replace(/\b[A-Za-z0-9_-]{32,}\b/g, '[redacted]');
  const network = [...r.network];
  try {
    for (const e of performance.getEntriesByType('resource')) {
      if (e.responseStatus >= 400) {
        const u = new URL(e.name);
        const url = `${u.origin}${u.pathname}`.slice(0, 300);
        if (!network.some((n) => n.url === url && n.status === e.responseStatus)) network.unshift({ method: 'GET', url, status: e.responseStatus, at: -1, note: 'before recording' });
      }
    }
  } catch {
    /* resource timing not available */
  }
  return {
    console: r.console.map((c) => ({ ...c, text: redact(c.text) })),
    network: network.slice(-50),
    errors: r.errors.map((e) => ({ ...e, message: redact(e.message) })),
    env: {
      userAgent: navigator.userAgent,
      viewport: { w: window.innerWidth, h: window.innerHeight },
      dpr: window.devicePixelRatio,
      language: navigator.language,
      scroll: { x: Math.round(window.scrollX), y: Math.round(window.scrollY) },
      url: location.origin + location.pathname,
      title: document.title,
    },
    recorded: Boolean(window.__aigentronRec),
  };
}

/**
 * ISOLATED world: lets the person click an element on the page (hover outlines it; Escape cancels). Resolves with where it is, what it is and how it
 * looks — a short selector, the tag, its text, its outer HTML (cut), its box, a handful of computed styles. Never reads form values or passwords.
 */
export function pickElement() {
  return new Promise((resolve) => {
    const host = document.createElement('div');
    host.style.cssText = 'all: initial; position: fixed; inset: 0; z-index: 2147483647; cursor: crosshair;';
    const root = host.attachShadow({ mode: 'closed' });
    const box = document.createElement('div');
    box.style.cssText = 'position: fixed; pointer-events: none; border: 2px solid #ff2d2d; background: rgba(255,45,45,.12); border-radius: 2px;';
    const hint = document.createElement('div');
    hint.textContent = 'Click the element you mean — Esc to cancel';
    hint.style.cssText = 'position: fixed; top: 10px; left: 50%; transform: translateX(-50%); background: #1b1f24; color: #fff; font: 13px system-ui, sans-serif; padding: 6px 12px; border-radius: 8px; pointer-events: none;';
    root.append(box, hint);
    document.documentElement.append(host);

    const at = (x, y) => {
      host.style.pointerEvents = 'none';
      const el = document.elementFromPoint(x, y);
      host.style.pointerEvents = 'auto';
      return el;
    };
    const cssPath = (el) => {
      const parts = [];
      for (let n = el; n && n.nodeType === 1 && parts.length < 6; n = n.parentElement) {
        if (n.id && document.querySelectorAll(`#${CSS.escape(n.id)}`).length === 1) {
          parts.unshift(`#${CSS.escape(n.id)}`);
          break;
        }
        let part = n.localName;
        const cls = [...n.classList].slice(0, 2).map((c) => `.${CSS.escape(c)}`).join('');
        part += cls;
        const same = n.parentElement ? [...n.parentElement.children].filter((c) => c.localName === n.localName) : [];
        if (same.length > 1) part += `:nth-of-type(${same.indexOf(n) + 1})`;
        parts.unshift(part);
        if (n === document.body) break;
      }
      return parts.join(' > ');
    };
    const done = (value) => {
      host.remove();
      window.removeEventListener('keydown', onKey, true);
      resolve(value);
    };
    const onKey = (e) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        done(null);
      }
    };
    window.addEventListener('keydown', onKey, true);
    host.addEventListener('mousemove', (e) => {
      const el = at(e.clientX, e.clientY);
      if (!el) return;
      const r = el.getBoundingClientRect();
      Object.assign(box.style, { left: `${r.left}px`, top: `${r.top}px`, width: `${r.width}px`, height: `${r.height}px` });
    });
    host.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      const el = at(e.clientX, e.clientY);
      if (!el) return done(null);
      const r = el.getBoundingClientRect();
      const cs = getComputedStyle(el);
      const styles = {};
      for (const k of ['display', 'position', 'width', 'height', 'margin', 'padding', 'color', 'backgroundColor', 'fontSize', 'fontFamily', 'fontWeight', 'lineHeight', 'zIndex', 'overflow', 'opacity', 'visibility']) styles[k] = cs[k];
      const attrs = {};
      for (const a of ['id', 'class', 'role', 'aria-label', 'href', 'src', 'type', 'name', 'disabled']) if (el.hasAttribute(a)) attrs[a] = String(el.getAttribute(a)).slice(0, 200);
      const isInput = el.matches?.('input, textarea, select');
      done({
        selector: cssPath(el).slice(0, 400),
        tag: el.localName,
        text: isInput ? '' : String(el.innerText || el.textContent || '').trim().slice(0, 300),
        html: isInput ? `<${el.localName}${attrs.type ? ` type="${attrs.type}"` : ''}${attrs.name ? ` name="${attrs.name}"` : ''}>` : el.outerHTML.slice(0, 1500),
        rect: { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) },
        styles,
        attrs,
      });
    }, true);
  });
}
