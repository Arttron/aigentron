# Projects: repositories and access

A **project** is a row of settings plus a folder with a known layout (`docs/plan-projects-workspace.md`): its code repository,
the branch and the subdirectory agents work in, how to verify, who leads, where to notify. Every task belongs to a project; the
**default** project adopts the installation's original workspace (`WORKSPACE_REPO_PATH`), every other project lives under
`<PROJECTS_DIR>/<slug>/` with its checkout at `<PROJECTS_DIR>/<slug>/repo`.

This page is about one part of it: **the repository and how the server is allowed to reach it.** The owner's decisions behind
it: access is set up per project; the preferred way is SSH with a deploy key; tokens and keys live in **files in the secrets
directory**, not in the database; and the person can **test** the access before any task runs.

## What belongs to a project

Providers and MCP servers are global. **Resources and knowledge bases** are either global (visible to the tasks of every project — what
everything made before projects is) or belong to one project (visible only to its tasks): the project's own resource library is
`<project dir>/library/` (`docs/resources.md`), its bases carry `KnowledgeBase.projectId` (`docs/knowledge-base.md`). `GET /api/projects`
and `GET /api/projects/:slug` count them in `counts.resources` / `counts.knowledge` (own items only, next to `active` / `total` tasks).
`DELETE /api/projects/:slug` takes `{ knowledge: 'keep' | 'delete', resources: 'keep' | 'delete' }` (body or query; default keep: the
bases become global, the library's items move into the global library under a folder named after the project); it is still a 409 while
the project has active tasks, and the project's finished tasks move to the default project.

## Repository settings (per project)

`GET /api/projects/:slug/repo` (any signed-in role):

```json
{
  "url": "git@github.com:acme/shop.git", "branch": "main", "subdir": null,
  "provider": "github",            // github | gitlab | bitbucket | generic — from the host name
  "auth": "ssh",                   // none | token | ssh
  "tokenSet": false, "tokenHint": null,        // tokenHint = "…abcd" (last 4 characters) when a token is stored
  "sshPublicKey": "ssh-ed25519 AAAA… aigentron:shop@server",
  "sshFingerprint": "SHA256:…",
  "hostKeyTrusted": true,          // ssh URLs only: is the host's key pinned for this project (null for https)
  "lastTest": { "at": "2026-10-19T10:00:00Z", "ok": true, "summary": "ok (default branch main), write access confirmed", "durationMs": 1830 }
}
```

`PUT /api/projects/:slug/repo` `{ "url"?, "branch"?, "subdir"? }` (operator / admin) changes the repository. The URL may be
`https://host/owner/repo.git`, `ssh://git@host[:port]/owner/repo.git` or the scp-like `git@host:owner/repo.git`; a URL with a
password or token inside (`https://x:ghp_…@github.com/…`) is refused with a 400 — the secret goes into the access settings below.

The URL and the access method must fit: **token access needs an https URL, SSH access needs an ssh URL.** The test says so in
words when they do not.

## Access methods

`PUT /api/projects/:slug/repo/credentials` (operator / admin). The secret arrives in this request **once** and is never returned
by any endpoint; the response is the status above.

| body | what happens |
|---|---|
| `{ "auth": "none" }` | public repository or a local path. The stored token and key of the project are deleted. |
| `{ "auth": "token", "token": "ghp_…" }` | the token is written to `<secrets>/projects/<slug>/token`. Git sends it as an `Authorization: Basic` header set through `GIT_CONFIG_*` environment variables of the git process — never in the URL, never in a config file, never on the command line (the same scheme the workspace used before projects existed). |
| `{ "auth": "ssh", "action": "generate" }` | a fresh **ed25519** key pair is created on the server (no passphrase — ssh runs unattended) and stored as `id_ed25519` / `id_ed25519.pub`. The response carries the public key and its fingerprint for the person to register as a deploy key. Generating again **replaces** the key: the old deploy key stops working. |
| `{ "auth": "ssh", "action": "import", "privateKey": "-----BEGIN OPENSSH PRIVATE KEY-----…" }` | an existing key is validated (OpenSSH format of any type, or PEM ed25519 / RSA / ECDSA) and stored. A **passphrase-protected key is refused** with a message that says how to strip the passphrase (`ssh-keygen -p -N "" -f <key>`); so are public keys, PuTTY `.ppk` files and FIDO (`sk-`) keys. |

With SSH, git runs `ssh -i <project key> -o IdentitiesOnly=yes -o UserKnownHostsFile=<project known_hosts>
-o StrictHostKeyChecking=accept-new -o BatchMode=yes -o ConnectTimeout=15`: only this key is offered, the host's key is **pinned
on first use per project** (`known_hosts` in the project's secrets folder), and a host whose key later changes is an **error**,
not a prompt — the test explains it, and `DELETE /api/projects/:slug/repo/host-key` (operator / admin) forgets the pin after a
legitimate change (a self-hosted server reinstalled).

### Which to pick

- **SSH deploy key** (recommended): one key per project, tied to one repository, revocable in the repository's settings without
  touching any person's account; read-only unless you tick "write access". GitHub, GitLab and Bitbucket all support it.
- **Token** when the host has no deploy keys you can use, when agents also need the host's API (the GitHub MCP server, pull
  requests — only a token can open a PR), or when the repository is reached through an https-only proxy. Prefer a fine-grained /
  project-scoped token limited to this repository.
- **None** for public repositories and local paths.

## Adding the deploy key

Generate (or import) the key, copy `sshPublicKey` from the response or the status, then:

**GitHub** — the repository → *Settings* → *Deploy keys* → *Add deploy key*. Title: anything (the key's comment
`aigentron:<slug>@<server>` is a good one); Key: the whole line; tick **Allow write access** if agents should push branches.
GitHub refuses a key that is already registered on another repository — that is why each project has its own.
The repository URL for the project: `git@github.com:<owner>/<repo>.git`. Port 22 blocked? Use `ssh://git@ssh.github.com:443/<owner>/<repo>.git`.

**GitLab** — the project → *Settings* → *Repository* → expand *Deploy keys* → *Add new deploy key*. Tick **Grant write permissions
to this key** if agents should push. (A deploy key can also be enabled on several projects of the group from the same page.)
URL: `git@gitlab.com:<group>/<project>.git` (self-hosted: `git@<host>:…`, or `ssh://git@<host>:<port>/…` for a non-standard port).

**Bitbucket** — the repository → *Repository settings* → *Access keys* → *Add key*. Access keys are **read-only**; for pushes
register the key on a user account instead (*Personal settings* → *SSH keys*) or use an app password / repository access token
with `token` access over https. URL: `git@bitbucket.org:<workspace>/<repo>.git`.

**Self-hosted / other** — append the public key line to the git user's `~/.ssh/authorized_keys` on the server (Gitea, Forgejo,
Gogs and Azure DevOps have deploy-key pages like the ones above).

## The test

`POST /api/projects/:slug/repo/test` `{ "checkWrite"?: boolean }` (operator / admin) → 

```json
{
  "ok": false, "provider": "github", "defaultBranch": "main", "durationMs": 2140,
  "steps": [
    { "id": "url",     "label": "Repository URL",          "ok": true,  "detail": "ssh → github.com / acme/shop (github, access: ssh)" },
    { "id": "network", "label": "Network",                 "ok": true,  "detail": "github.com resolves (140.82.121.4)" },
    { "id": "auth",    "label": "Access (authentication)", "ok": false, "detail": "GitHub did not accept the SSH key",
      "hint": "Add the public key shown above as a deploy key: GitHub → the repository → Settings → Deploy keys → …" },
    { "id": "branch",  "label": "Branch",                  "ok": null,  "detail": "not checked" },
    { "id": "write",   "label": "Write access",            "ok": null,  "detail": "not checked" },
    { "id": "size",    "label": "Repository size",         "ok": null,  "detail": "not checked" }
  ]
}
```

`ok: true` passed, `false` failed (with a `hint` that says what to do), `null` not checked (skipped, or not applicable). The steps:

1. **url** — the URL parses and fits the access method; the credentials exist (a token file / a key).
2. **network** — the host name resolves (skipped for local paths).
3. **auth** — one `git ls-remote --symref` with the project's credentials: reachability, authentication and the branch list in
   one round trip. Failures are classified into: bad or expired token, key not accepted (not added to the repository, or
   added to another one), host key changed, repository not found (or not visible to these credentials), no network / DNS,
   timeout, TLS certificate not trusted. On the first SSH connection the host key is pinned here.
4. **branch** — the configured branch exists (the default branch and the first branches of the remote are named when it does not);
   an empty repository passes ("the first push creates it").
5. **write** — on GitHub with a token: the REST API's `permissions.push` for the repository (also yields the size). Otherwise only
   with `checkWrite: true`: a `git push --dry-run` of an empty commit to a throwaway ref from a scratch repository. **It contacts
   the remote's receive side but changes nothing** — the pack is never sent and no ref is created. A read-only deploy key or a
   read-only token is refused at that handshake ("reading works, but pushing is not allowed"). Server-side hooks do not run in a
   dry run, so a push refused by a hook is only seen by a real push.
6. **size** — the repository size when the GitHub API was asked; otherwise not checked.

Every step has a timeout (DNS 8 s, `ls-remote` 30 s, API 15 s, dry-run push 45 s, ssh connect 15 s). The result is stored as
`lastTest` (without any secret) and shown in the status; the log line says only pass/fail and the summary.

`POST /api/projects/:slug/repo/sync` (operator / admin) clones the repository into the project's checkout the first time and
fetches `origin/<branch>` afterwards, with the same credentials; response
`{ "action": "cloned" | "fetched" | "initialized" | "unchanged" | "skipped", "path", "branch", "head", "durationMs", "detail" }`
(`initialized` = no URL → a local repository with one empty commit; `skipped` = a docs project). The runtime uses the same
service (`RepoSyncService.ensure(project)`) before it starts a task, one sync per project at a time.

## What is stored where

| | where | mode |
|---|---|---|
| URL, branch, subdirectory, access method (`none` / `token` / `ssh`) | the `Project` row in the database | — |
| token | `<secrets>/projects/<slug>/token` (one line) | 0600 |
| SSH key | `<secrets>/projects/<slug>/id_ed25519` + `.pub` | 0600 |
| pinned host key(s) | `<secrets>/projects/<slug>/known_hosts` | 0600 |
| last test | `<secrets>/projects/<slug>/last-test.json` (no secrets) | 0600 |

The project folder under `<secrets>/projects/` is 0700; writes are atomic (a temp file, chmod, rename). `<secrets>` is
`SECRETS_DIR` (default `<data dir>/secrets`, next to `auth.json`), which `aigentron harden` closes to the agent user.

**The old `AppSettings.githubToken`** of the pre-projects workspace is migrated at the first start after the upgrade: the value is
written to the default project's `token` file, read back, then cleared from the database, and the default project's access
becomes `token` when it was `none`. The log says `GitHub token moved from the database to …/projects/default/token (…abcd)`.
A token written to the database again later (an old client of `PUT /api/settings`) is moved the same way at the next start.
Until a token file exists, the default project falls back to the database value, so nothing breaks in between.

## Security notes

- **Agents never hold the credentials.** Keys and tokens are read by the orchestrator only (root, or the service user) and are
  passed to *its* git processes as environment — `GIT_SSH_COMMAND` (a path to the key) and `GIT_CONFIG_*` (the header). Agents
  run as another OS user when agent isolation is on (`docs/authentication.md`), and the secrets directory is 0700, so the files
  are unreadable to them. The project checkout's `.git/config` is **not** given a credential by the sync; a push an agent makes
  itself goes through the orchestrator's publishing step, which authenticates with `GIT_CREDENTIALS` the same way. Agents that want a branch published call the tool `push_branch {branch, to?, reason}`: a person approves each push on a card, the orchestrator pushes (`refs/heads/<branch>:refs/heads/<to>`, never forced) with the project's key — a `git push` from an agent's shell cannot work, by design.
- **Nothing on the command line.** A token is never an argument of git (it would show in `ps` and `/proc/<pid>/cmdline`) and
  never part of the URL (it would land in `.git/config` and in error messages). Tests spawn a real git and check its argv and
  the process list.
- **Redaction.** Every git/ssh error that reaches a log, the API or the stored last test passes through the project's
  redactor, which removes the token and its base64 form. Private keys are never printed anywhere.
- **Trust on first use, per project.** The first SSH connection pins the host's key in the project's own `known_hosts`
  (`accept-new`); a later mismatch fails loudly ("the host key does not match the one pinned for this project") and must be
  reset on purpose. One project's pins never vouch for another's host.
- **Validation before storage.** Imported keys are parsed (format, type, no passphrase) before the file is written; the key
  files are read back and their fingerprint compared before the change is confirmed. Failed imports leave the previous key in
  place.
- **Roles.** Reading the status is open to every signed-in role; changing the repository or the credentials, the test, the
  sync and the host-key reset are for operators and admins (`identity/roles-coverage.test.ts` enforces the `@Roles` on every
  mutating route).
- **What a test can do to the remote:** read refs; with `checkWrite`, start a push handshake that sends no objects and creates
  no ref; on GitHub with a token, one GET of the repository's metadata.

## Where the code is

`apps/orchestrator/src/projects/git/`: `project-secrets.ts` (the files), `ssh-keys.ts` (key generation / import /
fingerprints / the ssh command), `git-access.service.ts` (the `GIT_CREDENTIALS` provider, status, credentials, the test, the
legacy migration), `repo-sync.service.ts` (clone / fetch), `repo-test-core.ts` (the failure table, `ls-remote` parsing),
`git-runner.ts` (git with timeouts and redaction), `project-repo.controller.ts` (the routes above), `git-access.module.ts`
(global; it provides `GIT_CREDENTIALS` — the runtime module must not declare its own provider under that token, a module's own
provider would shadow the global one).

## Agents pinned to a project
The project's settings have **Agents offered when creating a task here**: tick the agents that belong to this project and its *New task* list offers only those (the project's default lead and the server default stay selectable as “default”). Nothing ticked = every agent, exactly as before. It only narrows the list people see: agents, schedules and the admin can still start any agent, and a pinned agent that is deleted is ignored. Stored as `Project.pinnedAgents` (comma-separated, `PATCH /api/projects/:slug {pinnedAgents: [...]}`).

## Approvals per level

Whether an agent asks before a risky action is set at three levels, the most specific one that is set wins (in both directions): the **task** (its subtasks follow it; the 🛡 selector on the task page) → the **project** (project settings) → the **global** setting (Settings → General → Approvals, admin only). *Inherit* means "follow the level above". Credentials / protected files and the admin's platform proposals are asked at every level.
