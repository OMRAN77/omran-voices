"""POST /api/piper  {"text": "...", "voice": "m" | "f"}  ->  audio/wav (22 050 Hz mono)

The two light voices (Piper, formal Arabic: donors v5 and v4, trained in train/) inside this site:
a Python function next to the Node ones, on the same free Vercel project. Hugging Face wants a paid
account for any Gradio or Docker Space now (402 for the setup notebook, public or private), and this
needs no server of its own to set up or keep awake.

Only api/_piper.js calls it, with the header X-Piper-Key: an HMAC of the site's HF_TOKEN, so it needs
no setting of its own and the token itself never travels. The models are read from the private repo
omran77/omran-voices-piper with that token into /tmp (about 60 MB each, once per instance) and kept
while the instance lives. MODEL_DIR (a local folder with the same files) replaces the repo for tests.
"""
import hashlib
import hmac
import io
import json
import os
import re
import threading
import wave
from http.server import BaseHTTPRequestHandler

REPO = 'omran77/omran-voices-piper'
FILES = {'m': 'ar_AE-omran_m_fusha-medium.onnx', 'f': 'ar_AE-omran_f_fusha-medium.onnx'}
MAX_CHARS = 1200  # the app sends pieces of ~300 characters; this only stops abuse
MAX_BODY = 16 * 1024

voices = {}
lock = threading.Lock()


def hf_token():
    # same rule as hfToken() in api/_engine.js: invisible marks out, and only a real-looking token
    t = re.sub(r'[\s​-‏‪-‮⁦-⁩﻿]', '', os.environ.get('HF_TOKEN', ''))
    return t if re.fullmatch(r'hf_[A-Za-z0-9]{20,}', t) else ''


def site_key(token):
    return hmac.new(token.encode(), b'omran-voices-piper', hashlib.sha256).hexdigest() if token else ''


def fetch(name, token):
    local = os.environ.get('MODEL_DIR')
    if local:
        return os.path.join(local, name)
    os.environ.setdefault('HF_HOME', '/tmp/hf')  # the only place a function may write
    from huggingface_hub import hf_hub_download
    return hf_hub_download(REPO, name, token=token)


def voice_for(spk, token):
    with lock:  # one download and load per voice, even when two requests arrive together
        if spk not in voices:
            from piper import PiperVoice
            model = fetch(FILES[spk], token)
            fetch(FILES[spk] + '.json', token)
            voices[spk] = PiperVoice.load(model)  # Arabic: Piper adds the diacritics itself (as in training)
        return voices[spk]


def speak(voice, text):
    buf = io.BytesIO()
    with wave.open(buf, 'wb') as w:
        voice.synthesize_wav(text, w)
    return buf.getvalue()


class handler(BaseHTTPRequestHandler):
    def reply(self, code, body, kind='application/json'):
        if kind == 'application/json':
            body = json.dumps(body, ensure_ascii=False).encode()
        self.send_response(code)
        self.send_header('Content-Type', kind)
        self.send_header('Cache-Control', 'no-store')
        self.send_header('Content-Length', str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_POST(self):
        token = hf_token()
        key = site_key(token)
        if not key or not hmac.compare_digest(self.headers.get('X-Piper-Key', '').encode(), key.encode()):
            return self.reply(401, {'error': 'key'})
        size = int(self.headers.get('Content-Length') or 0)
        if not 0 < size <= MAX_BODY:
            return self.reply(400, {'error': 'body'})
        try:
            req = json.loads(self.rfile.read(size))
            text, spk = ' '.join(str(req.get('text', '')).split()), str(req.get('voice', ''))
        except (ValueError, AttributeError):
            return self.reply(400, {'error': 'json'})
        if not text or len(text) > MAX_CHARS:
            return self.reply(400, {'error': 'text'})
        if spk not in FILES:
            return self.reply(404, {'error': 'voice'})
        try:
            voice = voice_for(spk, token)
        except Exception as e:  # the repo, the token's access, or the download: in the owner's Vercel logs
            print('piper model failed:', type(e).__name__, str(e).replace(token, '***')[:300])
            return self.reply(502, {'error': 'model'})
        return self.reply(200, speak(voice, text), 'audio/wav')

    def do_GET(self):
        self.reply(405, {'error': 'POST'})
