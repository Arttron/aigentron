# Local-agent protocol (v1)

JSON text frames over one WebSocket (`/api/local-agent/ws`, `Authorization: Bearer lag_…`). Every frame is an object with a `type`.
The files in this folder are the **contract**: the Go daemon (`apps/local-agent/internal/proto`) and the orchestrator (`apps/orchestrator/src/local-agent`) both
load them in their tests — change a frame here and both sides must follow.

| type | from | meaning |
|---|---|---|
| `hello` | daemon | first frame: protocol range, version, os, arch, host |
| `welcome` | server | accepted; `pingSec` = how often the daemon must send `ping` |
| `refuse` | server | not accepted (`code`: `proto_too_old` · `proto_too_new` · `revoked`), then the server closes |
| `ping` / `pong` | both | keep-alive; either side answers with the same `id` |
| `command` | server | `{id, op, args}` — do something; the ops are listed below |
| `result` | daemon | `{id, ok, data?, error?}` — the answer to a command |
| `event` | daemon | `{name, data}` — something happened; the events are listed below |

`hello` also carries `configRev` (the revision of the global rules the daemon holds; 0 = none). When it differs from the server's, the server sends `config.set`.

## Commands (`op`, from the server)

A repository is named by its `repo` id (from `repos.list` / `aigentron roots`); only repositories the person added on that computer are known. Unknown op → `result` with `ok:false`, `error: "unknown op …"`.

| op | args | result `data` |
|---|---|---|
| `status` | `{}` | `{version, os, arch, host, roots, configRev, llm}` |
| `config.set` | `{rev, rules}` (see `rules/`) | `{rev}` |
| `repos.list` | `{}` | `{repos: [status…]}` (same shape as the `repos` event) |
| `repo.status` | `{repo}` | one repository status |
| `repo.diff` | `{repo, path?, staged?}` | `{diff, truncated}` |
| `repo.log` | `{repo, limit?, path?}` | `{commits: [{hash, author, date, subject}]}` (at most 50) |
| `repo.read` | `{repo, path, offset?, limit?}` | `{path, text, offset, size, more}` (64 KB at a time; secrets and binary files refused) |
| `llm.models` | `{}` | `{models: [{backend, id}], problems, shared}` |
| `llm.chat` | `{id, backend, request}` | streamed as `llm.chunk` events carrying `id`; the result says how it ended |
| `llm.cancel` | `{id}` | `{ok:true}` |

## Events (`name`, from the daemon)

| name | data |
|---|---|
| `repos` | `{repos: [status…]}` — all allowed repositories, sent when something changes |
| `llm.chunk` | `{id, data}` — `id` is the `llm.chat` command's `args.id`, `data` one server-sent-event payload (a string) |

## HTTP next to the socket

`GET /api/local-agent/projects` (`Authorization: Bearer lag_…`) → `{projects: […]}`: the projects `aigentron open` can clone. Not a frame; the computer's own token is the credential.

## Fixtures

`command-<op>.json`, `result-<…>.json`, `event-<name>.json`: one frame per file. Both test suites decode and round-trip every `*.json` here; the Go daemon test checks it knows every command fixture's op, the server test checks every op it sends has a fixture. Add the fixture and the code on both sides together.
