import { Link } from 'react-router-dom';
import type { ReactNode } from 'react';
import styles from './BackLink.module.css';

/** A dimmed "← back" navigation link. */
export function BackLink({ href, children }: { href: string; children: ReactNode }) {
  return (
    <Link className={styles.back} to={href}>
      {children}
    </Link>
  );
}
