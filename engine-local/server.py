"""The voice engine on the owner's own PC (NVIDIA GPU), so the site does not depend
on the free public demo and its daily limit.

Run start.bat (it installs everything the first time, then starts this file).
The site reaches this PC through a free Cloudflare quick tunnel (no account): this file
opens it, and since its address changes on every start, tells the site the new address
(POST /api/engine with the key). Vercel needs only OV_ENGINE_KEY = the key in
engine-key.txt. When this PC is off, the site falls back to the public demo by itself.
--no-tunnel: no tunnel (when OV_ENGINE_URL in Vercel points here some other way).

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
import shutil
import subprocess
import sys
import threading
import time
import urllib.error
import urllib.request
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
SITE = os.environ.get('ENGINE_SITE', 'https://omran-voices.vercel.app').rstrip('/')
CLOUDFLARED_URL = 'https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-windows-amd64.exe'
TUNNEL_URL = re.compile(r'https://(?!api\.)[a-z0-9-]+\.trycloudflare\.com')


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
            if shutil.which('nvidia-smi'):
                # The card is there but PyTorch cannot use it: almost always an old driver.
                print('PyTorch cannot use the NVIDIA card (usually the driver is too old).')
                print('Update the driver: https://www.nvidia.com/Download/index.aspx then run start.bat again.')
            print('Using the CPU for now (slow).')
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
        self.send_body(status, 'application/json; charset=utf-8', json.dumps(obj, ensure_ascii=False).encode('utf-8'))

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

    def send_body(self, status, ctype, data):
        self.send_response(status)
        self.send_header('Content-Type', ctype)
        self.send_header('Content-Length', str(len(data)))
        self.end_headers()
        self.wfile.write(data)

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
        print(time.strftime('%H:%M:%S'), lang, len(text), 'chars ->', round(len(pcm) / 2 / sr, 1), 's audio in', round(time.time() - t0, 1), 's')
        try:
            self.send_body(200, 'audio/wav', wav_bytes(pcm, sr))
        except ConnectionError:
            print('The site stopped waiting before the voice was ready (too slow).')


def make_server(engine, key, port=PORT, ref_dir=REF_DIR, host='127.0.0.1'):
    ref_dir = Path(ref_dir)
    ref_dir.mkdir(parents=True, exist_ok=True)
    srv = ThreadingHTTPServer((host, port), Handler)
    srv.engine = engine
    srv.key = key
    srv.ref_dir = ref_dir
    srv.lock = threading.Lock()
    return srv


def cloudflared():
    """cloudflared.exe next to this file (downloaded once from Cloudflare's GitHub), or on PATH."""
    found = shutil.which('cloudflared')
    if found:
        return found
    exe = HERE / 'cloudflared.exe'
    if not exe.exists() and os.name == 'nt':
        print('Downloading cloudflared (the free tunnel, about 60 MB)...')
        part = exe.with_suffix('.part')
        try:
            urllib.request.urlretrieve(CLOUDFLARED_URL, part)
            part.replace(exe)
        except OSError as e:
            print('Could not download cloudflared:', e)
    return str(exe) if exe.exists() else None


SITE_SAYS = {
    'no_key': 'Vercel has no OV_ENGINE_KEY yet: put the key from engine-key.txt there, then Redeploy.',
    'key': 'The site refused the key: OV_ENGINE_KEY in Vercel must be exactly the text in engine-key.txt (then Redeploy).',
    'unreachable': 'The site cannot reach this PC yet (the tunnel needs a few seconds).',
    'no_token': 'Vercel has no HF_WRITE_TOKEN: the site cannot save the address.',
}


def register(url, key, post=None, wait=time.sleep, current=lambda: None):
    """Tells the site the tunnel's address, retrying until it accepts (the key may not be in Vercel
    yet). Stops when a newer tunnel replaced this one (current() is another address)."""
    post = post or _post
    body = json.dumps({'url': url}).encode('utf-8')
    last = None
    attempt = 0
    while current() in (None, url):
        attempt += 1
        status, code = post(SITE + '/api/engine', body, key)
        if status == 200:
            print('The site knows this PC now. Voices come from here while this window is open.')
            return True
        msg = SITE_SAYS.get(code) or ('The site is not updated yet (/api/engine missing).' if status == 404 else
                                      'Could not reach the site (%s), trying again.' % (status or code))
        if msg != last:
            print(msg)
            last = msg
        wait(min(60, 5 * attempt))
    return False


def _post(url, body, key):
    req = urllib.request.Request(url, data=body, method='POST',
                                 headers={'Content-Type': 'application/json', 'X-Engine-Key': key})
    try:
        with urllib.request.urlopen(req, timeout=40) as r:
            return r.status, None
    except urllib.error.HTTPError as e:
        try:
            code = json.loads(e.read().decode('utf-8')).get('code')
        except ValueError:
            code = None
        return e.code, code
    except (urllib.error.URLError, OSError) as e:
        return 0, type(e).__name__


def run_tunnel(key, port):
    """Keeps a Cloudflare quick tunnel open to this engine; a new address is registered every time."""
    exe = cloudflared()
    if not exe:
        print('cloudflared not found: the site cannot reach this PC. Run with --no-tunnel if you use another way.')
        return
    newest = {'url': None}
    while True:
        p = subprocess.Popen([exe, 'tunnel', '--no-autoupdate', '--url', 'http://127.0.0.1:%d' % port],
                             stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True, errors='replace')
        seen = False
        for line in p.stdout:
            m = None if seen else TUNNEL_URL.search(line)
            if m:
                seen = True
                newest['url'] = m.group(0)
                print('Tunnel open:', newest['url'])
                threading.Thread(target=register, args=(newest['url'], key),
                                 kwargs={'current': lambda: newest['url']}, daemon=True).start()
        p.wait()
        print('The tunnel closed; opening a new one in 10 seconds...')
        time.sleep(10)


def main():
    key = load_key()
    print('Loading the voice model (the first time it downloads about 3 GB)...')
    engine = Chatterbox()
    srv = make_server(engine, key)
    print()
    print('Voice engine ready on http://127.0.0.1:%d  (%s)' % (PORT, engine.name))
    print('Key for Vercel (OV_ENGINE_KEY) is in: %s' % KEY_FILE)
    print('Keep this window open. Close it to stop the engine.')
    if engine.name == 'cpu':
        print()
        print('No usable GPU: about 2 minutes per sentence, longer than the site waits.')
        print('The site keeps using the public engine while this PC has no GPU.')
    if '--no-tunnel' not in sys.argv:
        threading.Thread(target=run_tunnel, args=(key, srv.server_address[1]), daemon=True).start()
    try:
        srv.serve_forever()
    except KeyboardInterrupt:
        pass


if __name__ == '__main__':
    sys.exit(main())
