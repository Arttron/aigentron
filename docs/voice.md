# Voice: speak to the assistant and hear it

Answers are **text by default**. Voice is opt-in and works in two directions:

- **Speech → text (🎤).** Telegram voice messages / audio / round video notes, and the 🎤 button in the dashboard (task follow-up box and the admin chat).
- **Text → speech (🔊).** In the dashboard: a 🔊 button on each final answer, the "read answers aloud" switch, or voice-only mode. In Telegram: only in chats where you sent `/voice on` (`/voice off` to stop).

## Setup (Settings → Voice)

1. Add a provider of kind **OpenAI** (Settings → Providers) with its API key. OpenAI itself, Groq, or any local OpenAI-compatible server (Whisper / Piper / Kokoro…) via the provider's Base URL.
2. In **Settings → Voice** switch on recognition and/or synthesis, choose provider, model, language, voice. Press **Test** — it synthesises a phrase and recognises it back.

The configuration lives in `secrets/voice.json` (not in the database). Keys are never stored there: the provider registry holds them.

## Voice-only mode

In the chat (task follow-up or admin assistant) press **🎙 Voice mode**. The input is replaced by an abstract orb that only shows the process: listening → recognising → thinking → speaking. Speak, pause (≈1.4 s of silence ends the phrase), the answer is read aloud. "Keep listening" re-opens the microphone after each answer.

## Privacy & cost

- With a cloud provider the recordings (recognition) and the text of answers (synthesis) are sent to that provider — Settings → Voice says where.
- Code blocks, links and markdown are not read aloud; long answers are cut at a sentence boundary (default 1500 characters); the full text is always on screen.
- Roughly: recognition 0.3–0.6 ¢/min, speech 1.5 ¢ per 1000 characters (OpenAI).

## Notes

- The browser microphone needs **HTTPS or localhost** (see `docs/remote-access.md`).
- Limits: audio up to 5 minutes / 25 MB.
- On phones audio is "unlocked" by the first tap, which is why voice mode starts with a button.
