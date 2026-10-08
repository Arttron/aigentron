import { useEffect, useRef } from 'react';
import { cn } from '@/lib/cn';
import styles from './Tabs.module.css';

export interface TabDef<Id extends string> {
  id: Id;
  label: string;
}

/** Controlled horizontal tab strip. */
export function Tabs<Id extends string>({
  tabs,
  active,
  onChange,
}: {
  tabs: ReadonlyArray<TabDef<Id>>;
  active: Id;
  onChange: (id: Id) => void;
}) {
  const strip = useRef<HTMLDivElement>(null);
  // Keep the active tab visible inside the strip (only the strip scrolls, never the page).
  useEffect(() => {
    const el = strip.current?.querySelector<HTMLElement>('[aria-selected="true"]');
    const box = strip.current;
    if (!el || !box) return;
    const left = el.offsetLeft - box.offsetLeft;
    if (left < box.scrollLeft) box.scrollLeft = left - 8;
    else if (left + el.offsetWidth > box.scrollLeft + box.clientWidth) box.scrollLeft = left + el.offsetWidth - box.clientWidth + 8;
  }, [active]);
  return (
    <div className={styles.tabs} role="tablist" ref={strip}>
      {tabs.map((t) => (
        <button
          key={t.id}
          role="tab"
          aria-selected={t.id === active}
          className={cn(styles.tab, t.id === active && styles.active)}
          onClick={() => onChange(t.id)}
        >
          {t.label}
        </button>
      ))}
    </div>
  );
}
