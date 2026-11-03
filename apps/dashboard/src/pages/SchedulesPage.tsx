import { AppHeader, BackLink } from '@/components/ui';
import { SchedulesManager } from '@/components/SchedulesManager';

/** Schedules (main menu, after Tasks): reminders, recurring tasks and scripts. */
export function SchedulesPage() {
  return (
    <>
      <BackLink href="/">← all tasks</BackLink>
      <AppHeader title="⏰ Schedules" />
      <SchedulesManager />
    </>
  );
}
