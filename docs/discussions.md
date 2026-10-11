# Discussion between agents (round-table)

Several agents talk to **each other** inside one chat, one after another, and you can join in. Useful for weighing a decision from different roles (PM vs. architect vs. QA), brainstorming, or a pre-mortem.

## Start one
- **Dashboard:** *New task* → **💬 Discuss** (a new chat), or open a finished chat and press **💬 Discuss** in its header / ⋯ menu. Write the topic, tick 2–6 agents, choose the number of rounds (1–6) and who writes the conclusion.
- **Telegram:** `/discuss pm architect: should we rewrite the app?` (optional `rounds=2` as the first word; names tolerate typos). The conclusion is written by the first named agent.
- API: `POST /api/discussions {topic, agents[], rounds?, summaryBy?, taskId?}` (roles task setter, operator, admin).

## What happens
- Each **turn** is a short, real run of that agent (its own role, provider and model — Claude, OpenAI-style, Ollama, Codex all work). It sees the topic and the conversation so far and answers the others in ~150 words. It runs in an empty scratch folder of its own and may only talk: no editing, no shell, no web, none of its own MCP servers, no questions to the human; it can search the knowledge bases it is allowed to and ask for the time. (Codex-runtime agents take part without any tools — they only talk.)
- Messages appear as `name>` in the conversation (a colour per agent); in Telegram as `🗣 name: …`, one by one.
- Turns go in order, `rounds × participants` in total. If a whole round ends with agreement ("[[AGREED]]" in each reply) it stops early.
- **You can join in** at any moment: write in the message box (or in the Telegram chat). Your message is added to the conversation and the next speaker answers it first.
- The bar above the conversation shows the turn and who is answering, with **Wrap up** (skip to the conclusion) and **Stop**. Cancelling the task also stops it.
- At the end the chosen agent writes a short conclusion: what was agreed, where they still disagree, the recommended next step. Afterwards the chat is an ordinary chat: your next message continues with the first participant.

## Notes
- Cost: one model call per turn (+1 for the conclusion); the per-provider usage page counts them.
- Two failed turns in a row end the discussion with a note naming the agent whose provider failed. A provider error is never shown as something an agent said. Built-in agents (admin) cannot take part.
- A discussion is held in memory: a server restart during one leaves the chat "stalled" — just start another.
