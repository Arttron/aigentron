# Ordering subtasks: `after`

`create_subtask {prompt, title?, agent?, after?}` — `after` is a list of ids of EARLIER subtasks of the same lead.

- **Held, not queued.** A subtask whose predecessors are still going is created with `waitingFor` (JSON ids, `Task.waitingFor`) and status `queued` but NO job in the worker's queue. The queue sweep (`reconcileQueued`) skips it; the task page says what it waits for (`WaitingOnNotice`). A predecessor that is already done is nothing to wait for (the subtask starts at once; its result is still folded into the context).
- **Who decides.** The server, in code (`TasksService.releaseDependents` / `settleDependent`), not the lead model and not the event bus (the bus is in-memory and only tells the UI). It runs at every settle point — a worker run ending (`fanInAfterSettle`), a status written outside a run (`setStatus`), a deletion — and from the periodic sweep and at boot (`releaseAllReady`), so a missed release is made up after a restart. The claim is atomic (`updateMany` on the exact `waitingFor`), so two settlements release once.
- **Results.** The predecessors are linked as references of the new subtask, so their summaries fold into its context (the same mechanism as `related`).
- **A predecessor ended badly** (failed, cancelled, blocked, stalled, deleted): the held subtask is `blocked` with the reason, and the lead is woken (it waits for all subtasks to be over) to redo, skip or cancel. A subtask is not created at all when it names a predecessor that already ended badly, or an id that is not a subtask of the same lead (this also makes cycles impossible).
- **Satisfied by** `done` and `review`.
- **Cancel** of a held subtask, or of the lead (it cancels the open subtasks), just ends it; nothing is left running.
- **Parallelism.** `create_subtask` tells the lead how many tasks the server runs at once (Settings → concurrency), so it knows how far subtasks without `after` really run in parallel. A released subtask goes through the normal queue (concurrency, the machine gate, the command pipeline).
- Subtasks cannot have subtasks of their own (only a top-level task's agent has `create_subtask`).
