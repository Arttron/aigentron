#!/usr/bin/env python3
"""
Aigentron local voice server — an OpenAI-compatible speech API on this machine.

  POST /v1/audio/speech          text -> speech   (Piper voices; mp3 / opus / wav / flac through ffmpeg)
  POST /v1/audio/transcriptions  speech -> text   (faster-whisper; json / verbose_json with segment and word times)
  GET  /v1/models, /v1/audio/voices, /health

Only the Python standard library is needed to start it; faster-whisper is imported when the first recording arrives
(`--no-stt` / WHISPER_MODEL=off disables recognition). Binds to loopback; the orchestrator is its only client.

Voices: a request's `voice` is a Piper voice name that is installed (`ru_RU-irina-medium`); anything else (`auto`, `alloy`, …) picks the default
Russian or English voice by the script of the text — so one setting reads both languages.
"""
import argparse
import json
import os
import subprocess
import sys
import tempfile
import threading
from email.parser import BytesParser
from email.policy import HTTP as HTTP_POLICY
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

PREFIX = os.environ.get("AIGENTRON_VOICE_PREFIX", "/opt/aigentron/voice")
VOICES_DIR = os.path.join(PREFIX, "voices")
PIPER_DIR = os.path.join(PREFIX, "piper")
MODELS_DIR = os.path.join(PREFIX, "models")
MAX_BODY = 26 * 1024 * 1024
MAX_TEXT = 6000
DEFAULTS = {"ru": "ru_RU-irina-medium", "en": "en_US-amy-medium"}
FORMATS = {"mp3": ("audio/mpeg", ["-c:a", "libmp3lame", "-b:a", "96k", "-f", "mp3"]),
           "opus": ("audio/ogg", ["-c:a", "libopus", "-b:a", "32k", "-application", "voip", "-f", "ogg"]),
           "flac": ("audio/flac", ["-c:a", "flac", "-f", "flac"])}

_tts_slots = threading.Semaphore(2)
_stt_lock = threading.Lock()
_stt_run = threading.Lock()  # one recording at a time: CPU-bound, and one shared model
_whisper = None


# ---- pure helpers (tested without Piper / Whisper) ---------------------------------------------------------------------------
def cyrillic_share(text: str) -> float:
    letters = [c for c in text if c.isalpha()]
    return sum(1 for c in letters if "Ѐ" <= c <= "ӿ") / len(letters) if letters else 0.0


def installed_voices(directory: str = None) -> list:
    directory = directory or VOICES_DIR
    try:
        return sorted(f[:-5] for f in os.listdir(directory) if f.endswith(".onnx") and os.path.exists(os.path.join(directory, f + ".json")))
    except OSError:
        return []


def pick_voice(requested: str, text: str, installed: list, defaults: dict = None) -> str:
    """The Piper voice to use: the requested one when it is installed, else the default of the text's language."""
    defaults = defaults or DEFAULTS
    if requested in installed:
        return requested
    lang = "ru" if cyrillic_share(text) >= 0.3 else "en"
    wanted = defaults.get(lang, "")
    if wanted in installed:
        return wanted
    same = [v for v in installed if v.startswith(lang + "_")]
    if same:
        return same[0]
    if installed:
        return installed[0]
    raise LookupError("no voices are installed")


def parse_multipart(content_type: str, body: bytes):
    """-> (fields: dict[str, str], files: dict[str, (filename, bytes)]) from a multipart/form-data body."""
    msg = BytesParser(policy=HTTP_POLICY).parsebytes(b"Content-Type: " + content_type.encode() + b"\r\nMIME-Version: 1.0\r\n\r\n" + body)
    fields, files = {}, {}
    for part in msg.iter_parts() if msg.is_multipart() else []:
        name = part.get_param("name", header="content-disposition")
        if not name:
            continue
        payload = part.get_payload(decode=True) or b""
        filename = part.get_filename()
        if filename is not None:
            files[name] = (filename, payload)
        else:
            fields[name] = payload.decode("utf-8", "replace")
    return fields, files


def clean_text(text: str) -> str:
    return " ".join(text.split())[:MAX_TEXT]


# ---- speech ------------------------------------------------------------------------------------------------------------------
def synthesize_wav(text: str, voice: str, speed: float) -> bytes:
    model = os.path.join(VOICES_DIR, voice + ".onnx")
    piper = os.path.join(PIPER_DIR, "piper")
    with tempfile.TemporaryDirectory() as tmp:
        out = os.path.join(tmp, "out.wav")
        cmd = [piper, "--model", model, "--output_file", out, "--sentence_silence", "0.15"]
        if 0.5 <= speed <= 2.0 and speed != 1.0:
            cmd += ["--length_scale", "%.3f" % (1.0 / speed)]
        with _tts_slots:
            r = subprocess.run(cmd, input=text.encode("utf-8"), cwd=PIPER_DIR, capture_output=True, timeout=120)
        if r.returncode != 0 or not os.path.exists(out):
            raise RuntimeError("piper failed: " + r.stderr.decode("utf-8", "replace")[-300:])
        with open(out, "rb") as f:
            return f.read()


def convert(wav: bytes, fmt: str):
    if fmt == "wav" or fmt not in FORMATS:
        if fmt not in ("wav", *FORMATS):
            fmt = "mp3"
        else:
            return wav, "audio/wav"
    mime, args = FORMATS[fmt]
    r = subprocess.run(["ffmpeg", "-hide_banner", "-loglevel", "error", "-i", "pipe:0", *args, "pipe:1"], input=wav, capture_output=True, timeout=60)
    if r.returncode != 0 or not r.stdout:
        return wav, "audio/wav"  # no ffmpeg: the WAV itself (the caller says what it got)
    return r.stdout, mime


# ---- recognition -------------------------------------------------------------------------------------------------------------
def whisper_model():
    global _whisper
    with _stt_lock:
        if _whisper is None:
            name = os.environ.get("WHISPER_MODEL", "small")
            if name == "off":
                raise LookupError("speech recognition is switched off on this server")
            from faster_whisper import WhisperModel  # imported late: only recognition needs it

            _whisper = WhisperModel(name, device="cpu", compute_type="int8", download_root=MODELS_DIR)
        return _whisper


def transcribe(audio: bytes, filename: str, language: str, verbose: bool) -> dict:
    model = whisper_model()
    suffix = os.path.splitext(filename or "")[1] or ".ogg"
    with tempfile.NamedTemporaryFile(suffix=suffix) as f:
        f.write(audio)
        f.flush()
        segs, words, parts = [], [], []
        with _stt_run:
            segments, info = model.transcribe(f.name, language=language or None, word_timestamps=verbose, vad_filter=True)
            segments = list(segments)  # the generator does the work: finish it inside the lock
        for s in segments:
            parts.append(s.text.strip())
            segs.append({"start": round(s.start, 2), "end": round(s.end, 2), "text": s.text.strip()})
            for w in (s.words or []) if verbose else []:
                words.append({"start": round(w.start, 2), "end": round(w.end, 2), "word": w.word.strip()})
    out = {"text": " ".join(p for p in parts if p)}
    if verbose:
        out.update({"language": info.language, "segments": segs, "words": words})
    return out


# ---- http --------------------------------------------------------------------------------------------------------------------
class Handler(BaseHTTPRequestHandler):
    server_version = "AigentronVoice/1"

    def log_message(self, fmt, *args):  # one short line per request on stderr (journald)
        sys.stderr.write("%s %s\n" % (self.address_string(), fmt % args))

    def _send(self, code: int, body: bytes, mime: str = "application/json", extra: dict = None):
        self.send_response(code)
        self.send_header("Content-Type", mime)
        self.send_header("Content-Length", str(len(body)))
        for k, v in (extra or {}).items():
            self.send_header(k, v)
        self.end_headers()
        self.wfile.write(body)

    def _json(self, code: int, obj):
        self._send(code, json.dumps(obj).encode("utf-8"))

    def _error(self, code: int, message: str):
        self._json(code, {"error": {"message": message, "type": "invalid_request_error" if code < 500 else "server_error"}})

    def _body(self) -> bytes:
        n = int(self.headers.get("Content-Length") or 0)
        if n < 0:
            raise ValueError("bad Content-Length")
        if n > MAX_BODY:
            raise ValueError("the upload is too large (max %d MB)" % (MAX_BODY // 1048576))
        return self.rfile.read(n)

    def do_GET(self):
        path = self.path.split("?")[0]
        voices = installed_voices()
        if path == "/health":
            return self._json(200, {"ok": True, "voices": voices, "stt": os.environ.get("WHISPER_MODEL", "small") != "off"})
        if path == "/v1/models":
            return self._json(200, {"object": "list", "data": [{"id": "piper", "object": "model"}, {"id": "whisper-" + os.environ.get("WHISPER_MODEL", "small"), "object": "model"}]})
        if path == "/v1/audio/voices":
            return self._json(200, {"voices": voices, "defaults": DEFAULTS})
        self._error(404, "not found")

    def do_POST(self):
        path = self.path.split("?")[0]
        try:
            if path == "/v1/audio/speech":
                return self._speech()
            if path == "/v1/audio/transcriptions":
                return self._transcriptions()
            self._error(404, "not found")
        except LookupError as e:
            self._error(501, str(e))
        except ValueError as e:
            self._error(400, str(e))
        except Exception as e:  # noqa: BLE001 — a failure of one request must not stop the server
            sys.stderr.write("error: %r\n" % (e,))
            self._error(500, str(e)[:300])

    def _speech(self):
        try:
            req = json.loads(self._body() or b"{}")
        except json.JSONDecodeError:
            raise ValueError("the body must be JSON")
        text = clean_text(str(req.get("input", "")))
        if not text:
            raise ValueError("`input` is empty")
        voice = pick_voice(str(req.get("voice", "auto")), text, installed_voices())
        try:
            speed = float(req.get("speed", 1.0))
        except (TypeError, ValueError):
            speed = 1.0
        wav = synthesize_wav(text, voice, speed)
        audio, mime = convert(wav, str(req.get("response_format", "mp3")).lower())
        self._send(200, audio, mime, {"X-Voice": voice})

    def _transcriptions(self):
        ctype = self.headers.get("Content-Type", "")
        if "multipart/form-data" not in ctype:
            raise ValueError("send multipart/form-data with a `file`")
        fields, files = parse_multipart(ctype, self._body())
        if "file" not in files or not files["file"][1]:
            raise ValueError("`file` is missing or empty")
        verbose = fields.get("response_format") == "verbose_json"
        name, data = files["file"]
        self._json(200, transcribe(data, name, fields.get("language", ""), verbose))


def main():
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[1])
    ap.add_argument("--host", default="127.0.0.1")
    ap.add_argument("--port", type=int, default=8880)
    ap.add_argument("--no-stt", action="store_true")
    a = ap.parse_args()
    if a.no_stt:
        os.environ["WHISPER_MODEL"] = "off"
    cfg = os.path.join(PREFIX, "voices.json")
    try:
        with open(cfg) as f:
            DEFAULTS.update({k: v for k, v in json.load(f).items() if k in DEFAULTS and isinstance(v, str)})
    except (OSError, ValueError):
        pass
    srv = ThreadingHTTPServer((a.host, a.port), Handler)
    sys.stderr.write("voice server on http://%s:%d (voices: %s)\n" % (a.host, a.port, ", ".join(installed_voices()) or "none"))
    srv.serve_forever()


if __name__ == "__main__":
    main()
