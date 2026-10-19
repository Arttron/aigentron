# How agents create work (reference — answer from this, never guess)

**Tools of a lead agent** (the agent of a top-level task, such as `pm`). A subtask's agent has NONE of `create_subtask` / `check_subtasks` / `complete_subtask` / `create_task` (it still has `report_task_status` and `schedule_check`):
- `create_subtask {prompt, title?, agent?}` — splits THIS task into a part that runs on its own. It always lands in the parent's project; it has NO `project` and NO `standalone` option. By default at most 25 OPEN subtasks per task (done / cancelled / failed ones do not count) and 100 in total (`SUBTASK_LIMIT` changes both). An equivalent open subtask is returned instead of a duplicate.
- `check_subtasks` (status + latest result of its subtasks), `complete_subtask {id}` (accept one of its own), `schedule_check` (re-run itself later), `report_task_status`.
- `create_task {project, prompt, title?, agent?}` — a NEW top-level task in a project (any live project; `default` for the default one). Only for a LEAD whose file has the line `createTasks: true` OR the skill `task-splitting` in its `skills:` (that skill also teaches when to split work out: 3+ subtasks on one theme, or a subtask that needs its own breakdown); every call is approved on a card; an equivalent task already waiting / running / ready in that project is returned instead (an accepted one does not block starting the work again). It is NOT a subtask: `check_subtasks` does not list it.

**Step limit.** An agent's file may have `maxTurns: 80` (5–500; default 40 for everyone): how many steps one run may take before it must report or ask the person to continue. Give leads that plan big work more; the Agents form has the field.

**Pushing code.** Agents of a code project with a remote have `push_branch {branch, to?, reason}`: a person approves each push, the orchestrator pushes with the project's key (agents hold none, so a `git push` from their shell always fails). Never forced; works on local branches only.

**Where a task lives.** A task's project is set when it is created (New task form, the project's default agent, or `create_task`); its subtasks inherit it. `propose_task` (mine) makes a subtask of this chat by default (when this chat is itself top-level), or with `standalone: true` a top-level task in the DEFAULT project — it has no project option.

**To let an agent start tasks in projects:** `propose_agent` with the skill `task-splitting` in `skills:` (or `createTasks: true`) in its frontmatter (the dashboard form cannot set it; a later edit in the form keeps it). Tell the person each task still needs their approval.

**Accuracy rule.** Say what the references above and `admin-tools` document. If something is not documented there (a tool option, a file name, a setting), say "I don't see that documented" and offer to check with `agents_list` / `agent_get` — do not invent options, flags or file paths.
