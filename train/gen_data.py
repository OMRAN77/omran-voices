"""Makes training data for one voice of the light model (Piper).

Audar-TTS Flash (Arabic-first, AudarAI Open License: commercial use allowed) reads formal Arabic
(fusha) sentences in a donor's voice, from that donor's short sample (about 14 seconds); every clip
that passes the length check below is kept. It runs on Kaggle's free GPU (the Transformers weights
of the official reference code, github.com/AudarAI/Audar-TTS-V1), inside train/omran-voices-piper.ipynb.
Its GGUF build on llama.cpp ran on the processor there: ~30 sentences in two hours.

Why Audar and fusha: the first teacher (Chatterbox, Gulf sentences) and two other engines all came
out with a foreign accent to the owner's ear; Audar reading vowelled fusha was "a clear improvement".

  python gen_data.py --ref ref_m.wav --speaker m --part 0 --count 700 \
      --sentences sentences.json --vowelled vowelled.json --out data [--max-minutes 150]

vowelled.json maps a sentence id to the same sentence with full diacritics (Piper's own
diacritizer, see prep_train.py): the engine reads exactly the vowels Piper will later be given.
Writes data/wav/<speaker>_<sentence id>.wav (22 050 Hz mono 16-bit, what Piper trains on) and
appends "<file>\t<text>" to data/<speaker>.tsv (the sentence as written). A sentence refused twice
by the length check goes to data/<speaker>.rejected. Run it again and it continues: a sentence in
either file is skipped.
"""
import argparse
import json
import random
import re
import sys
import time
import wave
from pathlib import Path

SR_OUT = 22050
WORDS_MIN, WORDS_MAX, CHARS_MAX = 5, 15, 200
SHARE = {'msa': 1.0}  # formal Arabic only
AUDAR_REPO = 'audarai/Audar-TTS-V1-Flash'
CODEC_REPO = 'neuphonic/neucodec'  # gated: accept its terms once on Hugging Face
CODEC_SR = 24000
MAX_CODES = 1500  # 50 codes a second: 30 s, far more than a sentence (the reference code's limit)
PAD_ID = 151643   # the backbone's pad token (as in the reference code)


# --- which sentences ----------------------------------------------------------------------------
def select(rows, count, part, seed=2026):
    """`count` formal-Arabic sentences of 5-15 words for voice number `part`. The same seed
    shuffles once, and each voice takes its own slice, so two voices never read the same
    sentence and a re-run picks the same ones."""
    by_reg = {}
    for row in rows:
        sid, text, reg = row[0], str(row[1]), row[2]
        if reg not in SHARE or len(text) > CHARS_MAX or '|' in text or '\t' in text:
            continue
        if not WORDS_MIN <= len(text.split()) <= WORDS_MAX:
            continue
        by_reg.setdefault(reg, []).append((sid, text, reg))
    out = []
    for reg, share in SHARE.items():
        pool = sorted(by_reg.get(reg, []))
        random.Random(f'{seed}-{reg}').shuffle(pool)
        n = round(count * share)
        out += pool[part * n:(part + 1) * n]
    return out


# --- the engine's prompt ------------------------------------------------------------------------
def prompt(ref_codes, text, ref_text=''):
    """Audar's voice-cloning prompt (the format of its model card): the reference speech as codec
    codes, then the sentence; the model answers with the sentence's codes."""
    speech = ''.join(f'<|speech_{c}|>' for c in ref_codes)
    return ('user: Convert the text to speech:'
            f'<|REF_TEXT_START|>{ref_text}<|REF_TEXT_END|>'
            f'<|REF_SPEECH_START|>{speech}<|REF_SPEECH_END|>'
            f'<|TARGET_TEXT_START|>{text}<|TARGET_TEXT_END|>'
            '\nassistant:<|TARGET_CODES_START|>')


def speech_codes(generated):
    return [int(x) for x in re.findall(r'<\|speech_(\d+)\|>', generated)]


# --- is this clip good enough to learn from? ----------------------------------------------------
def letters(text):
    return sum(1 for ch in text if ch.isalpha())


def accept(seconds, text):
    """The engine sometimes stops early or keeps babbling after the sentence. Spoken Arabic runs
    about 0.06-0.09 s per letter: far outside that, the clip is not the sentence."""
    n = letters(text)
    if not n or not 1.0 <= seconds <= 15.0:
        return False
    return 0.035 <= seconds / n <= 0.17


def to_int16(samples):
    import numpy as np
    y = np.asarray(samples, dtype=np.float32)
    peak = float(np.max(np.abs(y))) if y.size else 0.0
    if peak > 0:
        y = y * (0.89 / peak)  # -1 dBFS
    return (np.clip(y, -1, 1) * 32767).astype('<i2').tobytes()


def write_wav(path, pcm16, sr=SR_OUT):
    with wave.open(str(path), 'wb') as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(sr)
        w.writeframes(pcm16)


def done_ids(tsv):
    if not tsv.exists():
        return set()
    return {line.split('\t', 1)[0] for line in tsv.read_text(encoding='utf-8').splitlines() if line}


# --- the engine ---------------------------------------------------------------------------------
class Audar:
    """The reference code's path: the Transformers backbone on the GPU, the neucodec codec."""

    def __init__(self, ref_wav):
        import os
        import librosa
        import torch
        from neucodec import NeuCodec
        from transformers import AutoModelForCausalLM, AutoTokenizer
        self.torch = torch
        self.dev = 'cuda' if torch.cuda.is_available() else 'cpu'
        # float32: a T4 has no bfloat16 (the reference code's type), and the model is small (0.55 B)
        self.tok = AutoTokenizer.from_pretrained(AUDAR_REPO, subfolder='transformers')
        self.model = AutoModelForCausalLM.from_pretrained(AUDAR_REPO, subfolder='transformers',
                                                          torch_dtype=torch.float32).eval().to(self.dev)
        self.codec = NeuCodec.from_pretrained(CODEC_REPO, token=os.environ.get('HF_TOKEN')).eval().to(self.dev)
        self.end = self.tok.convert_tokens_to_ids('<|TARGET_CODES_END|>')
        print('engine on', self.dev, flush=True)
        y, _ = librosa.load(ref_wav, sr=16000, mono=True)
        with torch.no_grad():
            self.ref = self.codec.encode_code(torch.from_numpy(y)[None, None, :].to(self.dev)).squeeze().tolist()

    def say(self, text, seed):
        """24 kHz samples, or None when no speech came out."""
        torch = self.torch
        torch.manual_seed(seed)
        ids = self.tok.encode(prompt(self.ref, text), add_special_tokens=False, return_tensors='pt').to(self.dev)
        with torch.no_grad():
            out = self.model.generate(ids, max_new_tokens=MAX_CODES, eos_token_id=self.end, pad_token_id=PAD_ID,
                                      do_sample=True, temperature=1.0, top_k=40, top_p=0.9, repetition_penalty=1.1,
                                      min_new_tokens=50)
        codes = speech_codes(self.tok.decode(out[0, ids.shape[1]:], skip_special_tokens=False))
        if not codes:
            return None
        with torch.no_grad():
            return self.codec.decode_code(torch.tensor(codes, device=self.dev)[None, None, :]).cpu().numpy()[0, 0]


def main(argv=None):
    ap = argparse.ArgumentParser()
    ap.add_argument('--ref', required=True)
    ap.add_argument('--speaker', required=True)
    ap.add_argument('--part', type=int, required=True)
    ap.add_argument('--count', type=int, default=700)
    ap.add_argument('--sentences', required=True)
    ap.add_argument('--vowelled', required=True)
    ap.add_argument('--out', required=True)
    ap.add_argument('--max-minutes', type=float, default=0)
    a = ap.parse_args(argv)

    import librosa

    out = Path(a.out)
    (out / 'wav').mkdir(parents=True, exist_ok=True)
    tsv = out / (a.speaker + '.tsv')
    rej = out / (a.speaker + '.rejected')
    have = done_ids(tsv) | done_ids(rej)
    vowelled = json.loads(Path(a.vowelled).read_text(encoding='utf-8'))
    todo = [s for s in select(json.loads(Path(a.sentences).read_text(encoding='utf-8')), a.count, a.part)
            if f'{a.speaker}_{s[0]}.wav' not in have]
    print(f'[{a.speaker}] {len(have)} clips already, {len(todo)} to make', flush=True)

    engine = Audar(a.ref)
    t0 = time.time()
    kept = rejected = 0
    with tsv.open('a', encoding='utf-8') as log, rej.open('a', encoding='utf-8') as rejlog:
        for i, (sid, text, reg) in enumerate(todo, 1):
            name = f'{a.speaker}_{sid}.wav'
            if a.max_minutes and time.time() - t0 > a.max_minutes * 60:
                print(f'[{a.speaker}] time is up, stopping', flush=True)
                break
            ok = False
            for attempt in range(2):  # one retry with another seed
                y = engine.say(vowelled.get(str(sid), text), seed=sid * 10 + attempt)
                if y is None:
                    continue
                y, _ = librosa.effects.trim(y, top_db=40)
                if accept(len(y) / CODEC_SR, text):
                    ok = True
                    break
            if not ok:
                rejected += 1
                rejlog.write(name + '\n')
                rejlog.flush()
                continue
            y = librosa.resample(y, orig_sr=CODEC_SR, target_sr=SR_OUT)
            write_wav(out / 'wav' / name, to_int16(y))
            log.write(f'{name}\t{text}\n')
            log.flush()
            kept += 1
            if i % 25 == 0:
                print(f'[{a.speaker}] {i}/{len(todo)}  kept {kept}  rejected {rejected}  {round((time.time() - t0) / 60)} min', flush=True)
    print(f'[{a.speaker}] finished: kept {kept}, rejected {rejected}', flush=True)
    return 0


if __name__ == '__main__':
    sys.exit(main())
