// Injected into the page the person is on (on demand, by the service worker): draws the approval / question cards.
// A closed shadow root in the top layer, so the page's CSS and scripts cannot restyle, read or click it; a button reacts only to a TRUSTED click
// (a page script cannot synthesise one) and only ~0.4 s after a card appears (a page that moves under the cursor cannot catch a click).
(() => {
  if (window.__aigentronOverlay) return;
  window.__aigentronOverlay = true;

  const ARM_MS = 400;
  let cards = [];
  let index = 0;
  let armedAt = 0;
  const picked = new Set();

  const host = document.createElement('div');
  host.style.cssText = 'all: initial; position: fixed; z-index: 2147483647;';
  const root = host.attachShadow({ mode: 'closed' });
  const style = document.createElement('style');
  style.textContent = `
    :host { all: initial; }
    .box { position: fixed; right: 16px; bottom: 16px; left: auto; top: auto; margin: 0; width: min(380px, calc(100vw - 32px)); max-height: 80vh; overflow: auto; padding: 14px;
      border: 1px solid #c9ced6; border-radius: 12px; background: #fff; color: #1b1f24; box-shadow: 0 10px 36px rgba(0,0,0,.28); font: 13px/1.45 system-ui, sans-serif; }
    @media (prefers-color-scheme: dark) { .box { background: #1b1f24; color: #e6e8eb; border-color: #3a4048; } .muted { color: #9aa3ad !important; } pre { background: #14171a !important; } button { border-color: #3a4048 !important; } }
    .head { display: flex; align-items: center; gap: 8px; margin-bottom: 6px; }
    .head strong { font-size: 13px; }
    .muted { color: #6b7280; font-size: 12px; }
    .where { margin-bottom: 6px; }
    pre { margin: 6px 0; padding: 8px; max-height: 130px; overflow: auto; white-space: pre-wrap; word-break: break-word; background: #f3f4f6; border-radius: 8px; font: 12px/1.4 ui-monospace, monospace; }
    .row { display: flex; flex-wrap: wrap; gap: 8px; margin-top: 8px; align-items: center; }
    button { font: inherit; padding: 7px 12px; border-radius: 8px; border: 1px solid #c9ced6; background: transparent; color: inherit; cursor: pointer; }
    button.primary { background: #4e78ff; border-color: #4e78ff; color: #fff; }
    button.danger { color: #d33; }
    button:disabled { opacity: .45; cursor: default; }
    button.link { border: 0; padding: 2px 4px; text-decoration: underline; font-size: 12px; }
    input[type=text] { font: inherit; padding: 6px 8px; border: 1px solid #c9ced6; border-radius: 8px; flex: 1; min-width: 120px; background: transparent; color: inherit; }
    .err { color: #d33; margin-top: 6px; }
    .spacer { flex: 1; }
  `;
  const box = document.createElement('div');
  box.className = 'box';
  box.setAttribute('popover', 'manual');
  root.append(style, box);

  const el = (tag, props = {}, ...kids) => {
    const e = Object.assign(document.createElement(tag), props);
    for (const k of kids) e.append(k);
    return e;
  };
  const send = (msg) => chrome.runtime.sendMessage(msg).catch(() => null);
  /** A click counts only if a person made it, after the card has been on screen for a moment. */
  const trusted = (fn) => (e) => {
    if (!e.isTrusted || Date.now() - armedAt < ARM_MS) return;
    fn(e);
  };

  function showError(text) {
    box.querySelector('.err')?.remove();
    box.append(el('div', { className: 'err', textContent: text }));
  }

  async function decide(card, decision, btns) {
    btns.forEach((b) => (b.disabled = true));
    const r = await send({ type: 'decide', id: card.id, decision });
    if (r && r.ok === false && r.status !== 409) {
      btns.forEach((b) => (b.disabled = false));
      showError(r.status === 403 ? 'This request has to be decided in the dashboard.' : (r.error ?? 'Could not send the answer'));
    }
  }

  async function answer(card, body, btns) {
    btns.forEach((b) => (b.disabled = true));
    const r = await send({ type: 'answer', id: card.id, body });
    if (r && r.ok === false && r.status !== 409) {
      btns.forEach((b) => (b.disabled = false));
      showError(r.error ?? 'Could not send the answer');
    }
  }

  function render() {
    box.replaceChildren();
    if (!cards.length) {
      try { box.hidePopover?.(); } catch { /* already hidden */ }
      return;
    }
    index = Math.min(index, cards.length - 1);
    const card = cards[index];
    armedAt = Date.now();
    picked.clear();

    const head = el('div', { className: 'head' }, el('strong', { textContent: card.title }));
    if (cards.length > 1) {
      head.append(
        el('span', { className: 'spacer' }),
        el('button', { className: 'link', textContent: '‹', title: 'Previous', onclick: () => { index = (index + cards.length - 1) % cards.length; render(); } }),
        el('span', { className: 'muted', textContent: `${index + 1} of ${cards.length}` }),
        el('button', { className: 'link', textContent: '›', title: 'Next', onclick: () => { index = (index + 1) % cards.length; render(); } }),
      );
    }
    box.append(head);
    if (card.where) box.append(el('div', { className: 'muted where', textContent: card.where }));

    if (card.kind === 'approval') {
      if (card.tool) box.append(el('div', { className: 'muted', textContent: card.tool }));
      if (card.summary) box.append(el('pre', { textContent: card.summary }));
      if (card.reason) box.append(el('div', { className: 'muted', textContent: card.reason }));
      const row = el('div', { className: 'row' });
      if (card.needsDashboard) {
        box.append(el('div', { className: 'muted', textContent: 'This one needs a careful look — it has to be decided in the dashboard.' }));
        row.append(el('button', { className: 'primary', textContent: 'Open in the dashboard', onclick: trusted(() => send({ type: 'open', path: `/tasks/${card.taskId}` })) }));
      } else {
        const approve = el('button', { className: 'primary', textContent: 'Approve' });
        const deny = el('button', { className: 'danger', textContent: 'Deny' });
        approve.onclick = trusted(() => decide(card, 'approve', [approve, deny]));
        deny.onclick = trusted(() => decide(card, 'deny', [approve, deny]));
        row.append(approve, deny, el('button', { className: 'link', textContent: 'Details', onclick: trusted(() => send({ type: 'open', path: `/tasks/${card.taskId}` })) }));
      }
      row.append(el('span', { className: 'spacer' }), el('button', { className: 'link', textContent: 'Hide for 2 min', onclick: () => send({ type: 'overlay-snooze' }) }));
      box.append(row);
    } else {
      box.append(el('div', { textContent: card.text }));
      const row = el('div', { className: 'row' });
      const btns = [];
      card.options.forEach((label, i) => {
        const b = el('button', { textContent: label });
        b.onclick = trusted(() => {
          if (card.multiple) {
            picked.has(i) ? picked.delete(i) : picked.add(i);
            b.style.background = picked.has(i) ? '#4e78ff' : '';
            b.style.color = picked.has(i) ? '#fff' : '';
          } else answer(card, { index: i }, btns);
        });
        btns.push(b);
        row.append(b);
      });
      box.append(row);
      if (card.multiple && card.options.length) {
        const ok = el('button', { className: 'primary', textContent: 'Send the chosen' });
        ok.onclick = trusted(() => picked.size && answer(card, { indexes: [...picked].sort((a, b) => a - b) }, btns));
        btns.push(ok);
        box.append(el('div', { className: 'row' }, ok));
      }
      if (card.allowText) {
        const input = el('input', { type: 'text', placeholder: 'Or type your answer' });
        const go = el('button', { textContent: 'Send' });
        go.onclick = trusted(() => input.value.trim() && answer(card, { text: input.value.trim() }, [...btns, go]));
        btns.push(go);
        box.append(el('div', { className: 'row' }, input, go));
      }
      box.append(el('div', { className: 'row' }, el('button', { className: 'link', textContent: 'Open the task', onclick: trusted(() => send({ type: 'open', path: `/tasks/${card.taskId}` })) }), el('span', { className: 'spacer' }), el('button', { className: 'link', textContent: 'Hide for 2 min', onclick: () => send({ type: 'overlay-snooze' }) })));
    }
    if (!host.isConnected) document.documentElement.append(host);
    try { box.showPopover?.(); } catch { /* already shown */ }
  }

  chrome.runtime.onMessage.addListener((msg, sender, respond) => {
    if (sender.id !== chrome.runtime.id) return false;
    if (msg?.type === 'overlay-render') {
      const was = cards.map((c) => c.id).join();
      cards = Array.isArray(msg.cards) ? msg.cards : [];
      if (cards.map((c) => c.id).join() !== was || !box.childNodes.length) render();
      respond({ ok: true });
    } else if (msg?.type === 'overlay-hide') {
      cards = [];
      render();
      host.remove();
      respond({ ok: true });
    } else if (msg?.type === 'overlay-ping') respond({ ok: true });
    return false;
  });
})();
