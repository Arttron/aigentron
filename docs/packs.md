# Starter packs

A pack is a ready-made set for one kind of project: **agents**, a **skill**, **starter notes** for the shared library and **prepared schedules**.
Shipped with the release in `agent/packs/<name>/`.

| Pack | For | Agents |
|---|---|---|
| `english` 🇬🇧 | learning English on your own | english-tutor, english-curriculum, english-quizmaster |
| `renovation` 🏠 | planning a home repair | renovation-planner, renovation-estimator, interior-designer, materials-advisor |
| `development` 💻 | software work on a repository | pm, architect, backend, frontend, designer, reviewer (from the shared catalog) |

## Installing
- **Dashboard → Agents → Starter packs → Install** (uses your browser's time zone for the schedules), or
- **ask the admin** ("set me up for learning English") — it shows one approval card listing the contents.

Installing **never overwrites** anything that already exists (agents, skills, library notes, schedules are matched by name/title), so you can press it again
to fill gaps and your own edits stay. **Schedules are created switched OFF** and without a chat: open Settings → Schedules, pick the chat and turn them on.
They start tasks, so they use model budget.

## After installing (the pack tells you too)
1. Fill in the starter note in **📚 Resources** — *Learner profile* / *Renovation brief* (+ measurements, budget) / *Project conventions*. Agents read it first.
2. For renovation: upload room photos to Resources with a one-line description each.
3. Optional: connect Telegram (ask the admin) so reminders and results reach your phone.
4. Start with a first task for the pack's lead agent (e.g. `english-tutor`: "assess my level with a short chat").

Notes
- English/renovation agents are written for non-code work: they can read the library and the project folder and keep notes there (progress log, plan) but have no shell. Point the project at a
  plain notes folder (Settings → General → leave the repository empty / use a local workspace) rather than a code repository.
- Renovation renders: no image generator is connected yet — the designer produces precise descriptions and ready image prompts.
- Making your own pack = a folder under `agent/packs/<name>/` with `pack.json` (see the shipped ones); `pnpm test` checks every reference in it.
