import type { ReactNode } from 'react';
import { cn } from '@/lib/cn';
import styles from './Table.module.css';

/** A plain data table: hairline rows, dimmed header, scrolls sideways on a narrow screen. Pass `<thead>` / `<tbody>` as children. */
export function Table({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <div data-ui="table" className={styles.wrap}>
      <table className={cn(styles.table, className)}>{children}</table>
    </div>
  );
}
