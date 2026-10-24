"""Tests for server.py with a fake model (no GPU, no download). Run: python engine-local/test_server.py"""
import base64
import hashlib
import io
import json
import sys
import tempfile
import threading
import unittest
import urllib.error
import urllib.request
import wave
from contextlib import redirect_stdout
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import server  # noqa: E402

KEY = 'k' * 32


def ref_wav():
    buf = io.BytesIO()
    with wave.open(buf, 'wb') as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(24000)
        w.writeframes(b'\x01\x00' * 24000)
    return buf.getvalue()


class FakeEngine:
    name = 'fake'

    def __init__(self):
        self.calls = []

    def speak(self, text, lang, ref_id, ref_path, **args):
        self.calls.append((text, lang, ref_id, Path(ref_path).read_bytes(), args))
        return b'\x00\x10' * 2400, 24000


class ServerTest(unittest.TestCase):
    def setUp(self):
        self.dir = tempfile.TemporaryDirectory()
        self.engine = FakeEngine()
        self.srv = server.make_server(self.engine, KEY, port=0, ref_dir=self.dir.name)
        self.url = 'http://127.0.0.1:%d' % self.srv.server_address[1]
        threading.Thread(target=self.srv.serve_forever, daemon=True).start()

    def tearDown(self):
        self.srv.shutdown()
        self.srv.server_close()
        self.dir.cleanup()

    def call(self, path, body=None, key=KEY):
        data = None if body is None else json.dumps(body).encode()
        req = urllib.request.Request(self.url + path, data=data, method='GET' if body is None else 'POST')
        req.add_header('Content-Type', 'application/json')
        if key is not None:
            req.add_header('X-Engine-Key', key)
        try:
            with urllib.request.urlopen(req, timeout=10) as r:
                return r.status, r.headers.get('Content-Type'), r.read()
        except urllib.error.HTTPError as e:
            return e.code, e.headers.get('Content-Type'), e.read()

    def test_key_is_required(self):
        self.assertEqual(self.call('/health', key=None)[0], 401)
        self.assertEqual(self.call('/health', key='wrong')[0], 401)
        self.assertEqual(self.call('/tts', {'text': 'hi'}, key='wrong')[0], 401)
        self.assertEqual(self.engine.calls, [])
        status, _, body = self.call('/health')
        self.assertEqual(status, 200)
        self.assertEqual(json.loads(body)['device'], 'fake')

    def test_voice_sent_once_then_reused(self):
        raw = ref_wav()
        rid = hashlib.sha256(raw).hexdigest()
        status, ctype, body = self.call('/tts', {'text': 'هلا والله', 'lang': 'ar', 'refId': rid, 'refWav': base64.b64encode(raw).decode()})
        self.assertEqual(status, 200)
        self.assertEqual(ctype, 'audio/wav')
        with wave.open(io.BytesIO(body)) as w:
            self.assertEqual((w.getnchannels(), w.getsampwidth(), w.getframerate(), w.getnframes()), (1, 2, 24000, 2400))
        # next piece: only the id
        status, _, _ = self.call('/tts', {'text': 'شحالك', 'lang': 'ar', 'refId': rid, 'exaggeration': 9, 'seed': 7})
        self.assertEqual(status, 200)
        self.assertEqual([c[0] for c in self.engine.calls], ['هلا والله', 'شحالك'])
        self.assertEqual(self.engine.calls[1][3], raw)
        self.assertEqual(self.engine.calls[1][4], {'exaggeration': 2, 'temperature': 0.8, 'cfg': 0.5, 'seed': 7})

    def test_unknown_voice_is_410(self):
        status, _, body = self.call('/tts', {'text': 'هلا', 'lang': 'ar', 'refId': 'a' * 64})
        self.assertEqual(status, 410)
        self.assertEqual(json.loads(body)['code'], 'ref_gone')

    def test_wav_must_match_its_id(self):
        raw = ref_wav()
        status, _, _ = self.call('/tts', {'text': 'هلا', 'lang': 'ar', 'refId': 'b' * 64, 'refWav': base64.b64encode(raw).decode()})
        self.assertEqual(status, 400)
        self.assertEqual(list(Path(self.dir.name).iterdir()), [])

    def test_bad_input(self):
        rid = 'c' * 64
        for body in ({'text': '', 'lang': 'ar', 'refId': rid}, {'text': 'x' * 301, 'lang': 'ar', 'refId': rid},
                     {'text': 'hi', 'lang': 'xx', 'refId': rid}, {'text': 'hi', 'lang': 'ar', 'refId': '../x'}):
            self.assertEqual(self.call('/tts', body)[0], 400, body)
        self.assertEqual(self.engine.calls, [])

    def test_engine_error_is_500_json(self):
        def boom(*a, **k):
            raise RuntimeError('CUDA out of memory')
        self.engine.speak = boom
        raw = ref_wav()
        status, _, body = self.call('/tts', {'text': 'هلا', 'lang': 'ar', 'refId': hashlib.sha256(raw).hexdigest(), 'refWav': base64.b64encode(raw).decode()})
        self.assertEqual(status, 500)
        self.assertEqual(json.loads(body)['code'], 'engine')

    def test_old_voice_files_are_pruned(self):
        d = Path(self.dir.name)
        for i in range(5):
            (d / ('%064x.wav' % i)).write_bytes(b'x')
        server.prune_refs(d, keep=3)
        self.assertEqual(len(list(d.glob('*.wav'))), 3)

    def test_key_file_is_made_once(self):
        with tempfile.TemporaryDirectory() as t:
            old = server.KEY_FILE
            server.KEY_FILE = Path(t) / 'engine-key.txt'
            try:
                k1 = server.load_key()
                k2 = server.load_key()
            finally:
                server.KEY_FILE = old
        self.assertEqual(k1, k2)
        self.assertGreaterEqual(len(k1), 32)


class TunnelTest(unittest.TestCase):
    def test_tunnel_address_is_found_in_cloudflared_output(self):
        lines = ['2026-10-24T08:00:00Z INF Requesting new quick Tunnel on trycloudflare.com...',
                 '2026-10-24T08:00:01Z ERR failed to request quick Tunnel: https://api.trycloudflare.com/tunnel',
                 '2026-10-24T08:00:02Z INF |  https://brave-lion-river-sun.trycloudflare.com                    |']
        found = [m.group(0) for m in map(server.TUNNEL_URL.search, lines) if m]
        self.assertEqual(found, ['https://brave-lion-river-sun.trycloudflare.com'])

    def test_register_retries_until_the_site_accepts(self):
        answers = [(500, 'no_key'), (500, 'no_key'), (401, 'key'), (502, 'unreachable'), (0, 'URLError'), (200, None)]
        sent, waits = [], []
        out = io.StringIO()

        def post(url, body, key):
            sent.append((url, json.loads(body), key))
            return answers[len(sent) - 1]
        with redirect_stdout(out):
            ok = server.register('https://a-b.trycloudflare.com', KEY, post=post, wait=waits.append)
        self.assertTrue(ok)
        self.assertEqual(len(sent), 6)
        self.assertEqual(sent[0], (server.SITE + '/api/engine', {'url': 'https://a-b.trycloudflare.com'}, KEY))
        text = out.getvalue()
        self.assertEqual(text.count('OV_ENGINE_KEY yet'), 1)  # the same advice is not repeated
        self.assertIn('engine-key.txt', text)
        self.assertIn('The site knows this PC now', text)
        self.assertNotIn(KEY, text)
        self.assertEqual(waits, [5, 10, 15, 20, 25])

    def test_register_stops_when_a_newer_tunnel_replaced_it(self):
        current = {'url': 'https://old.trycloudflare.com'}

        def post(url, body, key):
            current['url'] = 'https://new.trycloudflare.com'
            return 502, 'unreachable'
        with redirect_stdout(io.StringIO()):
            ok = server.register('https://old.trycloudflare.com', KEY, post=post, wait=lambda s: None, current=lambda: current['url'])
        self.assertFalse(ok)


if __name__ == '__main__':
    unittest.main()
