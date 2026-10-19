import { useCallback, useEffect, useState } from 'react';
import type { Project } from '@lds/shared';
import { api } from './api';

/** The projects (archived ones too when asked); `reload` after a change. `null` until the first answer. */
export function useProjects(opts: { archived?: boolean } = {}): { projects: Project[] | null; error: string | null; reload: () => void } {
  const [projects, setProjects] = useState<Project[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const archived = !!opts.archived;
  const reload = useCallback(() => {
    api
      .listProjects({ archived })
      .then((p) => {
        setProjects(p);
        setError(null);
      })
      .catch((e: Error) => setError(e.message));
  }, [archived]);
  useEffect(reload, [reload]);
  return { projects, error, reload };
}
