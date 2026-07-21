import { cn } from '@/lib/cn';
import styles from './ConnStatus.module.css';

/** Live/disconnected indicator dot driven by the socket connection state. */
export function ConnStatus({ connected }: { connected: boolean }) {
  return (
    <span className={styles.conn}>
      <span className={cn(styles.dot, connected && styles.on)} />
      {connected ? 'live' : 'disconnected'}
    </span>
  );
}
