import { useEffect, useState } from 'react';

/**
 * A `<details>` used as a dropdown menu: while it is open, a press outside it, the Escape key, or a click on a button / link inside it closes it.
 * (A bare `<details>` stays open until its summary is pressed again, which on a phone covers the page.) Put the returned (callback) ref on the element: it may mount later than the page.
 */
export function useDetailsDismiss<T extends HTMLDetailsElement = HTMLDetailsElement>() {
  const [el, setEl] = useState<T | null>(null);
  useEffect(() => {
    if (!el) return;
    const close = () => {
      if (el.open) el.open = false;
    };
    const onPress = (e: Event) => {
      if (el.open && e.target instanceof Node && !el.contains(e.target)) close();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') close();
    };
    const onInside = (e: Event) => {
      const t = e.target instanceof Element ? e.target.closest('button, a[href]') : null;
      // the summary toggles the menu itself; a button / link in the body is an action: the menu has done its job
      if (t && !t.closest('summary') && el.contains(t)) close();
    };
    document.addEventListener('pointerdown', onPress, true);
    document.addEventListener('keydown', onKey);
    el.addEventListener('click', onInside);
    return () => {
      document.removeEventListener('pointerdown', onPress, true);
      document.removeEventListener('keydown', onKey);
      el.removeEventListener('click', onInside);
    };
  }, [el]);
  return setEl;
}
