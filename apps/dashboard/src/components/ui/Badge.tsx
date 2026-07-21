import type { ReactNode } from 'react';
import { cn } from '@/lib/cn';
import styles from './Badge.module.css';

export type BadgeTone =
  | 'queued'
  | 'running'
  | 'needs_approval'
  | 'done'
  | 'failed'
  | 'cancelled'
  | 'blocked'
  | 'stalled'
  | 'neutral';

/** Pill-shaped status/label chip. */
export function Badge({ tone = 'neutral', children }: { tone?: BadgeTone; children: ReactNode }) {
  return <span className={cn(styles.badge, styles[tone])}>{children}</span>;
}
