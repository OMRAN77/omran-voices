"""The two light voices (Piper, formal Arabic) as a small web service, for a free CPU Space on Hugging Face.

  POST /tts   {"text": "...", "voice": "m" | "f"}  ->  audio/wav (22 050 Hz mono)
  GET  /health                                     ->  {"voices": ["f", "m"], "model": {...}}
  POST /reload                                     ->  loads the newest models (after a training run)

The Space is private: Hugging Face only lets in requests that carry a token of the owner
(Authorization: Bearer hf_...), so the service needs no key of its own. The models come from the
private repo omran77/omran-voices-piper with the Space's secret HF_TOKEN (read access is enough).
MODEL_DIR (a local folder with the same files) replaces the repo for local tests.
"""
import io
import os
import threading
import wave
from pathlib import Path

from fastapi import FastAPI, HTTPException
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


app = FastAPI()


@app.on_event('startup')
def startup():
    load()


class Speak(BaseModel):
    text: str
    voice: str


@app.post('/tts')
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


@app.get('/health')
def health():
    with lock:
        return {'voices': sorted(voices), 'model': dict(loaded)}


@app.post('/reload')
def reload():
    # newest files from the repo (hf_hub_download fetches a file again when the repo has a newer one)
    load()
    return health()
