# Voice: speak to the assistant and hear it

Answers are **text by default**. Voice is opt-in and works in two directions:

- **Speech → text (🎤).** Telegram voice messages / audio / round video notes, and the 🎤 button in the dashboard (task follow-up box and the admin chat).
- **Text → speech (🔊).** In the dashboard: a 🔊 button on each final answer, the "read answers aloud" switch, or voice-only mode. In Telegram: only in chats where you sent `/voice on` (`/voice off` to stop).

## Setup (Settings → Voice)

1. Add a provider of kind **OpenAI** (Settings → Providers) with its API key. OpenAI itself, Groq, or any local OpenAI-compatible server (Whisper / Piper / Kokoro…) via the provider's Base URL.
2. In **Settings → Voice** switch on recognition and/or synthesis, choose provider, model, language (automatic by default; 50 languages can be picked), voice. Recognition models with timestamps (`whisper-1`, Groq Whisper) also let video frames be taken at spoken moments — see `docs/media.md`. Press **Test** — it synthesises a phrase and recognises it back.

The configuration lives in `secrets/voice.json` (not in the database). Keys are never stored there: the provider registry holds them.

## Free, on your own server: the local voice add-on

`sudo aigentron addon enable voice` installs Piper (Russian + English voices) and Whisper behind an OpenAI-compatible address on this machine — no key, no cost per use,
nothing leaves the server. Then **Settings → Voice → Use it for recognition and speech** does the setup in one click. The voice `auto` reads Russian text with the Russian
voice and English with the English one. Details and limits: `docs/addons.md` ("The voice add-on"). A different OpenAI-compatible local server (Kokoro-FastAPI for English-only
quality, openedai-speech, Speaches …) works the same way: a provider of kind OpenAI with its Base URL.

## VoiceLab (voicelab.uz) — Uzbek and 30+ other languages

VoiceLab has its own API (not OpenAI-compatible); Aigentron speaks it when the provider's Base URL is on `voicelab.uz`.

1. Settings → Providers → add a provider of kind **OpenAI**, Base URL `https://api.voicelab.uz/v1`, and the API key from VoiceLab (`/app/developer/api-keys`, with the speech-to-text and text-to-speech permissions; credits on the account).
2. Settings → Voice: pick that provider for recognition and/or synthesis. There is no model to choose. For synthesis choose the **language of the text** and a voice (**Load voices** reads the catalog; or type a voice id). For recognition the language can stay *automatic*.
3. **Test**. Recognition is asynchronous on VoiceLab (upload, then wait for the result), so a voice message takes a little longer than with Whisper.

Notes: synthesis costs one credit per character (the "longest text" limit keeps it in check); VoiceLab returns WAV, which is converted to Opus (Telegram voice) / MP3 (browser) with ffmpeg — without ffmpeg the WAV is sent as it is. Written from the public documentation; if VoiceLab changes a field, the client reads several spellings of the usual keys (`apps/orchestrator/src/voice/voicelab.ts`).

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
