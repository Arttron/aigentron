# Camera, photos and video

## Sending
- **Dashboard** — the 📎 menu of a message / new task: *Image / video / file* or **📷 Camera**. With HTTPS (or localhost) the camera opens in the page:
  take several photos or record a clip, review, attach. Over plain HTTP the phone's own camera app is used instead. Big photos are shrunk to ≤ 1600 px
  JPEG in the browser (this also strips EXIF / GPS). Videos are sent as they are (≤ 95 MB — the web proxy in front of the server, e.g. Cloudflare free, refuses more than 100 MB, so the server refuses first with a clear message; other files ≤ 10 MB; ≤ 1 GB of files per task; the limits are in `GET /media` → `limits`). A browser-recorded clip (webm, no length in its header) is copied into a proper webm on upload without re-encoding, and reading falls back to the last packet's timestamp, so `look_at`/`video_digest` work on it. Uploads are written under a hidden `.part` name and moved into place, so a half-sent file never shows up and a same-named file is never overwritten.
- **Telegram** — photos, videos, round video messages (video notes), GIF animations and files. Telegram bots can download only ≤ 20 MB: for a bigger
  clip the bot says so and you upload it in the dashboard. Voice messages and audio files are transcribed as before (`docs/voice.md`).
- **Library** — *Resources* accepts videos too; they play in the dashboard (HTTP Range, so seeking works on iOS).

## How the agent sees a video (`video_digest`, `look_at`)
1. **ffmpeg** extracts the soundtrack (mono 16 kHz mp3) and frames (about one per 10 s, 4–24 frames, ≤ 1024 px).
2. The soundtrack goes through speech recognition (Settings → Voice) → a timed transcript.
3. `video_digest {path}` returns frame list + transcript (cached in `<agent dir>/cache/digests/<hash of the video's path>/` — one folder per video wherever it lives, never next to it, so the workspace and a project repository are not littered; processed once, an unchanged file is never redone; a digest that is used stays young; digests older than 30 days are pruned automatically and regenerated on demand — `DIGEST_RETENTION_DAYS`, `docs/workspace-layout.md`). A `<video>.digest/` folder made by a version before 0.1.63 is moved into the cache the first time that video is used again (nothing is reprocessed), and old ones are pruned like any other digest.
4. `look_at {path, question}` shows the photo or the video's frames to the **vision model** and returns its answer to the question.
**Frame step:** both tools take an optional `every_seconds` (one frame every N seconds, min 1, at most 60 frames; a longer clip gets a larger step). Without it the spread is automatic. A different step re-processes the video (one cache per file); `look_at` shows at most 8 of the frames at once, evenly picked. Ask the agent in plain words: «разбей это видео по кадрам раз в 2 секунды».
**Frames at the moments something is said:** the transcript is timestamped (`[0:12] …`; Whisper-style models give timestamps — `whisper-1`, Groq Whisper; `gpt-4o-transcribe` gives none). With `pointing: true` the frames are taken when the speaker says "смотри / вот тут / вот здесь / look here / over here…" (built-in list), with `phrases: ["…"]` when your own words are said, with `at_seconds: [12, 40]` at exact times. Each such frame is labelled with the words (`(said: “смотри, вот тут трещина”)`), and `look_at` tells the vision model what was being said at that moment. Frames are taken ~0.4 s after the first word. If the phrases are not found, or the speech model gives no timestamps, the digest says so and falls back to the even spread. The transcript is cached, so trying another frame plan does not pay for recognition again.
Limits: a video on disk ≤ 300 MB for a digest (uploads ≤ 95 MB) and ≤ 20 min; digests built in the last 10 minutes are never pruned; the same file is never digested twice at once, ≤ 8 images per `look_at`.

## Settings → Vision
Press **Save** — the selection is not applied before that (the page says "Not saved yet"; **Test** saves it first). Without any setting, an agent running on a cloud model (Anthropic, OpenAI-style API) uses its own model for `look_at`; local/DeepSeek-style agents get "No vision model is set up".
Pick a provider and a vision-capable model (OpenAI, Anthropic, DeepSeek, local Ollama such as `qwen3-vl`); *Test* shows it a red square. Subscription
logins (Claude / Codex sign-in) cannot be used here. Images leave the server for that provider and cost tokens; a local Ollama model is free.
The tab also shows whether ffmpeg is installed (the installer and Docker images include it) and whether speech recognition is on.

## Talking about a photo or a moment of a video
In a task, click a photo or video (in the conversation or in Attachments) — it opens in a viewer. **💬 Ask about this moment** (video: pause where you want) or **💬 Mark and ask** (photo) freezes the picture; drag to draw a red rectangle round what you mean, type the question, **Ask**. The marked picture is attached to a follow-up message together with where it came from (file and time, e.g. "the frame of the video room.mp4 at 0:12.4"), so the agent can also look at other moments of the same video (`look_at` / `video_digest` with `at_seconds`).
The agent can ask back with a picture too: `ask_user` takes an `image` (a video frame, a photo) — see `docs/questions.md`.

## Picture sizes (automatic)
Every picture that arrives — dashboard upload, Telegram, the API, a screenshot an agent made — is shrunk on the server to what is needed: longest side ≤ 1600 px (library pictures ≤ 2000 px; env `IMAGE_MAX_SIDE`), re-encoded (JPEG ≈ 85 %), location/EXIF data dropped and rotation applied. A PNG without transparency becomes a JPEG (its name follows); a PNG with transparency stays a PNG; GIFs and small pictures are left alone; if the result would not be smaller the original is kept. Needs ffmpeg (without it nothing is changed).

## Showing pictures in the chat (`show_images`)
An agent that produced pictures (generated images, charts, screenshots, frames it extracted) calls `show_images {paths, caption?}` — one picture, or an **album** of up to 10 in one call. The files can be in the task's attachments, the resource library or the workspace; they are copied into the task's attachments (and shrunk like any other picture). In the dashboard they appear inline in the conversation: a single picture large, several as a grid, click to open the viewer (‹ › step through the album; you can still mark a spot and ask). In Telegram they are sent at once as a photo or a media-group album with the caption. Pictures an agent only leaves in the task's attachments folder are still sent when the task settles — as one album when there are several.


## Pictures generated by Codex

Codex generates images into its own sandbox (`<agent>/runs/<task>/codex-home/generated_images/…`). After every Codex run the orchestrator copies the new pictures (png/jpg/webp/gif, ≤10 per run, ≤30 MB each, optimised like uploads) into the task's attachments and shows them in the chat (and Telegram) — the agent does not need `cp`/approvals. Each source file is adopted once (`runs/<task>/adopted-images.json`). `show_images`, `look_at`, `video_digest` and `workspace_save {from}` also accept paths in that folder (only `generated_images`, never the rest of `codex-home`).

## Text files for chat agents

The admin (and discussion participants) have no file-reading tool. When you attach a text file (md, txt, csv, json, yaml, xml, log, html) to a message for them — in the dashboard or in Telegram — the beginning of the file (≤12 000 characters per file, ≤24 000 per message) is put into the prompt as data; pictures go through `look_at`, other formats (PDF, Word …) are reported as unreadable so the agent asks for the text. Working agents use `Read` on the path as before. Agents with no file reader (the admin, any agent whose allowed tools lack `Read`) also have the tool `read_document {path, from?}`: the text of any attachment of THIS task (just its name — also files uploaded later in the Files tab), or of a workspace / library file (full path; other tasks' attachments are not readable), files up to 10 MB, the extracted text is cached in memory per file version; Markdown, text, CSV, JSON, HTML, PDF with a text layer and Word (.docx), 12 000 characters at a time (`from` = offset for the next part).

## File names of attachments

A task attachment is stored under a plain-ASCII name: Cyrillic and Greek are transliterated, Latin accents stripped (`кухня 2.jpg` → `kukhnya-2.jpg`, `Проект кухни №2.md` → `Proekt-kukhni-No2.md`), other scripts that cannot be transliterated become `file.<ext>`; a clash gets `-1`, `-2`. This keeps shells, git, URLs, macOS/Linux unicode normalisation and the models' tool calls away from non-ASCII paths. What the person called the file is kept in `<attachments>/<task>/.names.json` (stored → original) and shown in the dashboard gallery, used as the download file name and as the file name in Telegram; the agent's prompt lists the stored path with «uploaded as …». Files uploaded before this change keep their names. Resources already work this way (stored by id, original name in the manifest); workspace files keep the names given.
