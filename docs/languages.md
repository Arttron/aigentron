# Languages and tokens

Goal: the service works in **any language**, and costs as few tokens as possible.

## Why English inside
Tokens cost money, and other languages cost more: the same sentence takes roughly 2–3× the tokens in Russian or Ukrainian, 2–4× in Hindi, Thai or Arabic, and CJK is dense per character but still heavier than English. Agents' system prompts and instructions are paid for on every run, and every message between agents is paid for twice (written, then read).

## The rules (agent/SOUL.md → "Language")
- **The person's language** is used only for what the person reads: the final answer, `ask_user` questions, the conclusion of a discussion, task titles.
- **Between agents** everything is **terse English**: subtask prompts, handoffs, reports to a lead, discussion turns — telegraphic, facts + next action, no greetings, no retelling of context the receiver has, files by path.
- **Sources stay as they are.** Documents, logs and knowledge bases are read in their own language and passed on as a short English summary; nothing is translated "to be safe". `kb_search` queries are written in the language of the documents (keyword search does not translate; with embeddings, meaning search also crosses languages).
- **Agent files** (instructions, descriptions) should be in concise English even for non-English users, with one line "answer the person in their language" (the admin does this when it creates agents).

## Discussions between agents
By default the agents talk terse English to each other (~80 words per message) and the **conclusion** is written in the language of the topic. Each message has a **🌐 translate** link (on demand, a few tokens, uses the small model of Settings → General → Task titles). Choose **Language of the agents → Your language** (or `/discuss lang=user …` in Telegram) to have them talk in your language throughout.

## What works in every language (checked by tests, `src/languages.test.ts`)
- Task text, titles (generated in the request's language), file names (Cyrillic, CJK, Arabic … keep their letters), agent names and knowledge-base names in any script; `/name` and `@name` find agents with non-Latin names, tolerating case and typos.
- Knowledge-base search: Latin (with accents), Cyrillic, Greek, Arabic (harakat ignored), Hebrew, Hindi/Thai/Vietnamese (combining marks kept), Chinese/Japanese/Korean (character pairs); sentence and clause detection for CJK, Hindi and Arabic punctuation, "第N条", "Artikel 3.".
- "The task is finished" in a message: ~20 languages (button and `/done` work in all). Task search on SQLite also handles non-ASCII case. Telegram messages are cut without splitting emoji. Right-to-left text (Arabic, Hebrew) is shown with automatic direction in messages and inputs. Voice recognition: automatic language by default, 50 languages selectable.

## Not translated
The dashboard's own labels are English (a localised interface is a possible later step).
