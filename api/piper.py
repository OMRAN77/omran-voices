"""POST /api/piper  {"text": "...", "voice": "m" | "f"}  ->  audio/wav (22 050 Hz mono)

The two light voices (Piper, formal Arabic: donors v5 and v4, trained in train/) inside this site:
a Python function next to the Node ones, on the same free Vercel project. Hugging Face wants a paid
account for any Gradio or Docker Space now (402 for the setup notebook, public or private), and this
needs no server of its own to set up or keep awake.

Only api/_piper.js calls it, with the header X-Piper-Key: an HMAC of the site's HF_TOKEN, so it needs
no setting of its own and the token itself never travels. The models are read from the private repo
omran77/omran-voices-piper with that token into /tmp (about 60 MB each, once per instance) and kept
while the instance lives. MODEL_DIR (a local folder with the same files) replaces the repo for tests.

The owner gave the first version 6/10: wrong vowels, sentences run together. So the text is vowelled
first by CATT (Abjad AI, Apache-2.0, encoder-only, its released ONNX checked by SHA-256), which got
right what Piper's own diacritizer got wrong (الكتاب not الكتّاب, العِلم not العَلَم, أَشرَح not أُشرِح);
Piper keeps those marks and fills any it left out. And each sentence is followed by a short pause:
Piper writes them back to back. If CATT cannot be fetched, Piper's own diacritics are used.
"""
import hashlib
import hmac
import io
import json
import os
import re
import threading
import time
import wave
import zipfile
from http.server import BaseHTTPRequestHandler

REPO = 'omran77/omran-voices-piper'
FILES = {'m': 'ar_AE-omran_m_fusha-medium.onnx', 'f': 'ar_AE-omran_f_fusha-medium.onnx'}
MAX_CHARS = 1200  # the app sends pieces of ~300 characters; this only stops abuse
MAX_BODY = 16 * 1024
SENTENCE_PAUSE = 0.35  # seconds of silence between sentences
CATT_URL = 'https://github.com/abjadai/catt/releases/download/v2/eo_model_onnx.zip'
CATT_SHA256 = '5343bfdfda70c981b587811b79348b8dde91f65c0a551ca98f232ea5cb62ceac'

voices = {}
lock = threading.Lock()

# CATT's alphabet (Buckwalter letters) and its 18 output tags, as in the model's own tokenizer
AR = dict(zip('ءآأؤإئابةتثجحخدذرزسشصضطظعغفقكلمنهوىي', "'|>&<}AbptvjHxd*rzs$SDTZEgfqklmnhwYy"))
LETTERS = ['<PAD>', '<BOS>', '<EOS>', ' ', '$', '&', "'", '*', '<', '>', 'A', 'D', 'E', 'H', 'S', 'T', 'Y', 'Z',
           'b', 'd', 'f', 'g', 'h', 'j', 'k', 'l', 'm', 'n', 'p', 'q', 'r', 's', 't', 'v', 'w', 'x', 'y', 'z', '|', '}',
           '<MASK>']
TAGS = ['<PAD>', '<BOS>', '<EOS>', '<NT>', '<SD>', '<SDD>', '<SF>', '<SFF>', '<SK>', '<SKK>',
        'F', 'K', 'N', 'a', 'i', 'o', 'u', '~']
MARKS = {'F': 'ً', 'N': 'ٌ', 'K': 'ٍ', 'a': 'َ', 'u': 'ُ', 'i': 'ِ', '~': 'ّ',
         'o': 'ْ', '<SD>': 'ُّ', '<SDD>': 'ٌّ', '<SF>': 'َّ',
         '<SFF>': 'ًّ', '<SK>': 'ِّ', '<SKK>': 'ٍّ'}
LETTER_ID = {c: i for i, c in enumerate(LETTERS)}
HARAKAT = re.compile('[ً-ْـٰ]')
NOT_ARABIC = re.compile('[^' + ''.join(AR) + ']')


class Catt:
    def __init__(self, folder):
        import onnxruntime as ort
        self.enc = ort.InferenceSession(os.path.join(folder, 'encoder.onnx'), providers=['CPUExecutionProvider'])
        self.dec = ort.InferenceSession(os.path.join(folder, 'decoder.onnx'), providers=['CPUExecutionProvider'])

    def tags(self, words):
        import numpy as np
        ids = np.array([[LETTER_ID[' '] if c == ' ' else LETTER_ID[AR[c]] for c in words]], dtype=np.int64)
        mask = np.ones((1, 1, ids.shape[1], ids.shape[1]), dtype=bool)
        logits = self.dec.run(None, {'enc_src': self.enc.run(None, {'src': ids, 'src_mask': mask})[0]})[0]
        return [TAGS[i] for i in logits[0].argmax(-1)]

    def sentence(self, text):
        # the model reads the Arabic words only; its marks go back on the same letters, everything else stays
        bare = HARAKAT.sub('', text)
        words = ' '.join(NOT_ARABIC.sub(' ', bare).split())
        if not words:
            return bare
        marks = iter([t for c, t in zip(words, self.tags(words)) if c != ' '])
        return ''.join(c + MARKS.get(next(marks, ''), '') if c in AR else c for c in bare)

    def __call__(self, text):  # a sentence at a time, as it was trained
        return ''.join(self.sentence(p) for p in re.split(r'([.!?؟]+)', text))


catt_state = {'model': None, 'failed_at': 0.0}


def catt():
    # the released model, fetched once per instance; after a failure, tried again ten minutes later
    with lock:
        if catt_state['model'] or time.time() - catt_state['failed_at'] < 600:
            return catt_state['model']
        try:
            folder = os.environ.get('CATT_DIR') or '/tmp/catt'
            if not os.path.exists(os.path.join(folder, 'encoder.onnx')):
                import urllib.request
                with urllib.request.urlopen(CATT_URL, timeout=60) as r:
                    data = r.read()
                if hashlib.sha256(data).hexdigest() != CATT_SHA256:
                    raise ValueError('the CATT download does not match its checksum')
                zipfile.ZipFile(io.BytesIO(data)).extractall(folder, members=['encoder.onnx', 'decoder.onnx'])
            catt_state['model'] = Catt(folder)
        except Exception as e:  # Piper's own diacritics still work
            print('catt failed:', type(e).__name__, str(e)[:300])
            catt_state['failed_at'] = time.time()
        return catt_state['model']


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
            voices[spk] = PiperVoice.load(model)  # Arabic: Piper adds any diacritics still missing (as in training)
        return voices[spk]


def speak(voice, text):
    vowel = catt()
    if vowel:
        text = vowel(text)
    buf = io.BytesIO()
    with wave.open(buf, 'wb') as w:
        w.setframerate(voice.config.sample_rate)
        w.setsampwidth(2)
        w.setnchannels(1)
        for i, chunk in enumerate(voice.synthesize(text)):  # one chunk per sentence
            if i:
                w.writeframes(bytes(2 * int(voice.config.sample_rate * SENTENCE_PAUSE)))
            w.writeframes(chunk.audio_int16_bytes)
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
