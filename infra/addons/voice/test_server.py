"""Tests of the pure parts and of the HTTP layer with a fake Piper — `python3 -m unittest infra/addons/voice/test_server.py` (stdlib only)."""
import json
import os
import stat
import sys
import tempfile
import threading
import unittest
import urllib.request
from http.server import ThreadingHTTPServer

sys.path.insert(0, os.path.dirname(__file__))
import server  # noqa: E402


class Pure(unittest.TestCase):
    def test_script(self):
        self.assertGreater(server.cyrillic_share("Привет, мир"), 0.9)
        self.assertEqual(server.cyrillic_share("Hello"), 0.0)
        self.assertEqual(server.cyrillic_share("123 !?"), 0.0)

    def test_pick_voice(self):
        inst = ["en_US-amy-medium", "ru_RU-irina-medium", "ru_RU-denis-medium"]
        self.assertEqual(server.pick_voice("ru_RU-denis-medium", "Hello", inst), "ru_RU-denis-medium")
        self.assertEqual(server.pick_voice("alloy", "Привет всем", inst), "ru_RU-irina-medium")
        self.assertEqual(server.pick_voice("auto", "Hello all", inst), "en_US-amy-medium")
        self.assertEqual(server.pick_voice("auto", "Привет", ["en_US-amy-medium"]), "en_US-amy-medium")  # no Russian voice: the one there is
        with self.assertRaises(LookupError):
            server.pick_voice("auto", "x", [])

    def test_multipart(self):
        body = (b'--B\r\nContent-Disposition: form-data; name="model"\r\n\r\nwhisper-1\r\n'
                b'--B\r\nContent-Disposition: form-data; name="file"; filename="a.ogg"\r\nContent-Type: audio/ogg\r\n\r\nBINARY\x00\x01\r\n--B--\r\n')
        fields, files = server.parse_multipart("multipart/form-data; boundary=B", body)
        self.assertEqual(fields["model"], "whisper-1")
        self.assertEqual(files["file"], ("a.ogg", b"BINARY\x00\x01"))

    def test_clean_text(self):
        self.assertEqual(server.clean_text("a \n\n b\t c"), "a b c")


class Http(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.tmp = tempfile.mkdtemp()
        vd = os.path.join(cls.tmp, "voices")
        pd = os.path.join(cls.tmp, "piper")
        os.makedirs(vd)
        os.makedirs(pd)
        for v in ("ru_RU-irina-medium", "en_US-amy-medium"):
            open(os.path.join(vd, v + ".onnx"), "w").close()
            open(os.path.join(vd, v + ".onnx.json"), "w").write("{}")
        fake = os.path.join(pd, "piper")  # writes a tiny file at --output_file and records the model
        open(fake, "w").write('#!/bin/sh\nwhile [ $# -gt 0 ]; do case "$1" in --output_file) out="$2";; --model) m="$2";; esac; shift; done\ncat >/dev/null\nprintf "RIFFfake-%s" "$(basename $m)" > "$out"\n')
        os.chmod(fake, os.stat(fake).st_mode | stat.S_IEXEC)
        server.VOICES_DIR, server.PIPER_DIR = vd, pd
        os.environ["WHISPER_MODEL"] = "off"
        cls.srv = ThreadingHTTPServer(("127.0.0.1", 0), server.Handler)
        threading.Thread(target=cls.srv.serve_forever, daemon=True).start()
        cls.base = "http://127.0.0.1:%d" % cls.srv.server_address[1]

    @classmethod
    def tearDownClass(cls):
        cls.srv.shutdown()

    def post(self, path, obj):
        req = urllib.request.Request(self.base + path, data=json.dumps(obj).encode(), headers={"Content-Type": "application/json"})
        return urllib.request.urlopen(req)

    def test_health_and_voices(self):
        j = json.load(urllib.request.urlopen(self.base + "/health"))
        self.assertEqual(j["voices"], ["en_US-amy-medium", "ru_RU-irina-medium"])
        self.assertFalse(j["stt"])

    def test_speech_picks_the_voice_by_script(self):
        r = self.post("/v1/audio/speech", {"model": "x", "input": "Привет, это проверка", "voice": "alloy", "response_format": "wav"})
        self.assertEqual(r.headers["X-Voice"], "ru_RU-irina-medium")
        self.assertEqual(r.headers["Content-Type"], "audio/wav")
        self.assertIn(b"fake-ru_RU-irina-medium.onnx", r.read())
        r = self.post("/v1/audio/speech", {"input": "Hello there", "response_format": "wav"})
        self.assertEqual(r.headers["X-Voice"], "en_US-amy-medium")

    def test_errors_are_json(self):
        with self.assertRaises(urllib.error.HTTPError) as e:
            self.post("/v1/audio/speech", {"input": "  "})
        self.assertEqual(e.exception.code, 400)
        self.assertIn("error", json.loads(e.exception.read()))
        body = b'--B\r\nContent-Disposition: form-data; name="file"; filename="a.ogg"\r\n\r\nx\r\n--B--\r\n'
        req = urllib.request.Request(self.base + "/v1/audio/transcriptions", data=body, headers={"Content-Type": "multipart/form-data; boundary=B"})
        with self.assertRaises(urllib.error.HTTPError) as e2:
            urllib.request.urlopen(req)
        self.assertEqual(e2.exception.code, 501)  # recognition switched off


if __name__ == "__main__":
    unittest.main()
