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
| `command` | server | `{id, op, args}` — do something (L0 knows `status`) |
| `result` | daemon | `{id, ok, data?, error?}` — the answer to a command |
| `event` | daemon | `{name, data}` — something happened (L1+) |
