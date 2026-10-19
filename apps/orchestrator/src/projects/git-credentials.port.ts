/**
 * The seam between "where git runs" (worktrees/*, the executor's push/fetch/clone) and "how a project authenticates" (projects/git/*).
 * Callers ask for the auth of a project; they never read tokens or keys themselves and never put a secret into a URL or a config file.
 */
export interface GitAuth {
  /** extra environment for every git/ssh process of this project (GIT_SSH_COMMAND, GIT_TERMINAL_PROMPT=0 …) */
  env: Record<string, string>;
  /** extra leading arguments for git, e.g. ['-c', 'http.extraHeader=Authorization: …'] */
  args: string[];
  /** removes this project's secrets from text before it is logged or shown */
  redact(text: string): string;
  /** true when the project has no credentials (public repository or a local one) */
  anonymous: boolean;
}

export interface ProjectGitRef {
  slug: string;
  repoUrl: string | null;
  repoAuth: string; // 'none' | 'token' | 'ssh'
}

export interface GitCredentialsProvider {
  authFor(project: ProjectGitRef): Promise<GitAuth>;
  /**
   * The project's HTTPS token for API-style use (the shared `github` MCP server gets it as GITHUB_TOKEN for a run of THIS project's task),
   * or null when the project has none (public / ssh). Providers and MCP servers are shared by all projects; only this per-run credential
   * differs. Never log it.
   */
  apiTokenFor?(project: ProjectGitRef): Promise<string | null>;
}

/** Nest injection token of the provider. */
export const GIT_CREDENTIALS = Symbol('GIT_CREDENTIALS');
