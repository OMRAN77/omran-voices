"""The voice engine on the owner's own PC (NVIDIA GPU), so the site does not depend
on the free public demo and its daily limit.

Run start.bat (it installs everything the first time, then starts this file).
The site (api/_engine.js) reaches it through a tunnel (Tailscale Funnel), using
OV_ENGINE_URL and OV_ENGINE_KEY in Vercel. When this PC is off, the site falls
back to the public demo by itself.

  GET  /health  -> {"ok": true, "device": "..."}
  POST /tts     {text, lang, refId, refWav?, exaggeration, temperature, cfg, seed} -> audio/wav
                refId = sha256 of the reference WAV. refWav (base64) is sent only when
                this PC does not have that voice yet (answer 410 = send it again).

Every request needs the header X-Engine-Key = the key in engine-key.txt.
Only the standard library here; the model itself is chatterbox-tts (MIT licence).
Console output is English (the owner's terminal does not show Arabic).
"""
import base64
import hashlib
import hmac
import io
import json
import os
import re
import secrets
import sys
import threading
import time
import wave
from collections import OrderedDict
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

HERE = Path(__file__).resolve().parent
KEY_FILE = HERE / 'engine-key.txt'
REF_DIR = HERE / 'refs'
PORT = int(os.environ.get('ENGINE_PORT', '8800'))
MAX_BODY = 6 * 1024 * 1024
MAX_REF = 3 * 1024 * 1024
MAX_CHARS = 300
MAX_REFS = 300
LANGS = {'ar', 'da', 'de', 'el', 'en', 'es', 'fi', 'fr', 'he', 'hi', 'it', 'ja', 'ko', 'ms', 'nl', 'no', 'pl', 'pt', 'ru', 'sv', 'sw', 'tr', 'zh'}
REF_ID = re.compile(r'^[0-9a-f]{64}$')


def load_key():
    """ENGINE_KEY from the environment, else engine-key.txt (made once, random)."""
    key = os.environ.get('ENGINE_KEY', '').strip()
    if key:
        return key
    if KEY_FILE.exists():
        key = KEY_FILE.read_text(encoding='utf-8').strip()
        if key:
            return key
    key = secrets.token_urlsafe(24)
    KEY_FILE.write_text(key + '\n', encoding='utf-8')
    return key


def wav_bytes(pcm16, sr):
    buf = io.BytesIO()
    with wave.open(buf, 'wb') as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(sr)
        w.writeframes(pcm16)
    return buf.getvalue()


def clamp(v, lo, hi, default):
    try:
        v = float(v)
    except (TypeError, ValueError):
        return default
    if v != v:  # NaN
        return default
    return min(hi, max(lo, v))


class Chatterbox:
    """Chatterbox Multilingual on the GPU. One voice's conditioning is kept in memory,
    so the next pieces in the same voice skip that step."""

    def __init__(self):
        import torch
        from chatterbox.mtl_tts import ChatterboxMultilingualTTS
        self.torch = torch
        self.device = 'cuda' if torch.cuda.is_available() else 'cpu'
        if self.device == 'cuda':
            try:
                (torch.zeros(1, device='cuda') + 1).item()
            except Exception as e:  # a GPU this PyTorch build does not support
                print('GPU not usable by this PyTorch (' + str(e).splitlines()[0] + '), using the CPU (slow).')
                self.device = 'cpu'
        else:
            print('No NVIDIA GPU found by PyTorch: using the CPU (slow).')
        self.name = torch.cuda.get_device_name(0) if self.device == 'cuda' else 'cpu'
        self.model = ChatterboxMultilingualTTS.from_pretrained(device=self.device)
        self.sr = self.model.sr
        self.conds = OrderedDict()

    def speak(self, text, lang, ref_id, ref_path, exaggeration, temperature, cfg, seed):
        torch = self.torch
        if seed:
            torch.manual_seed(seed)
            if self.device == 'cuda':
                torch.cuda.manual_seed_all(seed)
        conds = self.conds.get(ref_id)
        if conds is None:
            with torch.no_grad():
                self.model.prepare_conditionals(str(ref_path), exaggeration=exaggeration)
            self.conds[ref_id] = self.model.conds
            while len(self.conds) > 16:
                self.conds.popitem(last=False)
        else:
            self.conds.move_to_end(ref_id)
            self.model.conds = conds
        wav = self.model.generate(text, language_id=lang, exaggeration=exaggeration,
                                  cfg_weight=cfg, temperature=temperature)
        pcm = (wav.squeeze(0).clamp(-1, 1).numpy() * 32767).astype('<i2').tobytes()
        return pcm, self.sr


def prune_refs(ref_dir, keep=MAX_REFS):
    files = sorted(ref_dir.glob('*.wav'), key=lambda p: p.stat().st_mtime)
    for p in files[:-keep] if len(files) > keep else []:
        try:
            p.unlink()
        except OSError as e:
            print('could not delete old voice file', p.name, e)


class Handler(BaseHTTPRequestHandler):
    server_version = 'omran-engine'
    sys_version = ''

    def log_message(self, fmt, *args):
        pass  # one line per job is printed below; no request details

    def send_json(self, status, obj):
        data = json.dumps(obj, ensure_ascii=False).encode('utf-8')
        self.send_response(status)
        self.send_header('Content-Type', 'application/json; charset=utf-8')
        self.send_header('Content-Length', str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def authorized(self):
        given = self.headers.get('X-Engine-Key', '').encode('utf-8', 'replace')
        if hmac.compare_digest(given, self.server.key.encode('utf-8')):
            return True
        self.send_json(401, {'error': 'wrong key', 'code': 'key'})
        return False

    def do_GET(self):
        if self.path != '/health':
            return self.send_json(404, {'error': 'not found'})
        if not self.authorized():
            return
        self.send_json(200, {'ok': True, 'device': self.server.engine.name, 'busy': self.server.lock.locked()})

    def do_POST(self):
        if self.path != '/tts':
            return self.send_json(404, {'error': 'not found'})
        if not self.authorized():
            return
        try:
            length = int(self.headers.get('Content-Length') or 0)
        except ValueError:
            length = 0
        if length <= 0 or length > MAX_BODY:
            return self.send_json(413, {'error': 'body size', 'code': 'input'})
        try:
            b = json.loads(self.rfile.read(length).decode('utf-8'))
            if not isinstance(b, dict):
                raise ValueError('not an object')
        except ValueError:
            return self.send_json(400, {'error': 'bad json', 'code': 'input'})

        text = str(b.get('text') or '').strip()
        lang = str(b.get('lang') or '')
        ref_id = str(b.get('refId') or '')
        if not text or len(text) > MAX_CHARS:
            return self.send_json(400, {'error': 'text length', 'code': 'input'})
        if lang not in LANGS:
            return self.send_json(400, {'error': 'language', 'code': 'input'})
        if not REF_ID.match(ref_id):
            return self.send_json(400, {'error': 'refId', 'code': 'input'})

        ref_path = self.server.ref_dir / (ref_id + '.wav')
        if b.get('refWav'):
            try:
                raw = base64.b64decode(str(b['refWav']), validate=True)
            except ValueError:
                return self.send_json(400, {'error': 'refWav', 'code': 'input'})
            if not 1000 <= len(raw) <= MAX_REF or hashlib.sha256(raw).hexdigest() != ref_id:
                return self.send_json(400, {'error': 'refWav', 'code': 'input'})
            if not ref_path.exists():
                ref_path.write_bytes(raw)
                prune_refs(self.server.ref_dir)
        elif not ref_path.exists():
            return self.send_json(410, {'error': 'voice not on this PC', 'code': 'ref_gone'})

        args = dict(
            exaggeration=clamp(b.get('exaggeration'), 0.25, 2, 0.5),
            temperature=clamp(b.get('temperature'), 0.05, 2, 0.8),
            cfg=clamp(b.get('cfg'), 0.2, 1, 0.5),
            seed=int(clamp(b.get('seed'), 0, 2 ** 31, 0)),
        )
        t0 = time.time()
        try:
            with self.server.lock:  # one GPU: one job at a time
                pcm, sr = self.server.engine.speak(text, lang, ref_id, ref_path, **args)
        except Exception as e:
            print('job failed:', type(e).__name__, str(e)[:200])
            return self.send_json(500, {'error': type(e).__name__ + ': ' + str(e)[:200], 'code': 'engine'})
        data = wav_bytes(pcm, sr)
        print(time.strftime('%H:%M:%S'), lang, len(text), 'chars ->', round(len(pcm) / 2 / sr, 1), 's audio in', round(time.time() - t0, 1), 's')
        self.send_response(200)
        self.send_header('Content-Type', 'audio/wav')
        self.send_header('Content-Length', str(len(data)))
        self.end_headers()
        self.wfile.write(data)


def make_server(engine, key, port=PORT, ref_dir=REF_DIR, host='127.0.0.1'):
    ref_dir = Path(ref_dir)
    ref_dir.mkdir(parents=True, exist_ok=True)
    srv = ThreadingHTTPServer((host, port), Handler)
    srv.engine = engine
    srv.key = key
    srv.ref_dir = ref_dir
    srv.lock = threading.Lock()
    return srv


def main():
    key = load_key()
    print('Loading the voice model (the first time it downloads about 3 GB)...')
    engine = Chatterbox()
    srv = make_server(engine, key)
    print()
    print('Voice engine ready on http://127.0.0.1:%d  (%s)' % (PORT, engine.name))
    print('Key for Vercel (OV_ENGINE_KEY) is in: %s' % KEY_FILE)
    print('Keep this window open. Close it to stop the engine.')
    try:
        srv.serve_forever()
    except KeyboardInterrupt:
        pass


if __name__ == '__main__':
    sys.exit(main())
