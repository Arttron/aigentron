# Sign-in from the dashboard (Codex, Claude)

Providers that use a **subscription** instead of an API key are signed in from **Settings → Providers → (edit the provider) → Sign in**.
The server runs the provider's own sign-in CLI; the browser only ever sees a link, a short code and the result — never a credential.

| Provider | Mode | What the person does | Where the credential goes |
|---|---|---|---|
| Codex (ChatGPT) | `codex-login` | Open the link, enter the one-time code (`codex login --device-auth`) | `secrets/codex/auth.json` (as before) |
| Claude (Pro/Max) | `oauth-token` | Open the link, sign in, paste the code the page shows (`claude setup-token`) | the provider's secret (a ~1-year token; shown only as `…abcd`) |

Other kinds (API key providers) have nothing to sign in to.

## How it works
- `apps/orchestrator/src/provider-login/` — one mechanism (`LoginSession`: output → link / code / paste box → store), one small driver per kind
  (`login-drivers.ts`), `login-core.ts` for the pure parsing. Adding a provider = one more driver.
- API (operator/admin): `GET /api/providers/:name/login` (status + current attempt), `POST …/login/start`, `POST …/login/code`
  `{code}`, `DELETE …/login` (cancel), `POST …/logout`.
- One attempt per provider at a time; it is cancelled after 10 minutes.
- **The earlier sign-in survives an unfinished attempt.** `codex login` wipes the existing `auth.json` when it starts; the orchestrator keeps a copy
  and puts it back if the attempt is cancelled, fails or times out.
- **Browser on another machine.** If the sign-in page ends on `http://localhost:<port>/callback?code=…` (it cannot open — the CLI listens on the
  server), paste that whole address into the box: the server makes the request itself (loopback only, `/…callback` paths, ports ≥ 1024).
- Claude runs on a pseudo-terminal (`script`) with a scratch config dir that is deleted afterwards; `ANTHROPIC_*` / `CLAUDE_CODE_OAUTH_TOKEN`
  are removed from its environment. The binary is `CLAUDE_BIN`, else the SDK's native `claude`, else `claude` on the PATH.
- The token is never returned by the API, never logged, and the admin agent does not see it (it only sees "signed in").

Using a subscription token outside interactive personal use of the vendor's tool is the operator's own call against the vendor's usage policy.
