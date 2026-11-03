const $ = (id) => document.getElementById(id);
const send = (msg) => chrome.runtime.sendMessage(msg);
const main = $('main');

function el(tag, props = {}, ...kids) {
  const e = Object.assign(document.createElement(tag), props);
  for (const k of kids) e.append(k);
  return e;
}

async function render() {
  const st = await send({ type: 'status' });
  $('server').textContent = st.serverName;
  main.replaceChildren();
  if (!st.connected) {
    main.append(
      el('p', { className: st.needsReconnect ? 'bad' : 'muted', textContent: st.needsReconnect ? 'The extension was signed out of the server.' : 'Not connected yet.' }),
      el('p', { className: 'muted', textContent: 'Open the Aigentron dashboard, signed in, and press Connect in the banner (or Add-ons → Extension).' }),
    );
    main.append(el('button', { className: 'primary', textContent: 'Open the dashboard', onclick: () => send({ type: 'open', path: '/addons?tab=extension' }).then(() => window.close()) }));
    return;
  }
  main.append(el('div', {}, el('strong', { textContent: st.user.displayName }), el('span', { className: 'muted', textContent: ` · ${st.user.role}` })));
  if (st.update) {
    main.append(el('div', { className: 'bell' }, el('strong', { textContent: `Update available: ${st.update.installed} → ${st.update.available}` }), el('button', { className: 'primary', textContent: 'Update the extension', onclick: () => chrome.tabs.create({ url: chrome.runtime.getURL('update.html') }).then(() => window.close()) })));
  }
  const compose = (kind) => async () => {
    const r = await send({ type: 'compose-start', kind });
    if (r?.ok) window.close();
    else main.prepend(el('p', { className: 'bad', textContent: r?.error ?? 'Could not capture this page' }));
  };
  main.append(
    el('p', { className: 'muted', textContent: 'Send what you are looking at to an agent' }),
    el('div', { className: 'row' },
      el('button', { className: 'primary', textContent: 'This page', onclick: compose('page') }),
      el('button', { textContent: 'Selection', onclick: compose('selection') }),
      el('button', { textContent: 'Screenshot', onclick: compose('screenshot') }),
    ),
  );
  // approvals and questions: where the cards show, the sound
  const ib = await send({ type: 'inbox-status' });
  const bell = el('div', { className: 'bell' });
  bell.append(el('div', {}, el('strong', { textContent: ib.count ? `${ib.count} waiting for you` : 'Nothing is waiting for you' })));
  if (ib.allPages) bell.append(el('p', { className: 'muted', textContent: 'Approval cards appear on the page you are on.' }));
  else {
    bell.append(
      el('p', { className: 'muted', textContent: 'Now approvals arrive as notifications. To see a card right on the page you are on, let the extension show it on any site. The browser words this as access to all your sites: for the cards the extension only draws them (it does not read pages). The same permission is what lets agents work in their own window — and only on the sites you approve for each task.' }),
      el('button', { textContent: 'Show cards on any page', onclick: async () => { await chrome.permissions.request({ origins: ['<all_urls>'] }); await render(); } }),
    );
  }
  const snd = el('input', { type: 'checkbox', checked: ib.prefs.sound });
  snd.addEventListener('change', async () => { await send({ type: 'prefs-set', prefs: { sound: snd.checked } }); });
  bell.append(el('label', { className: 'row' }, snd, document.createTextNode(' Play a sound for a new request (not while the dashboard is open) '), el('button', { textContent: 'Test', onclick: () => send({ type: 'sound-test' }) })));
  main.append(bell);
  // the browser the agents may use: their own window; a tab can be shared with them; Stop
  const ag = await send({ type: 'agent-status' });
  if (ag?.ok) {
    const shareBtn = el('button', { textContent: ag.thisShared ? 'Take this tab back from agents' : 'Let agents use this tab', onclick: async () => { const r = await send({ type: 'agent-share' }); if (r?.ok === false) return; await render(); } });
    main.append(
      el('div', { className: 'bell' },
        el('strong', { textContent: 'Agents in your browser' }),
        ...(ag.access ? [] : [
          el('p', { className: 'bad', textContent: 'Agents cannot open or read sites yet: Chrome has not given the extension access to websites.' }),
          el('button', { className: 'primary', textContent: 'Allow agents to use my browser', onclick: async () => { await chrome.permissions.request({ origins: ['<all_urls>'] }); await render(); } }),
          el('p', { className: 'muted', textContent: 'Chrome words it as «read and change all your data on all websites». Agents still work only in their own window, only on sites you approve for each task, ask you before every form is sent, never fill passwords or cards, and never touch banks, mail or this dashboard. «Stop agents» cuts them off at once.' }),
        ]),
        el('p', { className: 'muted', textContent: `${ag.windowOpen ? `Their window is open (${ag.tabs} tab${ag.tabs === 1 ? '' : 's'}).` : 'An agent can open its own window when a task needs the web (you are asked per site).'}${ag.shared ? ` ${ag.shared} of your tabs shared.` : ''}` }),
        el('div', { className: 'row' }, shareBtn, el('button', { textContent: ag.stopped ? 'Allow agents again' : 'Stop agents', onclick: async () => { await send({ type: ag.stopped ? 'agent-allow' : 'agent-stop' }); await render(); } })),
      ),
    );
  }
  const list = el('ul');
  main.append(el('p', { className: 'muted', textContent: 'Projects' }), list);
  const r = await send({ type: 'projects' });
  if (!r.projects) list.replaceWith(el('p', { className: 'bad', textContent: r.error ?? 'Could not load the projects' }));
  else for (const p of r.projects.filter((x) => !x.archivedAt)) list.append(el('li', {}, el('span', { textContent: p.name }), el('span', { className: 'muted', textContent: p.slug })));
  main.append(
    el('div', { className: 'row' },
      el('button', { textContent: 'Side panel', onclick: async () => { const w = await chrome.windows.getCurrent(); await chrome.sidePanel.open({ windowId: w.id }); window.close(); } }),
      el('button', { textContent: 'Open dashboard', onclick: () => send({ type: 'open' }).then(() => window.close()) }),
      el('button', { textContent: 'Disconnect', onclick: async () => { await send({ type: 'disconnect' }); await render(); } }),
    ),
    el('p', { className: 'muted', textContent: `Extension ${st.version} · server ${st.serverVersion ?? '?'}` }),
  );
}

render().catch((e) => main.replaceChildren(el('p', { className: 'bad', textContent: String(e.message ?? e) })));
