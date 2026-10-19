import { useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import type { Project } from '@lds/shared';
import { useProjects } from '@/lib/use-projects';
import { ISOLATION_HELP, relativeTime, repoLine } from '@/lib/projects';
import { AppHeader, BackLink, Button, Card, ErrorText, Muted } from '@/components/ui';
import { NewProjectModal } from '@/components/projects/NewProjectModal';
import shared from '@/components/projects/projects.module.css';
import styles from './ProjectsPage.module.css';

function ProjectCard({ p }: { p: Project }) {
  const line = repoLine(p.repo.url);
  return (
    <Link to={`/projects/${encodeURIComponent(p.slug)}`} className={styles.card} data-archived={p.archivedAt ? '' : undefined}>
      <div className={styles.head}>
        <strong className={styles.name} dir="auto">
          {p.name}
        </strong>
        <span className={shared.chip}>{p.kind}</span>
      </div>
      <div className={styles.repo} title={p.repo.url ?? undefined}>
        {p.kind === 'docs' ? <Muted>No repository (docs)</Muted> : line ? line : <Muted>No repository — local folder</Muted>}
      </div>
      <div className={styles.chips}>
        {p.kind === 'code' && (
          <span className={shared.chip} title={ISOLATION_HELP[p.effectiveIsolation]}>
            {p.effectiveIsolation}
          </span>
        )}
        {p.isDefault && <span className={`${shared.chip} ${shared.chipAccent}`}>default</span>}
        {p.archivedAt && <span className={`${shared.chip} ${shared.chipAmber}`}>archived</span>}
      </div>
      <div className={styles.foot}>
        <span className={p.counts.active > 0 ? styles.live : undefined}>
          {p.counts.active} active · {p.counts.total} task{p.counts.total === 1 ? '' : 's'}
        </span>
        <span className={styles.when}>updated {relativeTime(p.updatedAt)}</span>
      </div>
    </Link>
  );
}

/** All projects as cards; a new one is made in a dialog. */
export function ProjectsPage() {
  const [archived, setArchived] = useState(false);
  const { projects, error, reload } = useProjects({ archived });
  const [creating, setCreating] = useState(false);
  const navigate = useNavigate();
  const defaultIsolation = projects?.find((p) => p.isDefault)?.effectiveIsolation ?? 'shared';

  return (
    <>
      <BackLink href="/">← all tasks</BackLink>
      <AppHeader
        title="📁 Projects"
        actions={
          <>
            <label className={styles.toggle}>
              <input type="checkbox" checked={archived} onChange={(e) => setArchived(e.target.checked)} /> Show archived
            </label>
            <Button variant="primary" onClick={() => setCreating(true)}>
              + New project
            </Button>
            <Link to="/settings">⚙ Settings</Link>
          </>
        }
      />
      {error && (
        <Card>
          <ErrorText>{error}</ErrorText>
        </Card>
      )}
      {!projects ? (
        <div className={styles.grid} aria-busy="true">
          <div className={`${styles.card} ${styles.ghost}`} />
        </div>
      ) : (
        <div className={styles.grid}>
          {projects.map((p) => (
            <ProjectCard key={p.id} p={p} />
          ))}
        </div>
      )}
      {projects && projects.length === 1 && (
        <Muted className={styles.hint}>Each project has its own repository, folder, checks and notifications. Tasks you start can go to any project.</Muted>
      )}
      {creating && projects && (
        <NewProjectModal
          existing={projects}
          defaultIsolation={defaultIsolation}
          onClose={() => setCreating(false)}
          onCreated={(p) => {
            setCreating(false);
            reload();
            navigate(`/projects/${encodeURIComponent(p.slug)}`);
          }}
        />
      )}
    </>
  );
}
