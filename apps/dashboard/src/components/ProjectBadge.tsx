import type { ProjectRef } from '@lds/shared';
import { Link } from 'react-router-dom';
import styles from './ProjectBadge.module.css';

/** A compact "📁 name" chip for a task outside the default project; nothing at all for the default one (so single-project setups look unchanged). */
export function ProjectBadge({ project, link = false }: { project?: ProjectRef | null; link?: boolean }) {
  if (!project || project.slug === 'default') return null;
  const body = (
    <>
      📁 <span className={styles.name}>{project.name}</span>
    </>
  );
  return link ? (
    <Link className={styles.badge} to={`/projects/${encodeURIComponent(project.slug)}`} title={`Project: ${project.name}`}>
      {body}
    </Link>
  ) : (
    <span className={styles.badge} title={`Project: ${project.name}`}>
      {body}
    </span>
  );
}
