"""The two light voices (Piper, formal Arabic) as a small web service, for a free CPU Space on Hugging Face.

  POST /tts   {"text": "...", "voice": "m" | "f"}  ->  audio/wav (22 050 Hz mono)
  GET  /health                                     ->  {"voices": ["f", "m"], "model": {...}}
  POST /reload                                     ->  loads the newest models (after a training run)
Each needs the header X-Space-Key: the Space's secret SPACE_KEY (without it every call is refused).

The Space itself is public (a private Space needs a paid account: 402 when the notebook made one),
so this code is public and holds no secret. The models stay in the private repo
omran77/omran-voices-piper, read with the Space's secret HF_TOKEN; the key is made by the setup
notebook, which also gives it to the voices site through its private dataset.
MODEL_DIR (a local folder with the same files) replaces the repo for local tests.
"""
import hmac
import io
import os
import threading
import wave
from pathlib import Path

from fastapi import Depends, FastAPI, Header, HTTPException
from fastapi.responses import Response
from pydantic import BaseModel

REPO = os.environ.get('MODEL_REPO', 'omran77/omran-voices-piper')
FILES = {'m': 'ar_AE-omran_m_fusha-medium.onnx', 'f': 'ar_AE-omran_f_fusha-medium.onnx'}
MAX_CHARS = 1200  # the app sends pieces of ~260 characters; this only stops abuse

voices, loaded = {}, {}
lock = threading.Lock()


def fetch(name):
    local = os.environ.get('MODEL_DIR')
    if local:
        return str(Path(local) / name)
    from huggingface_hub import hf_hub_download
    return hf_hub_download(REPO, name, token=os.environ.get('HF_TOKEN') or None, force_download=False)


def load():
    from piper import PiperVoice
    fresh, info = {}, {}
    for spk, name in FILES.items():
        model = fetch(name)
        fetch(name + '.json')
        fresh[spk] = PiperVoice.load(model)  # Arabic: Piper adds the diacritics itself (as in training)
        info[spk] = {'file': name, 'bytes': Path(model).stat().st_size, 'modified': int(Path(model).stat().st_mtime)}
    with lock:
        voices.clear()
        voices.update(fresh)
        loaded.clear()
        loaded.update(info)


app = FastAPI(docs_url=None, redoc_url=None, openapi_url=None)  # nothing to browse on a public Space


def check_key(x_space_key: str = Header(default='')):
    key = os.environ.get('SPACE_KEY', '')
    if not key or not hmac.compare_digest(x_space_key.encode(), key.encode()):
        raise HTTPException(401, 'key')


@app.get('/')
def root():  # Hugging Face's own check that the app is up: says nothing else
    return {'ok': True}


@app.on_event('startup')
def startup():
    load()


class Speak(BaseModel):
    text: str
    voice: str


@app.post('/tts', dependencies=[Depends(check_key)])
def tts(req: Speak):
    text = ' '.join(req.text.split())
    if not text:
        raise HTTPException(400, 'empty text')
    if len(text) > MAX_CHARS:
        raise HTTPException(400, f'text longer than {MAX_CHARS} characters')
    with lock:
        voice = voices.get(req.voice)
    if voice is None:
        raise HTTPException(404, 'unknown voice: ' + req.voice)
    buf = io.BytesIO()
    with wave.open(buf, 'wb') as w:
        voice.synthesize_wav(text, w)
    return Response(buf.getvalue(), media_type='audio/wav', headers={'Cache-Control': 'no-store'})


@app.get('/health', dependencies=[Depends(check_key)])
def health():
    with lock:
        return {'voices': sorted(voices), 'model': dict(loaded)}


@app.post('/reload', dependencies=[Depends(check_key)])
def reload():
    # newest files from the repo (hf_hub_download fetches a file again when the repo has a newer one)
    load()
    return health()
