// Runs only on the server's own pages (the manifest's matches are the addresses of this server). It is the bridge of the "Connect" handshake:
// the signed-in dashboard page asks for a one-use code and hands it over here; the service worker exchanges it for the extension's own token.
(() => {
  const SOURCE_OUT = 'aigentron-extension';
  const SOURCE_IN = 'aigentron-dashboard';
  const post = (msg) => window.postMessage({ source: SOURCE_OUT, ...msg }, window.location.origin);
  const ask = (msg) => chrome.runtime.sendMessage(msg).catch(() => null);

  async function announce() {
    const st = await ask({ type: 'status' });
    post({
      type: 'ready',
      version: chrome.runtime.getManifest().version,
      extensionId: chrome.runtime.id,
      connected: Boolean(st?.connected) && Boolean(st?.origin) && st.origins?.includes(window.location.origin),
      needsReconnect: Boolean(st?.needsReconnect),
      user: st?.user?.displayName ?? null,
    });
  }

  window.addEventListener('message', async (e) => {
    // only this page's own scripts, and only our two messages
    if (e.source !== window || e.origin !== window.location.origin) return;
    const d = e.data;
    if (!d || d.source !== SOURCE_IN) return;
    if (d.type === 'ping') {
      await announce();
    } else if (d.type === 'pair' && typeof d.code === 'string' && d.code.length < 100) {
      const apiOrigin = typeof d.apiOrigin === 'string' ? d.apiOrigin : window.location.origin;
      const r = await ask({ type: 'pair', code: d.code, apiOrigin, pageOrigin: window.location.origin });
      post({ type: 'paired', ok: Boolean(r?.ok), error: r?.error ?? null, user: r?.user?.displayName ?? null });
      await announce();
    } else if (d.type === 'disconnect') {
      await ask({ type: 'disconnect' });
      await announce();
    }
  });

  document.documentElement.dataset.aigentronExtension = chrome.runtime.getManifest().version;
  void announce();
})();
