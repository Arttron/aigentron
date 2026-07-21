---
name: heroku
description: Heroku deployment conventions — Procfile, release-phase migrations, config vars, dynos, logs, and rollback. Use when reasoning about how the app is built, released, and configured on Heroku. Deploys themselves are approval-gated.
---

# Skill: Heroku Deployment
**Applies to:** Backend, Architect

This is about *how the app is built, released, and configured on Heroku* — the shape you design
and code against. It is **not** a grant to deploy: `git push heroku`, `heroku run`, dyno scaling,
and config-var changes are outbound/destructive and go through the human approval gate. Design
and prepare the release; a human triggers it.

---

## Release model

Heroku builds a slug from the pushed branch, then runs the **release phase** before the new
dynos take traffic. Put migrations there so a deploy that can't migrate fails *before* going
live rather than half-migrated.

```
Procfile
────────
web: node dist/main.js
release: npm run migration:run        # runs once per release, before web dynos start
worker: node dist/worker.js           # only if the app has background work
```

- The `release` command must be **idempotent** and safe to re-run (a failed release retries).
- A failed `release` aborts the deploy and keeps the previous release serving — good. Never move
  migrations into app boot to "work around" a release failure; fix the migration.

## Config & environment

- All secrets and environment differences are **config vars** (`heroku config`), never committed
  files. The app reads `process.env`; there is no `.env` in the slug.
- `DATABASE_URL` is injected by the Heroku Postgres add-on — read it, don't hardcode. Enable TLS
  (`ssl: { rejectUnauthorized: false }` for Heroku PG) in the TypeORM/data-source config.
- `PORT` is assigned by Heroku — bind to `process.env.PORT`, not a fixed port.

## Commands (reference — the mutating ones are approval-gated)

```bash
heroku logs --tail -a <app>              # read logs (diagnostics)
heroku releases -a <app>                 # release history
heroku config -a <app>                   # list config vars (values are secrets)
heroku pg:info -a <app>                  # database status

# ↓ these mutate a live environment → human approval required
git push heroku main                     # deploy
heroku rollback v123 -a <app>            # revert to a previous release
heroku config:set KEY=value -a <app>     # change config
heroku ps:scale web=2 -a <app>           # scale dynos
heroku run "npm run <task>" -a <app>     # one-off dyno
```

## Rules

- **Migrations run in the release phase**, are idempotent, and are reversible where possible. A
  migration that can't be rolled back is a design decision to flag, not a default.
- **Never** put secrets in the repo or the slug; they are config vars.
- **Rollback is the recovery path.** If a release breaks production, the fix is
  `heroku rollback` to the last good release (approval-gated), then diagnose from `heroku logs` —
  not a hurried hotfix pushed straight to `main`.
- When you prepare a deploy, state in your status report exactly what a human must trigger
  (`push`, any `config:set`, migrations) and why — the approval flow handles the rest.
