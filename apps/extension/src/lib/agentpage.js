// Functions that run INSIDE a page the agent works in (isolated world; chrome.scripting.executeScript({ func })). Each is self-contained.
// They only READ: a text outline, the readable text, and the frame that shows the person an agent is working here.

/** A text outline of the page: headings, links (with addresses), buttons, fields (never their values), images with a description — numbered so they can be referred to. */
export function snapshotPage() {
  // watching for the person's own hands starts here, on every new page, before the first action
  if (!window.__aigentronUserListener) {
    window.__aigentronUserListener = true;
    window.__aigentronListenerAt = Date.now();
    for (const t of ['pointerdown', 'keydown', 'beforeinput', 'compositionupdate', 'pointermove']) {
      window.addEventListener(t, (e) => {
        if (!e.isTrusted || window.__aigentronActing) return; // (the agent's own typing makes trusted input events too)
        if (e.type === 'pointermove' && !e.buttons) return; // a drag counts, a pointer that merely passes does not
        const n = e.target;
        if (n && n.closest && n.closest('[data-aigentron-ui]')) return; // the extension's own cards and frame: pressing Approve is not "using the page"
        window.__aigentronUserAt = Date.now();
      }, true);
    }
  }
  const MAX_NODES = 400;
  const MAX_CHARS = 20000;
  const out = [];
  let n = 0;
  const refs = (window.__aigentronRefs = new Map());
  const clean = (s, k = 120) => String(s ?? '').replace(/\s+/g, ' ').trim().slice(0, k);
  const visible = (el) => {
    const r = el.getBoundingClientRect();
    if (r.width <= 0 || r.height <= 0) return false;
    const cs = getComputedStyle(el);
    return cs.visibility !== 'hidden' && cs.display !== 'none' && cs.opacity !== '0';
  };
  const label = (el) => {
    const id = el.id && document.querySelector(`label[for="${CSS.escape(el.id)}"]`);
    return clean(el.getAttribute('aria-label') || (id && id.textContent) || el.closest('label')?.textContent || el.getAttribute('placeholder') || el.getAttribute('name') || el.getAttribute('title'), 80);
  };
  const add = (el, line) => {
    if (n >= MAX_NODES) return;
    n += 1;
    const ref = `e${n}`;
    refs.set(ref, el);
    out.push(`[${ref}] ${line}`);
  };
  const sel = 'h1,h2,h3,h4,a[href],button,[role="button"],input,textarea,select,img[alt],summary,[role="link"],[role="tab"],[role="menuitem"]';
  for (const el of document.body ? document.body.querySelectorAll(sel) : []) {
    if (n >= MAX_NODES) break;
    if (!visible(el)) continue;
    const tag = el.localName;
    if (/^h[1-4]$/.test(tag)) add(el, `${'#'.repeat(Number(tag[1]))} ${clean(el.textContent)}`);
    else if (tag === 'a') {
      const t = clean(el.textContent) || clean(el.getAttribute('aria-label')) || clean(el.querySelector('img')?.alt);
      if (t) add(el, `link "${t}" → ${el.href}`);
    } else if (tag === 'button' || el.getAttribute('role') === 'button' || tag === 'summary') add(el, `button "${clean(el.textContent) || label(el)}"`);
    else if (tag === 'input') {
      const type = (el.getAttribute('type') || 'text').toLowerCase();
      if (type === 'hidden' || type === 'password') {
        if (type === 'password') add(el, 'field (password — not shown)');
        continue;
      }
      if (type === 'submit' || type === 'button') add(el, `button "${clean(el.value) || label(el)}"`);
      else add(el, `field type=${type} label="${label(el)}"${el.disabled ? ' (disabled)' : ''}`);
    } else if (tag === 'textarea') add(el, `field type=textarea label="${label(el)}"`);
    else if (tag === 'select') add(el, `select label="${label(el)}" options: ${[...el.options].slice(0, 12).map((o) => clean(o.text, 30)).join(' | ')}`);
    else if (tag === 'img') {
      if (clean(el.alt).length > 3) add(el, `image "${clean(el.alt)}"`);
    } else if (el.getAttribute('role') === 'link' || el.getAttribute('role') === 'tab' || el.getAttribute('role') === 'menuitem') add(el, `${el.getAttribute('role')} "${clean(el.textContent)}"`);
  }
  let lead = '';
  try {
    const main = document.querySelector('article') || document.querySelector('main') || document.querySelector('[role="main"]') || document.body;
    lead = clean(main?.innerText, 1500);
  } catch {
    /* no text access */
  }
  const text = `${lead ? `Main text (start): ${lead}\n\n` : ''}Elements:\n${out.join('\n')}`.slice(0, MAX_CHARS);
  return { title: document.title || '', url: location.href, text, truncated: n >= MAX_NODES };
}

/** The readable text of the page, a window of it: `offset`, at most `max` characters; `more` says there is more. */
export function readPage(offset, max) {
  const tidy = (s) => String(s || '').replace(/[ \t]+/g, ' ').replace(/ ?\n ?/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
  let text = '';
  try {
    const main = document.querySelector('article') || document.querySelector('main') || document.querySelector('[role="main"]');
    text = (main && main.innerText) || '';
    if (text.length < 400 && document.body) text = document.body.innerText || text;
  } catch {
    /* no text access */
  }
  text = tidy(text);
  const start = Math.max(0, Number(offset) || 0);
  const end = Math.min(text.length, start + (Number(max) || 12000));
  return { title: document.title || '', url: location.href, text: text.slice(start, end), more: end < text.length, offset: end, total: text.length };
}

/** The frame and banner that tell the person an agent is working in this tab; `on = false` removes them. Its Stop button reacts only to a real click. */
export function agentFrame(on) {
  const ID = '__aigentronAgentFrame';
  const old = window[ID];
  if (old) {
    old.remove();
    window[ID] = null;
  }
  if (!on) return true;
  // the person's own hands: a real click, key press, typing or drag in this tab pauses the agent for a moment (see actInPage). Scrolling does NOT count: a
  // trackpad keeps sending wheel events for seconds after the fingers have left it, and reading the page is not in the agent's way.
  if (!window.__aigentronUserListener) {
    window.__aigentronUserListener = true;
    window.__aigentronListenerAt = Date.now();
    for (const t of ['pointerdown', 'keydown', 'beforeinput', 'compositionupdate', 'pointermove']) {
      window.addEventListener(t, (e) => {
        if (!e.isTrusted || window.__aigentronActing) return; // (the agent's own typing makes trusted input events too)
        if (e.type === 'pointermove' && !e.buttons) return; // a drag counts, a pointer that merely passes does not
        const n = e.target;
        if (n && n.closest && n.closest('[data-aigentron-ui]')) return; // the extension's own cards and frame: pressing Approve is not "using the page"
        window.__aigentronUserAt = Date.now();
      }, true);
    }
  }
  const host = document.createElement('div');
  host.style.cssText = 'all: initial; position: fixed; inset: 0; z-index: 2147483646; pointer-events: none;';
  host.setAttribute('data-aigentron-ui', '1');
  const root = host.attachShadow({ mode: 'closed' });
  const frame = document.createElement('div');
  frame.style.cssText = 'position: fixed; inset: 0; border: 3px solid #4e78ff; box-shadow: inset 0 0 0 1px rgba(255,255,255,.5); pointer-events: none;';
  const bar = document.createElement('div');
  bar.style.cssText = 'position: fixed; top: 6px; left: 50%; transform: translateX(-50%); display: flex; gap: 10px; align-items: center; background: #1b1f24; color: #fff; font: 13px system-ui, sans-serif; padding: 6px 8px 6px 12px; border-radius: 999px; box-shadow: 0 4px 16px rgba(0,0,0,.35); pointer-events: auto;';
  const label = document.createElement('span');
  label.textContent = 'An Aigentron agent is working in this tab';
  const stop = document.createElement('button');
  stop.textContent = 'Stop';
  stop.style.cssText = 'font: inherit; background: #d33; color: #fff; border: 0; border-radius: 999px; padding: 3px 12px; cursor: pointer;';
  stop.addEventListener('click', (e) => {
    if (!e.isTrusted) return;
    chrome.runtime.sendMessage({ type: 'agent-stop' }).catch(() => undefined);
  });
  bar.append(label, stop);
  root.append(frame, bar);
  document.documentElement.append(host);
  window[ID] = host;
  return true;
}

/**
 * Does one thing on the page for the agent: click, type, select, press a key, scroll. Self-contained (it runs inside the page).
 * Rules it keeps itself: never fills password / card / one-time-code fields; a click or Enter that would SUBMIT or COMMIT something (a form's submit
 * button, pay / order / delete / send / sign in …) is NOT done unless `confirmed` is set — it answers `needsSubmit` with what the person should see
 * (the button, the site, the form's values; sensitive ones masked); pauses while the person is using the tab; outlines what it touched.
 */
export function actInPage(a) {
  if (!window.__aigentronUserListener) {
    window.__aigentronUserListener = true;
    window.__aigentronListenerAt = Date.now();
    for (const t of ['pointerdown', 'keydown', 'beforeinput', 'compositionupdate', 'pointermove']) {
      window.addEventListener(t, (e) => {
        if (!e.isTrusted || window.__aigentronActing) return; // (the agent's own typing makes trusted input events too)
        if (e.type === 'pointermove' && !e.buttons) return; // a drag counts, a pointer that merely passes does not
        const n = e.target;
        if (n && n.closest && n.closest('[data-aigentron-ui]')) return; // the extension's own cards and frame: pressing Approve is not "using the page"
        window.__aigentronUserAt = Date.now();
      }, true);
    }
  }
  // `busy`: the extension waits and tries again by itself (a moment of the person's own click / typing); the agent only hears of it when the person keeps at it.
  // Not for an action the person has JUST approved (their click on the approval card is the reason for the recent activity, and the approval is their own
  // instruction to do exactly this), and a page watched for less than a moment is looked at first (a click made before the watch began would be unseen).
  if (!a.confirmed && (Date.now() - (window.__aigentronUserAt || 0) < 1500 || Date.now() - (window.__aigentronListenerAt || 0) < 600)) return { ok: false, busy: true, error: 'The person is using this tab right now — wait a few seconds, then take a new browser_snapshot.' };
  const clean = (s, k = 120) => String(s ?? '').replace(/\s+/g, ' ').trim().slice(0, k);
  const el = a.ref ? window.__aigentronRefs?.get(a.ref) : null;
  if (a.ref && (!el || !el.isConnected)) return { ok: false, error: `The element ${a.ref} is not on the page any more — take a new browser_snapshot and use the new reference.` };

  const SENSITIVE = /pass(word)?|cvv|cvc|card.?n(um|o)|cc-?(num|csc|exp)|iban|ssn|social.?sec|otp|one.?time|2fa|\bpin\b|secret/i;
  const sensitive = (e) => {
    const type = (e.getAttribute('type') || '').toLowerCase();
    const ac = (e.getAttribute('autocomplete') || '').toLowerCase();
    return type === 'password' || /^cc-|one-time-code|(current|new)-password/.test(ac) || SENSITIVE.test([e.name, e.id, e.getAttribute('aria-label'), e.getAttribute('placeholder')].join(' '));
  };
  const labelOf = (e) => {
    const l = e.id && document.querySelector(`label[for="${CSS.escape(e.id)}"]`);
    return clean(e.getAttribute('aria-label') || (l && l.textContent) || e.closest('label')?.textContent || e.getAttribute('placeholder') || e.name || e.id, 60);
  };
  const fieldsOf = (form) =>
    [...form.elements]
      .filter((e) => (e.name || e.id) && !['submit', 'button', 'hidden', 'reset', 'image'].includes((e.type || '').toLowerCase()))
      .slice(0, 20)
      .map((e) => ({ label: labelOf(e) || e.name || e.id, value: sensitive(e) ? '••••' : e.type === 'checkbox' || e.type === 'radio' ? (e.checked ? 'checked' : 'unchecked') : clean(e.value, 120) }));
  const COMMIT = /\b(submit|send|pay|buy|order|purchase|checkout|check out|confirm|delete|remove|sign ?(in|up|on)|log ?in|register|subscribe|unsubscribe|transfer|donate|publish|post|book|reserve|apply|place|authorize|approve|save|update|add to cart|add|invite|share|grant|allow|accept|agree|enable|disable|upgrade|continue|next|finish|done|complete|cancel|close account|deactivate|withdraw|bid|vote|like|follow|connect|reply|comment|tweet|retweet|upload|import|export|download|install|отправить|оплатить|купить|заказать|подтвердить|удалить|войти|зарегистрироваться|подписаться|перевести|опубликовать|оформить|сохранить|принять|согласен)\b/i;
  const isCommit = (e) => {
    const t = (e.getAttribute('type') || '').toLowerCase();
    const txt = clean(e.value || e.textContent || e.getAttribute('aria-label'));
    const submitLike = (e.localName === 'input' && (t === 'submit' || t === 'image')) || (e.localName === 'button' && (t === '' || t === 'submit') && !!e.closest('form'));
    return submitLike || COMMIT.test(txt);
  };
  // where a click would take the page: a link, or a form's action (checked by the caller against the site rules BEFORE anything is pressed)
  const goesTo = (e) => {
    try {
      const link = e.closest('a[href]');
      const form = e.closest('form');
      const submitting = form && isCommit(e);
      const dest = link && !submitting ? link.href : submitting ? form.action || location.href : '';
      if (!dest) return '';
      const u = new URL(dest, location.href);
      return /^https?:$/.test(u.protocol) && u.origin !== location.origin ? u.href : '';
    } catch {
      return '';
    }
  };
  const needsPerson = (e, label) => {
    const f = e.closest('form');
    return { ok: false, needsSubmit: { label: label || clean(e.value || e.textContent || e.getAttribute('aria-label')) || 'a button', host: location.hostname, action: f ? f.action : undefined, fields: f ? fieldsOf(f) : [] } };
  };
  const outline = (e) => {
    try {
      const old = e.style.outline;
      const oldOff = e.style.outlineOffset;
      e.style.outline = '3px solid #4e78ff';
      e.style.outlineOffset = '2px';
      setTimeout(() => { e.style.outline = old; e.style.outlineOffset = oldOff; }, 4000);
    } catch { /* not styleable */ }
  };
  const fire = (target, type, init = {}) => target.dispatchEvent(new KeyboardEvent(type, { bubbles: true, cancelable: true, ...init }));

  switch (a.kind) {
    case 'click': {
      if (!el) return { ok: false, error: 'Say which element: its [eN] reference from the snapshot.' };
      if (isCommit(el) && !a.confirmed) return needsPerson(el);
      const dest = goesTo(el);
      if (dest && !a.checked) return { ok: false, goesTo: dest };
      el.scrollIntoView({ block: 'center', inline: 'center' });
      outline(el);
      if (el.focus) el.focus({ preventScroll: true });
      el.click();
      return { ok: true };
    }
    case 'type': {
      if (!el) return { ok: false, error: 'Say which field: its [eN] reference from the snapshot.' };
      const editable = el.isContentEditable;
      if (!editable && !(el.localName === 'textarea' || (el.localName === 'input' && !['checkbox', 'radio', 'file', 'button', 'submit', 'image', 'range', 'color'].includes((el.getAttribute('type') || 'text').toLowerCase())))) return { ok: false, error: `${a.ref} is not a text field.` };
      if (sensitive(el)) return { ok: false, error: 'Not allowed: an agent never fills password, card or one-time-code fields — ask the person to type that part themselves.' };
      el.scrollIntoView({ block: 'center' });
      el.focus({ preventScroll: true });
      outline(el);
      const text = String(a.text ?? '');
      if (editable) {
        if (a.clear) el.textContent = '';
        window.__aigentronActing = true; // the trusted input events this makes are the agent's, not the person's
        try {
          document.execCommand('insertText', false, text);
        } finally {
          window.__aigentronActing = false;
        }
      } else {
        const proto = el.localName === 'textarea' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
        const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set;
        const next = a.clear ? text : String(el.value || '') + text;
        if (setter) setter.call(el, next);
        else el.value = next; // frameworks that track the value (React) see the native setter + the events
        el.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: text }));
        el.dispatchEvent(new Event('change', { bubbles: true }));
      }
      return { ok: true };
    }
    case 'select': {
      if (!el || el.localName !== 'select') return { ok: false, error: `${a.ref ?? 'The element'} is not a drop-down.` };
      const want = clean(a.value, 200).toLowerCase();
      const opt = [...el.options].find((o) => o.value.toLowerCase() === want || clean(o.text, 200).toLowerCase() === want) || [...el.options].find((o) => clean(o.text, 200).toLowerCase().includes(want));
      if (!opt) return { ok: false, error: `No option "${a.value}". Options: ${[...el.options].slice(0, 15).map((o) => clean(o.text, 40)).join(' | ')}` };
      el.value = opt.value;
      outline(el);
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
      return { ok: true };
    }
    case 'press': {
      const target = document.activeElement && document.activeElement !== document.body ? document.activeElement : document.body;
      const key = String(a.key || '');
      if (key === 'Enter') {
        const form = target.closest?.('form');
        const typing = target.localName === 'input' && !['button', 'submit', 'checkbox', 'radio'].includes((target.getAttribute('type') || 'text').toLowerCase());
        if (typing && form) {
          if (!a.confirmed) return needsPerson(target, 'Enter (submit the form)');
          const dest = form.action ? new URL(form.action, location.href) : null;
          if (dest && dest.origin !== location.origin && !a.checked) return { ok: false, goesTo: dest.href };
          form.requestSubmit();
          return { ok: true };
        }
        // Enter in a free text box (a chat, a comment, a search) usually SENDS it — never silently
        if ((typing || target.localName === 'textarea' || target.isContentEditable) && !a.confirmed) return needsPerson(target, 'Enter (send what was typed)');
        if (target !== document.body && isCommit(target) && !a.confirmed) return needsPerson(target);
        if (target !== document.body && (target.localName === 'button' || target.localName === 'a' || target.getAttribute('role') === 'button')) {
          target.click();
          return { ok: true };
        }
      }
      if (key === 'Tab') {
        const items = [...document.querySelectorAll('a[href],button,input:not([type=hidden]),select,textarea,[tabindex]:not([tabindex="-1"])')].filter((e) => !e.disabled && e.getBoundingClientRect().width > 0);
        const i = items.indexOf(document.activeElement);
        (items[(i + 1) % items.length] || document.body).focus();
        return { ok: true };
      }
      if (key === 'PageDown' || key === 'PageUp') {
        window.scrollBy({ top: (key === 'PageDown' ? 1 : -1) * Math.round(window.innerHeight * 0.8), behavior: 'instant' });
        return { ok: true };
      }
      fire(target, 'keydown', { key });
      fire(target, 'keyup', { key });
      return { ok: true };
    }
    case 'scroll': {
      if (el) el.scrollIntoView({ block: 'center' });
      else if (a.direction === 'top') window.scrollTo({ top: 0, behavior: 'instant' });
      else if (a.direction === 'bottom') window.scrollTo({ top: document.documentElement.scrollHeight, behavior: 'instant' });
      else window.scrollBy({ top: (a.direction === 'up' ? -1 : 1) * Math.round(window.innerHeight * 0.8), behavior: 'instant' });
      return { ok: true };
    }
    default:
      return { ok: false, error: `Unknown action ${a.kind}` };
  }
}
