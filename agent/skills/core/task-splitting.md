---
name: task-splitting
description: When a task or subtask has outgrown its parent, move the work to its own top-level task (create_task) and work it with its own subtasks. Gives the agent the create_task tool; every task it starts is approved by a person.
---

# Skill: splitting out work that outgrew its task
**Applies to:** PM / lead agents.

Having this skill gives you the `create_task` tool (a lead only — the agent of a top-level task). Use it sparingly: a person approves each call on a card, so put the reason in `reason` (one plain line) — that is what they read first.

## When to split work out
Split when ANY of these holds, otherwise keep using `create_subtask`:
- **Three or more subtasks are about the same theme** (one feature, one document, one integration) and still growing — they belong together under their own lead.
- **A subtask is itself a project**: it needs its own breakdown (more than ~3 parts), several agents, or a long run; it would need subtasks of its own, and subtasks cannot have them.
- The work is **independent of this task's result** and can be accepted or dropped on its own.

Do NOT split just because the task is long, or to dodge the subtask limit (25 open): finish or close the finished subtasks (`check_subtasks`, `complete_subtask`) first.

## How
1. `check_subtasks` — see what already exists; do not start the same work twice (an equivalent open task is returned instead).
2. Write a COMPLETE brief for the new task: the goal, what is already done and where (task ids, branches, files), what is left, what "done" means. The new task does not see this chat — copy the essence, do not just point at it.
3. `create_task {project, prompt, title, agent?, reason, related}` — `project` is the slug of the project it belongs to; `related`: ids of the tasks it grows out of (they are linked, so their summaries fold into the new task's context). Pick `agent` (usually a lead such as `pm`) that will break it down further.
4. Tell the person what you moved and why; keep the old subtasks as they are — settle them (`complete_subtask`) or leave them for the person.
