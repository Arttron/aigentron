import type { CSSProperties, ReactNode } from 'react';
import { cn } from '@/lib/cn';
import styles from './Row.module.css';

/** Horizontal flex row with a consistent gap; the common layout building block. */
export function Row({
  children,
  className,
  wrap = false,
  spaceBetween = false,
  style,
}: {
  children: ReactNode;
  className?: string;
  wrap?: boolean;
  spaceBetween?: boolean;
  style?: CSSProperties;
}) {
  return (
    <div
      className={cn(styles.row, wrap && styles.wrap, spaceBetween && styles.spaceBetween, className)}
      style={style}
    >
      {children}
    </div>
  );
}
