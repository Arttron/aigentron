# Command pipeline

Heavy shell commands — installs, builds, test runs, type checks — of **every task** go through one server-side queue instead of running beside each other.

- **What is heavy.** Decided by the text of the command (`packages/shared/src/heavy-command.ts`): `npm/pnpm/yarn install|build|test|run build…`, `tsc`, `vitest`, `jest`, `pytest`, `cargo build|test`, `go build|test`, `make`, `docker build`, `pip install`… Three classes: `heavy`, `light` (git, ls, small scripts), `long-running` (a dev server, `--watch`: it cannot be waited for, so it stays an ordinary background command).
- **How an agent uses it.** The agent has an MCP server `commands` with one tool, `run_command` (added automatically to every working agent, not to chat/question runs). The PreToolUse hook refuses a heavy `Bash` command with a message that points at `run_command`; light commands run as before.
- **What the server does.** The dangerous-command check is the same as for Bash (`ApprovalsService.check`, a card for the person when needed) → the command waits in a FIFO queue (`CommandQueue`) → at most `heavySlots` run at once (automatic: 1 on a small machine) → each starts only when the load, free memory and CPU steal are inside the limits (the same gate that holds task starts) → it runs in the task's folder, as the agent's own OS user, with the agent's environment (no secrets, a Node heap cap, `CI=1`), a time limit (default 15 min, max 1 h) that kills the whole process group → the end of the output is returned, filtered like the rest of the agent's text.
- **Visible.** While a command waits the task page says why ("a heavy command waits for its turn (1 ahead)"). A stopped task stops its commands.
- **Settings.** Settings → Task queue → *Command pipeline* (switch, number at once; automatic by default). The admin may change `commandPipeline` / `heavySlots`.
- **Fail-open on purpose.** If the hook cannot load the classifier it does not refuse (the pipeline saves the machine; it is not a security check — the danger classifier still sees every command that runs).

Chat turns have their own lane (`chatConcurrency`) and are not affected.

## Cancelling
A command stops when: its run is cancelled / the task is cancelled, closed or deleted (`ExecutorService.cancel` → `CommandPipelineService.cancelTask`: waiting commands are dropped, running ones are killed with their process group, the task's tokens go); the agent's attempt ends (its own token's commands stop); its time limit passes; or the agent's request is aborted. A cancelled command never starts again.
