# Camera, photos and video

## Sending
- **Dashboard** — the 📎 menu of a message / new task: *Image / video / file* or **📷 Camera**. With HTTPS (or localhost) the camera opens in the page:
  take several photos or record a clip, review, attach. Over plain HTTP the phone's own camera app is used instead. Big photos are shrunk to ≤ 1600 px
  JPEG in the browser (this also strips EXIF / GPS). Videos are sent as they are (≤ 300 MB).
- **Telegram** — photos, videos, round video messages (video notes), GIF animations and files. Telegram bots can download only ≤ 20 MB: for a bigger
  clip the bot says so and you upload it in the dashboard. Voice messages and audio files are transcribed as before (`docs/voice.md`).
- **Library** — *Resources* accepts videos too; they play in the dashboard (HTTP Range, so seeking works on iOS).

## How the agent sees a video (`video_digest`, `look_at`)
1. **ffmpeg** extracts the soundtrack (mono 16 kHz mp3) and frames (about one per 10 s, 4–24 frames, ≤ 1024 px).
2. The soundtrack goes through speech recognition (Settings → Voice) → a timed transcript.
3. `video_digest {path}` returns frame list + transcript (cached next to the file in `<video>.digest/`, so it is processed once).
4. `look_at {path, question}` shows the photo or the video's frames to the **vision model** and returns its answer to the question.
**Frame step:** both tools take an optional `every_seconds` (one frame every N seconds, min 1, at most 60 frames; a longer clip gets a larger step). Without it the spread is automatic. A different step re-processes the video (one cache per file); `look_at` shows at most 8 of the frames at once, evenly picked. Ask the agent in plain words: «разбей это видео по кадрам раз в 2 секунды».
**Frames at the moments something is said:** the transcript is timestamped (`[0:12] …`; Whisper-style models give timestamps — `whisper-1`, Groq Whisper; `gpt-4o-transcribe` gives none). With `pointing: true` the frames are taken when the speaker says "смотри / вот тут / вот здесь / look here / over here…" (built-in list), with `phrases: ["…"]` when your own words are said, with `at_seconds: [12, 40]` at exact times. Each such frame is labelled with the words (`(said: “смотри, вот тут трещина”)`), and `look_at` tells the vision model what was being said at that moment. Frames are taken ~0.4 s after the first word. If the phrases are not found, or the speech model gives no timestamps, the digest says so and falls back to the even spread. The transcript is cached, so trying another frame plan does not pay for recognition again.
Limits: video ≤ 300 MB and ≤ 20 min, ≤ 8 images per `look_at`.

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
