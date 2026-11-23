import type { HTMLAttributes } from 'react';
import { cn } from '@/lib/cn';
import styles from './Text.module.css';

/** Dimmed secondary text. `block` puts it on its own line (a note under a heading) instead of running on from the previous inline element. */
export function Muted({ className, block, ...rest }: HTMLAttributes<HTMLSpanElement> & { block?: boolean }) {
  return <span data-ui="text" className={cn(styles.muted, block && styles.block, className)} {...rest} />;
}

/** Inline error text. */
export function ErrorText({ className, ...rest }: HTMLAttributes<HTMLSpanElement>) {
  return <span data-ui="text" role="alert" className={cn(styles.error, className)} {...rest} />;
}
