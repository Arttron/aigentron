import type { Project } from '@lds/shared';
import { SCOPE_ALL, SCOPE_GLOBAL, scopeLabel, scopeValue } from '@/lib/scope';
import type { ScopeState } from '@/lib/use-scope';
import styles from './ScopeBar.module.css';

/** Chips All · Global · one per project; renders nothing with a single project (and a same-height blank while the projects load, if there were several). */
export function ScopeBar({ state }: { state: ScopeState }) {
  const { multi, reserve, projects, scope, setScope } = state;
  if (!multi) return reserve ? <div className={styles.bar} aria-hidden /> : null;
  const chip = (value: string, label: string) => (
    <button key={value} type="button" aria-pressed={scope === value} className={scope === value ? styles.on : styles.chip} onClick={() => setScope(value)} title={label}>
      <span className={styles.label}>{label}</span>
    </button>
  );
  return (
    <div className={styles.bar} role="group" aria-label="Filter by scope">
      {chip(SCOPE_ALL, 'All')}
      {chip(SCOPE_GLOBAL, 'Global')}
      {projects.map((p) => chip(p.slug, p.name))}
    </div>
  );
}

/** A compact "global" (muted) / project-name badge; nothing when there is only one project. */
export function ScopeBadge({ project, state }: { project: string | null | undefined; state: Pick<ScopeState, 'multi' | 'projects'> }) {
  if (!state.multi) return null;
  const label = scopeLabel(project, state.projects);
  return (
    <span className={project ? styles.badgeProject : styles.badgeGlobal} title={project ? `Project: ${label}` : 'Global: every project'}>
      {project ? '📁 ' : ''}
      <span className={styles.label}>{label}</span>
    </span>
  );
}

/** The "Add to" select shown next to the create/upload buttons while the scope is All. */
export function AddToSelect({ state, value, onChange }: { state: ScopeState; value: string; onChange: (v: string) => void }) {
  if (!state.multi || state.scope !== SCOPE_ALL) return null;
  return (
    <label className={styles.addTo}>
      <span>Add to:</span>
      <select aria-label="Add to" value={value} onChange={(e) => onChange(e.target.value)}>
        <option value="">Global</option>
        {state.projects.map((p: Project) => (
          <option key={p.slug} value={p.slug}>
            {p.name}
          </option>
        ))}
      </select>
    </label>
  );
}

/** The "Scope" field of an item's dialog: global or a project, with who sees it. */
export function ScopeField({ state, value, onChange, help }: { state: Pick<ScopeState, 'multi' | 'projects'>; value: string | null; onChange: (v: string | null) => void; help: string }) {
  if (!state.multi) return null;
  return (
    <div className={styles.field}>
      <label>
        <span className={styles.fieldLabel}>Scope</span>
        <select aria-label="Scope" value={scopeValue(value)} onChange={(e) => onChange(e.target.value || null)}>
          <option value="">Global</option>
          {state.projects.map((p: Project) => (
            <option key={p.slug} value={p.slug}>
              {p.name}
            </option>
          ))}
        </select>
      </label>
      <div className={styles.help}>{help}</div>
    </div>
  );
}
