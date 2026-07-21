import type { ReactNode } from 'react';
import styles from './Field.module.css';

/** A labelled form field: a dimmed caption above its control. */
export function Field({ label, children }: { label: ReactNode; children: ReactNode }) {
  return (
    <label className={styles.field}>
      <span className={styles.label}>{label}</span>
      {children}
    </label>
  );
}
