import { useCallback, useEffect, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import type { Project } from '@lds/shared';
import { useProjects } from './use-projects';
import { SCOPE_PARAM, hasScopes, initialScope, readMultiPref, readScopePref, writeMultiPref, writeScopePref } from './scope';

export interface ScopeState {
  projects: Project[];
  /** More than one project: the bar, the badges and the scope selects are shown. */
  multi: boolean;
  /** Projects not answered yet, but the last time there were several: the bar reserves its height. */
  reserve: boolean;
  scope: string;
  setScope: (s: string) => void;
}

/** The scope of a library page: from `?project=`, else remembered per page; `all` otherwise. Pages look as before with one project. */
export function useScope(page: string): ScopeState {
  const { projects } = useProjects();
  const [params, setParams] = useSearchParams();
  const [scope, setScopeState] = useState(() => readScopePref(page) ?? 'all');
  const list = projects ?? [];
  const multi = hasScopes(projects);

  useEffect(() => {
    if (projects) writeMultiPref(hasScopes(projects));
  }, [projects]);

  // a link with ?project=… (also while already on the page) and the first answer of the project list
  const fromUrl = params.get(SCOPE_PARAM);
  useEffect(() => {
    if (!projects) return;
    setScopeState((cur) => initialScope(fromUrl ? `?${SCOPE_PARAM}=${encodeURIComponent(fromUrl)}` : '', cur, projects));
  }, [projects, fromUrl]);

  const setScope = useCallback(
    (s: string) => {
      setScopeState(s);
      writeScopePref(page, s);
      if (params.has(SCOPE_PARAM)) {
        const next = new URLSearchParams(params);
        next.delete(SCOPE_PARAM);
        setParams(next, { replace: true });
      }
    },
    [page, params, setParams],
  );

  // with a single project everything is shown, whatever was remembered
  return { projects: list, multi, reserve: projects === null && readMultiPref(), scope: multi ? scope : 'all', setScope };
}
