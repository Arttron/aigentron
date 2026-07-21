'use client';

import { cn } from '@/lib/cn';
import { Muted } from './Text';
import styles from './CheckboxGroup.module.css';

/** Multi-select rendered as a wrap of checkable chips. */
export function CheckboxGroup({
  options,
  selected,
  onChange,
  empty = 'none available',
}: {
  options: string[];
  selected: string[];
  onChange: (next: string[]) => void;
  empty?: string;
}) {
  if (options.length === 0) {
    return <Muted className={styles.empty}>{empty}</Muted>;
  }
  const toggle = (name: string) =>
    onChange(selected.includes(name) ? selected.filter((s) => s !== name) : [...selected, name]);

  return (
    <div className={styles.group}>
      {options.map((name) => {
        const on = selected.includes(name);
        return (
          <label key={name} className={cn(styles.chip, on && styles.on)}>
            <input
              type="checkbox"
              className={styles.box}
              checked={on}
              onChange={() => toggle(name)}
            />
            {name}
          </label>
        );
      })}
    </div>
  );
}
