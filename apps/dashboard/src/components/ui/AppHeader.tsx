import type { ReactNode } from 'react';
import { cn } from '@/lib/cn';
import styles from './AppHeader.module.css';

/** The page masthead: a title on the left, actions/nav on the right. */
export function AppHeader({
  title,
  actions,
  clampTitle = false,
}: {
  title: ReactNode;
  actions?: ReactNode;
  clampTitle?: boolean;
}) {
  return (
    <header className={styles.top}>
      <h1 className={cn(styles.title, clampTitle && styles.clamp)}>{title}</h1>
      {actions && <div className={styles.actions}>{actions}</div>}
    </header>
  );
}
