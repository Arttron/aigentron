import { useCallback, useEffect, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import type { Project } from '@lds/shared';
import { api } from '@/lib/api';
import { ISOLATION_HELP, apiMessage, relativeTime, repoLine } from '@/lib/projects';
import { AppHeader, BackLink, Card, ErrorText, Muted, SectionTitle } from '@/components/ui';
import { RepositoryCard } from '@/components/projects/RepositoryCard';
import { ProjectSettingsCard } from '@/components/projects/ProjectSettingsCard';
import shared from '@/components/projects/projects.module.css';
import styles from './ProjectPage.module.css';

/** One project: overview, repository (address, access, test, sync) and settings. */
export function ProjectPage() {
  const { slug = '' } = useParams();
  const navigate = useNavigate();
  const [project, setProject] = useState<Project | null>(null);
  const [defaultIsolation, setDefaultIsolation] = useState<'shared' | 'worktree'>('shared');
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(() => {
    api
      .getProject(slug)
      .then((p) => {
        setProject(p);
        setError(null);
      })
      .catch((e) => setError(apiMessage(e)));
  }, [slug]);
  useEffect(() => {
    setProject(null);
    load();
    api
      .listProjects()
      .then((l) => setDefaultIsolation(l.find((p) => p.isDefault)?.effectiveIsolation ?? 'shared'))
      .catch(() => undefined);
  }, [load]);

  return (
    <>
      <BackLink href="/projects">← all projects</BackLink>
      <AppHeader
        clampTitle
        title={project ? <span dir="auto">📁 {project.name}</span> : '📁 Project'}
        actions={
          <>
            {project && <span className={shared.chip}>{project.kind}</span>}
            {project?.archivedAt && <span className={`${shared.chip} ${shared.chipAmber}`}>archived</span>}
            <Link to="/settings">⚙ Settings</Link>
          </>
        }
      />
      {error && (
        <Card>
          <ErrorText>{error}</ErrorText>
        </Card>
      )}
      {!project ? (
        !error && (
          <Card>
            <div className={shared.skeleton}>
              <Muted>Loading…</Muted>
            </div>
          </Card>
        )
      ) : (
        <>
          <Card>
            <SectionTitle>Overview</SectionTitle>
            <dl className={styles.facts}>
              <dt>Folder (slug)</dt>
              <dd className={shared.mono}>{project.slug}</dd>
              <dt>Tasks</dt>
              <dd>
                {project.counts.active} active · {project.counts.total} in total
                {project.counts.total > 0 && (
                  <>
                    {' · '}
                    <Link to={`/?project=${encodeURIComponent(project.slug)}`}>show them →</Link>
                  </>
                )}
              </dd>
              {project.kind === 'code' && (
                <>
                  <dt>Mode</dt>
                  <dd>
                    {project.effectiveIsolation}
                    {project.isolation ? '' : ' (server default)'}
                    <Muted className={shared.note} style={{ margin: '2px 0 0' }}>
                      {ISOLATION_HELP[project.effectiveIsolation]}
                    </Muted>
                  </dd>
                  <dt>Repository</dt>
                  <dd>{repoLine(project.repo.url) || <Muted>none — a local folder</Muted>}</dd>
                </>
              )}
              <dt>Created</dt>
              <dd>
                {new Date(project.createdAt).toLocaleDateString()} · updated {relativeTime(project.updatedAt)}
              </dd>
            </dl>
          </Card>
          <RepositoryCard key={project.slug} project={project} onChanged={load} />
          <ProjectSettingsCard key={project.slug} project={project} defaultIsolation={defaultIsolation} onSaved={setProject} onDeleted={() => navigate('/projects')} />
        </>
      )}
    </>
  );
}
