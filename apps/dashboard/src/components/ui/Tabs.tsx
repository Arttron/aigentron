'use client';

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
  return (
    <div className={styles.tabs} role="tablist">
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
