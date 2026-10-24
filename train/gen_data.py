"""Makes training data for one voice of the light model (Piper).

The voice engine the site uses today (Chatterbox, MIT licence) reads our own sentences in a
donor's voice, from that donor's short sample (about 14 seconds); every clip that passes the
checks below is kept. It runs on Kaggle's free GPU, inside train/omran-voices-piper.ipynb.

  python gen_data.py --ref ref_m.wav --speaker m --part 0 --count 700 \
      --sentences sentences.json --dialect dialect.json --out data [--max-minutes 100]

Writes data/wav/<speaker>_<sentence id>.wav (22 050 Hz mono 16-bit, what Piper trains on) and
appends "<file>\t<text>" to data/<speaker>.tsv. The text is the sentence as written (what the app
will send later), not the respelled one the engine reads. A sentence refused twice by the length
check goes to data/<speaker>.rejected. Run it again and it continues: a sentence in either file is
skipped (the same seeds would only make the same refused clip again).
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
SHARE = {'gulf': 0.6, 'ar': 0.2, 'msa': 0.2}

# --- the pronunciation dictionary of api/_dialect.js, same rules -------------------------------
# JS: (?<![\p{L}\p{M}])([وفبلك]?)FROM(?![\p{L}\p{M}]). Python's re has no \p{..}: a letter is
# [^\W\d_], and the Arabic marks (harakat, superscript alef) are listed by code point.
_NOT_AFTER = r'(?<![^\W\d_])(?<![ؐ-ًؚ-ٰٟۖ-ۭ])'
_NOT_BEFORE = r'(?![^\W\d_])(?![ؐ-ًؚ-ٰٟۖ-ۭ])'


def dialect_rules(pairs):
    """pairs: [[written, spoken], ...], longest first (as api/_dialect.js exports them)."""
    rules = []
    for src, dst in pairs:
        body = r'\s+'.join(re.escape(w) for w in src.split(' '))
        rules.append((re.compile(_NOT_AFTER + '([وفبلك]?)' + body + _NOT_BEFORE), dst))
    return rules


def apply_dialect(text, rules):
    for rx, dst in rules:
        text = rx.sub(lambda m, d=dst: m.group(1) + d, text)
    return text


# --- which sentences ----------------------------------------------------------------------------
def select(rows, count, part, seed=2026):
    """`count` sentences for voice number `part`: 60% Gulf, 20% general Arabic, 20% formal, 5-15
    words. The same seed shuffles once, and each voice takes its own slice, so two voices never
    read the same sentence and a re-run picks the same ones."""
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


def main(argv=None):
    ap = argparse.ArgumentParser()
    ap.add_argument('--ref', required=True)
    ap.add_argument('--speaker', required=True)
    ap.add_argument('--part', type=int, required=True)
    ap.add_argument('--count', type=int, default=700)
    ap.add_argument('--sentences', required=True)
    ap.add_argument('--dialect', required=True)
    ap.add_argument('--out', required=True)
    ap.add_argument('--max-minutes', type=float, default=0)
    a = ap.parse_args(argv)

    import librosa
    import torch
    from chatterbox.mtl_tts import ChatterboxMultilingualTTS

    out = Path(a.out)
    (out / 'wav').mkdir(parents=True, exist_ok=True)
    tsv = out / (a.speaker + '.tsv')
    rej = out / (a.speaker + '.rejected')
    have = done_ids(tsv) | done_ids(rej)
    rules = dialect_rules(json.loads(Path(a.dialect).read_text(encoding='utf-8')))
    todo = [s for s in select(json.loads(Path(a.sentences).read_text(encoding='utf-8')), a.count, a.part)
            if f'{a.speaker}_{s[0]}.wav' not in have]
    print(f'[{a.speaker}] {len(have)} clips already, {len(todo)} to make', flush=True)

    model = ChatterboxMultilingualTTS.from_pretrained(device='cuda' if torch.cuda.is_available() else 'cpu')
    with torch.no_grad():
        model.prepare_conditionals(a.ref, exaggeration=0.5)
    t0 = time.time()
    kept = rejected = 0
    with tsv.open('a', encoding='utf-8') as log, rej.open('a', encoding='utf-8') as rejlog:
        for i, (sid, text, reg) in enumerate(todo, 1):
            name = f'{a.speaker}_{sid}.wav'
            if a.max_minutes and time.time() - t0 > a.max_minutes * 60:
                print(f'[{a.speaker}] time is up, stopping', flush=True)
                break
            spoken = apply_dialect(text, rules)
            ok = False
            for attempt in range(2):  # one retry with another seed
                torch.manual_seed(sid * 10 + attempt)
                wav = model.generate(spoken, language_id='ar', exaggeration=0.5, cfg_weight=0.5, temperature=0.8)
                y = wav.squeeze(0).cpu().numpy()
                y, _ = librosa.effects.trim(y, top_db=40)
                if accept(len(y) / model.sr, text):
                    ok = True
                    break
            if not ok:
                rejected += 1
                rejlog.write(name + '\n')
                rejlog.flush()
                continue
            y = librosa.resample(y, orig_sr=model.sr, target_sr=SR_OUT)
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
