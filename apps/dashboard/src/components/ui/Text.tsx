import type { HTMLAttributes } from 'react';
import { cn } from '@/lib/cn';
import styles from './Text.module.css';

/** Dimmed secondary text. */
export function Muted({ className, ...rest }: HTMLAttributes<HTMLSpanElement>) {
  return <span className={cn(styles.muted, className)} {...rest} />;
}

/** Inline error text. */
export function ErrorText({ className, ...rest }: HTMLAttributes<HTMLSpanElement>) {
  return <span className={cn(styles.error, className)} {...rest} />;
}
