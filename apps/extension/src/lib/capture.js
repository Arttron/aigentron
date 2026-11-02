/**
 * Runs INSIDE the page (chrome.scripting.executeScript({ func })): it is serialised, so it must not use anything from outside itself.
 * Returns what an agent can use: the title, the address, the selection and the readable text of the page (`article` / `main` when there is one).
 */
export function extractPageInPage() {
  const tidy = (s) => String(s || '').replace(/[ \t]+/g, ' ').replace(/ ?\n ?/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
  let selection = '';
  try {
    selection = String(window.getSelection?.() ?? '');
  } catch {
    /* no selection access */
  }
  let text = '';
  try {
    const main = document.querySelector('article') || document.querySelector('main') || document.querySelector('[role="main"]');
    text = (main && main.innerText) || '';
    // a "main" that holds only a fragment of the page: take the whole body instead
    if (text.length < 400 && document.body) text = document.body.innerText || text;
  } catch {
    /* a page that does not allow it */
  }
  return {
    title: document.title || '',
    url: location.href,
    selection: tidy(selection).slice(0, 20000),
    text: tidy(text).slice(0, 60000),
    lang: document.documentElement.lang || '',
  };
}
