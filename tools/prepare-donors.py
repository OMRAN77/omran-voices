"""Prepares donated voices for the site (run on the owner's PC, never on the server).

For every row of donors.csv that says the person agreed (consent = yes):
  1. decode the file (any format ffmpeg reads), mono;
  2. reject it if it is noisy (speech-to-noise below --min-snr dB) or if more than one
     person speaks in it (speaker embeddings that do not match the file's main voice);
  3. pick the cleanest 15 seconds of speech, cut the silence at both ends,
     set the level (speech RMS -20 dBFS, peak at most -1 dBFS);
  4. write v<N>.wav (24 kHz mono 16-bit) and voices.json into --out.
Upload the whole --out folder to the PRIVATE Hugging Face dataset (see README).
Names never go to GitHub: they live only in voices.json inside the private dataset.

donors.csv (UTF-8, one row per file):
  file,name,gender,consent
  ahmed.m4a,<full name>,ريال,yes

Needs: ffmpeg, faster-whisper (VAD), resemblyzer, soundfile, numpy.
Console output is English (the owner's terminal does not show Arabic).
"""
import argparse
import csv
import json
import os
import subprocess
import sys

import numpy as np
import soundfile as sf
from faster_whisper.vad import VadOptions, get_speech_timestamps
from resemblyzer import VoiceEncoder

OUT_RATE = 24000
AN_RATE = 16000
FRAME = 0.02  # seconds per loudness frame


def decode(ffmpeg, path, rate):
    raw = subprocess.run(
        [ffmpeg, "-v", "error", "-i", path, "-ac", "1", "-ar", str(rate), "-f", "f32le", "-"],
        check=True, capture_output=True).stdout
    return np.frombuffer(raw, dtype=np.float32).copy()


def frame_rms(x, rate):
    n = int(rate * FRAME)
    k = len(x) // n
    if k == 0:
        return np.zeros(0)
    return np.sqrt(np.mean(x[: k * n].reshape(k, n) ** 2, axis=1) + 1e-12)


def speech_mask(x, rate):
    segs = get_speech_timestamps(x, VadOptions(min_silence_duration_ms=300, speech_pad_ms=60))
    n = int(rate * FRAME)
    mask = np.zeros(len(x) // n, dtype=bool)
    for s in segs:
        mask[s["start"] // n: max(s["start"] // n + 1, s["end"] // n)] = True
    return mask, segs


def db(v):
    return 20 * np.log10(max(v, 1e-9))


def speaker_check(encoder, x, mask, rate, threshold):
    """Splits the file's 1.6 s speech windows into the two most different groups.
    One person: the two groups still sound alike (similarity ~0.9). Two people: they
    do not (~0.6 on our test file). Returns (one_person, groups_similarity)."""
    n = int(rate * FRAME)
    win, hop = int(1.6 * rate), int(0.8 * rate)
    embs = []
    for start in range(0, max(1, len(x) - win), hop):
        f0, f1 = start // n, (start + win) // n
        if f1 > len(mask) or mask[f0:f1].mean() < 0.8:
            continue
        embs.append(encoder.embed_utterance(x[start:start + win]))
    if len(embs) < 4:
        return True, 1.0
    e = np.array(embs)
    i, j = np.unravel_index(np.argmin(e @ e.T), (len(e), len(e)))  # start from the two most different windows
    c = np.stack([e[i], e[j]])
    for _ in range(20):
        lab = np.argmax(e @ c.T, axis=1)
        for k in (0, 1):
            if (lab == k).any():
                m = e[lab == k].mean(axis=0)
                c[k] = m / np.linalg.norm(m)
    between = float(c[0] @ c[1])
    smaller = int(min((lab == 0).sum(), (lab == 1).sum()))
    # a single odd window (a cough, a laugh) is not another person: need 2+ windows (2.4 s)
    return not (between < threshold and smaller >= 2), between


def best_window(x, mask, rms, noise, rate, seconds):
    n = int(rate * FRAME)
    need = int(seconds / FRAME)
    if len(mask) <= need:
        return 0, len(x), float(mask.mean()) if len(mask) else 0.0
    best, best_score = None, -1.0
    for f0 in range(0, len(mask) - need, 5):  # every 0.1 s
        if not mask[f0]:
            continue
        m = mask[f0:f0 + need]
        cover = m.mean()
        if cover < 0.7:
            continue
        seg = x[f0 * n:(f0 + need) * n]
        if np.mean(np.abs(seg) > 0.99) > 0.001:  # clipped
            continue
        snr = db(np.median(rms[f0:f0 + need][m]) / noise)
        score = 0.5 * cover + 0.5 * min(snr, 40) / 40
        if score > best_score:
            best, best_score = (f0, f0 + need, float(cover)), score
    if not best:
        return None, None, 0.0
    f0, f1, cover = best
    # end at the last quiet frame in the final 2 s, so the clip does not stop mid-word
    # (by loudness: the VAD merges the short gaps between words)
    quiet = max(noise * 3, np.median(rms[f0:f1]) * 0.1)
    pauses = [f for f in range(max(f0, f1 - 100), f1) if rms[f] < quiet]
    if pauses:
        f1 = pauses[-1] + 1
    return f0 * n, f1 * n, cover


def trim_and_level(y, rate):
    rms = frame_rms(y, rate)
    if not len(rms):
        return y
    thr = max(0.01, rms.max() * 0.05)
    loud = np.where(rms > thr)[0]
    n = int(rate * FRAME)
    pad = int(0.15 * rate)
    y = y[max(0, loud[0] * n - pad): min(len(y), (loud[-1] + 1) * n + pad)]
    speech = frame_rms(y, rate)
    level = np.median(speech[speech > thr]) if (speech > thr).any() else speech.max()
    y = y * (10 ** (-20 / 20) / max(level, 1e-6))
    peak = np.abs(y).max()
    if peak > 10 ** (-1 / 20):
        y = y * (10 ** (-1 / 20) / peak)
    return y


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--in", dest="src", required=True, help="folder with the donors' files")
    ap.add_argument("--list", required=True, help="donors.csv")
    ap.add_argument("--out", required=True, help="output folder (upload it to the private dataset)")
    ap.add_argument("--ffmpeg", default="ffmpeg")
    ap.add_argument("--seconds", type=float, default=15.0)
    ap.add_argument("--min-seconds", type=float, default=10.0)
    ap.add_argument("--min-snr", type=float, default=20.0)
    ap.add_argument("--same-voice", type=float, default=0.80, help="if the file's two most different voice groups are less alike than this, it has another person")
    a = ap.parse_args()

    os.makedirs(a.out, exist_ok=True)
    encoder = VoiceEncoder("cpu", verbose=False)
    voices, report = [], []
    with open(a.list, encoding="utf-8-sig", newline="") as f:
        rows = list(csv.DictReader(f))
    for i, row in enumerate(rows, 1):
        file = (row.get("file") or "").strip()
        name = (row.get("name") or "").strip()
        gender = {"ريال": "m", "رجال": "m", "m": "m", "male": "m", "حرمة": "f", "امرأة": "f", "f": "f", "female": "f"}.get((row.get("gender") or "").strip().lower(), "")
        rec = {"file": file, "row": i}
        def reject(why, **more):
            rec.update(ok=False, reason=why, **more)
            report.append(rec)
            print(f"REJECTED  row {i}  {file}: {why}", flush=True)
        if (row.get("consent") or "").strip().lower() not in ("yes", "نعم", "y"):
            reject("no consent in donors.csv")
            continue
        if not name or not gender:
            reject("name or gender missing in donors.csv")
            continue
        path = os.path.join(a.src, file)
        if not os.path.isfile(path):
            reject("file not found")
            continue
        try:
            x = decode(a.ffmpeg, path, AN_RATE)
        except subprocess.CalledProcessError:
            reject("ffmpeg could not read the file")
            continue
        mask, _ = speech_mask(x, AN_RATE)
        rms = frame_rms(x, AN_RATE)
        mask = mask[: len(rms)]
        speech_s = mask.sum() * FRAME
        if speech_s < a.min_seconds:
            reject(f"only {speech_s:.1f}s of speech (need {a.min_seconds:.0f}s)", speech_seconds=round(speech_s, 1))
            continue
        quiet = rms[~mask]
        noise = np.percentile(quiet, 20) if len(quiet) > 25 else np.percentile(rms, 5)
        snr = db(np.median(rms[mask]) / max(noise, 1e-5))
        rec["snr_db"] = round(float(snr), 1)
        if snr < a.min_snr:
            reject(f"noisy: speech is only {snr:.1f} dB above the background (need {a.min_snr:.0f})", snr_db=round(float(snr), 1))
            continue
        one, alike = speaker_check(encoder, x, mask, AN_RATE, a.same_voice)
        rec["same_voice"] = round(alike, 3)
        if not one:
            reject(f"more than one person (voice groups only {alike:.2f} alike, need {a.same_voice:.2f})", same_voice=round(alike, 3))
            continue
        s0, s1, cover = best_window(x, mask, rms, noise, AN_RATE, a.seconds)
        if s0 is None:
            reject("no clean stretch of speech long enough")
            continue
        y = decode(a.ffmpeg, path, OUT_RATE)
        y = trim_and_level(y[int(s0 * OUT_RATE / AN_RATE): int(s1 * OUT_RATE / AN_RATE)], OUT_RATE)
        vid = f"v{len(voices) + 1}"
        out_file = vid + ".wav"
        sf.write(os.path.join(a.out, out_file), y, OUT_RATE, subtype="PCM_16")
        secs = round(len(y) / OUT_RATE, 1)
        voices.append({"id": vid, "name": name.split()[0], "gender": gender, "file": out_file, "consent": True,
                       "seconds": secs, "snr_db": round(float(snr), 1)})
        rec.update(ok=True, id=vid, seconds=secs, start_s=round(s0 / AN_RATE, 1), speech_cover=round(cover, 2))
        report.append(rec)
        print(f"OK        row {i}  {file} -> {out_file}  {secs}s  snr {snr:.1f} dB  same voice {alike:.2f}", flush=True)

    with open(os.path.join(a.out, "voices.json"), "w", encoding="utf-8") as f:
        json.dump(voices, f, ensure_ascii=False, indent=1)
    with open(os.path.join(a.out, "report.json"), "w", encoding="utf-8") as f:
        json.dump(report, f, ensure_ascii=False, indent=1)
    print(f"\n{len(voices)} voice(s) ready, {len(report) - len(voices)} rejected. Files in {a.out}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
