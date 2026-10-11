# Questions from agents (`ask_user`)

An agent that needs a decision or a missing fact asks the person instead of guessing — with **answer buttons**, in the dashboard and in chat channels at once.

## What the agent does
`ask_user {question, options?, allow_text?, image?}`:
- `question` — short and specific; `options` — 2–6 short choices (buttons; leave out for an open question);
- `multiple` (default no) — several options may be ticked: checkboxes in the dashboard; in Telegram ☐/☑ buttons plus **✅ Done** (or reply "1, 3"). The answer is the chosen options joined with "; ";
- `allow_text` (default yes) — the person may also answer in their own words;
- `image` — a picture shown with the question (for example a frame from `video_digest`: "is THIS the crack?").
The run waits (the task shows *needs approval*). The agent gets back "The user answered (option 2): Grey" — or, if nobody answers in time (default 1 h, env `QUESTION_TIMEOUT_SECONDS`), a note to pick the safest default or report the task as blocked. Answering is not gated; the question itself is the human step.

## Where you answer
- **Dashboard** — the card in the bottom-right dock (with the approvals), on every page. Tap a button, or type your own answer.
- **Telegram** — the question arrives as a message with a button per option. Tap one, **or simply reply with text** (a number picks that option). It goes to the task's own chat; for a dashboard task nobody is watching, to the allowed chats after a short grace period.
- The first answer wins; the other places update at once (buttons disappear, the message shows the answer). A cancelled or finished task withdraws its questions.

## Notes
- Who may answer in the dashboard: reviewer, operator, admin and task setter. A chat may answer only questions sent to it.
- `GET /api/questions?status=pending`, `POST /api/questions/:id/answer {index|text}`; events `question:created` / `question:resolved`.
- The table is `AgentQuestion` (both Postgres and SQLite migrations).

## For learning and quizzes
`ask_user` suits drills: a multiple-choice item with 2–4 button options, or an open "translate this" question. The English starter pack's tutor and quizmaster use it (quiz one item at a time, instant feedback in the next message). Each answer is one model turn, so a 10-item quiz is 10 short turns; a long pause ends in a timeout, not a lost run. (Packs already installed keep their old agent files — reinstall the pack or ask the admin to update the agents to get the new behaviour.)
