# Scheduled scripts

Schedules (main menu, after Tasks) can run a **script** instead of posting a message or starting an agent: a shell script on the server, no model, no cost. Only an operator / admin can create or change one (the admin assistant and packs cannot).

## When to use a script
Whenever the steps are the same on every run — fetch data, calculate, draw a chart, post it — use a script, not a task for an agent: it costs no model tokens, cannot get lost in a multi-step plan, and its history and files are handled by the server. Keep an agent task for work that needs judgement. An agent started by a schedule is told this and will suggest the move (and may save a draft script into the workspace); the admin assistant recommends it when you set up a schedule.

## How it runs
- `sh -c` in the schedule's project folder (an empty scratch folder when there is none), at the time set by the schedule.
- A minimal environment — none of the server's keys. Variables the script gets:
  - `LDS_SCHEDULE` — the schedule's name.
  - `LDS_DATA_DIR` — a folder that **stays between runs** (a history file, a counter). One per schedule, `<data>/schedule-data/<id>`.
  - `LDS_OUTPUT_DIR` — an **empty folder at every start**. Whatever the script leaves there is posted to the schedule's chat afterwards (pictures as photos — an album for 2–10 —, other files as documents; up to 10 files, 25 MB each) and **deleted**. Nothing stays on disk.
- Time limit (default 10 minutes, up to 6 hours; the whole process group is killed). A new run is skipped while the previous one still works.
- What the script prints (the last 4000 characters) is kept under the schedule ("Last output") and becomes the **caption** of the files, or a text message when there are no files. "Post to the chat": after every run, or only when it fails (files are always posted).

## Example: a currency chart with no AI
`docs/examples/fx-chart.py` fetches PrivatBank's EUR/UAH rates (cash and card), appends a row to `$LDS_DATA_DIR/fx-eur-history.csv`, draws the last 14 days with the last points labelled, and leaves `eur-uah.png` in `$LDS_OUTPUT_DIR`. It needs `python3` and `matplotlib` on the server (`pip install matplotlib`).

1. Copy it to the server (for example into the project folder, `scripts/fx-chart.py`), or paste its content as the script body with `python3 - <<'PY' … PY`.
2. Schedules → **+ Add schedule** → *Run a script on the server*. Script: `python3 scripts/fx-chart.py`. Pick the chat and the time (daily, 09:00). *Post to the chat*: after every run.
3. **Run now** to try it: the picture and the rates arrive in the chat; the history file grows by one row per run.

Why not an agent: drawing a chart is the same every time; a small model that writes the plotting code anew on each run, starts it in the background and ends its turn with "I will report later" loses the picture (and the run stalls). A script has no such steps.

Rates and chart keep working without the bot token: the server sends the picture through the channel that is already set up.
