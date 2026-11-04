import { Link } from 'react-router-dom';
import { Muted } from '@/components/ui';

/** A subtask held by `after`: says what it waits for (it starts by itself when those are done). */
export function WaitingOnNotice({ waitingOn }: { waitingOn?: { id: string; title: string; status: string }[] }) {
  if (!waitingOn?.length) return null;
  return (
    <Muted role="status">
      ⏳ Waits for {waitingOn.length > 1 ? 'these subtasks' : 'this subtask'} to finish, then starts by itself with {waitingOn.length > 1 ? 'their results' : 'its result'}:{' '}
      {waitingOn.map((w, i) => (
        <span key={w.id}>
          {i > 0 ? ', ' : ''}
          <Link to={`/tasks/${w.id}`}>«{w.title}»</Link> ({w.status})
        </span>
      ))}
    </Muted>
  );
}
