import type { TaskStatus } from '@lds/shared';
import { Badge } from '@/components/ui';

const LABELS: Record<TaskStatus, string> = {
  queued: 'queued',
  running: 'running',
  needs_approval: 'needs approval',
  done: 'done',
  failed: 'failed',
  cancelled: 'cancelled',
  blocked: 'blocked',
  stalled: 'stalled',
};

export function StatusBadge({ status }: { status: TaskStatus }) {
  return <Badge tone={status}>{LABELS[status] ?? status}</Badge>;
}
