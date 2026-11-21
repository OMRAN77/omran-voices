"""One person's real recordings -> Piper training data (the owner, 21 Nov: «خاص لي انا من البنت والرجل»).

  python prep_real.py transcribe --rec rec --sentences sentences.json --out words.json
  python prep_real.py cut --rec rec --words words.json --sentences sentences.json --speaker saif --out data
  python prep_real.py list --data data --speaker saif --out data/saif.csv

rec/ holds one speaker's folder of the private recordings dataset: b…/…wav with metadata.jsonl
(api/_recordings.js). Two kinds of recording are in it:
  - one sentence, its text known (the «جملة جملة» way);
  - a piece of a continuous take («تسجيل متواصل», free: true): the person read down a list or just
    talked, so there is no text, only the sentences that were on screen (prompt_ids).

transcribe: Whisper writes every recording as words with their times.
cut: the words become utterances of 1.5–12 s, cut at the pauses; an utterance that is one of the
  sentences on screen takes that sentence's spelling (Whisper misspells dialect words); a clip whose
  length does not fit its text, or that Whisper was unsure of, is left out. Clips are 22 050 Hz.
list: Piper's training list, each text with the diacritics and the pausal endings the site will
  give this voice when it speaks (the same code: piper_fn.py is the site's api/piper.py).

Gulf speech stops on each word (اليوم، مب اليومُ): the diacritizer adds formal case endings that the
recordings do not have, so the last letter of each word gets a sukun (pausal), in training and later
in the site alike. Then the model hears what its text says.
"""
import argparse
import difflib
import json
import re
import sys
import wave
from pathlib import Path

SR_OUT = 22050
MIN_SEC, MAX_SEC = 1.5, 12.0
GAP_SPLIT = 0.35        # a pause this long ends an utterance, once the utterance is long enough
GAP_ALWAYS = 0.8        # a pause this long always ends it
MIN_SPLIT_SEC = 1.5     # a five-word sentence from the list takes about 2.5 s: its pause must end it
PAD_BEFORE, PAD_AFTER = 0.12, 0.18
MATCH = 0.78            # how alike an utterance and a sentence on screen must be to take its spelling
MIN_PROB = 0.5          # Whisper's mean word confidence below this: the text is a guess
MIN_SPOT_PROB = 0.3     # the same, for an utterance that matches a sentence on screen (the match is evidence too)
WHISPER_HINT = 'هلا والله، شحالك؟ وايد زين. بغيت أروح الحين. شو تبا؟ جذي أحسن.'

AR = 'ءآأؤإئابةتثجحخدذرزسشصضطظعغفقكلمنهوىي'
MARKS = 'ًٌٍَُِّْٰـ'
WORD = re.compile('[' + AR + MARKS + ']+')
SUKUN, FATHA, FATHATAN = 'ْ', 'َ', 'ً'


# --- text ---------------------------------------------------------------------------------------
def bare(text):
    """The letters only, in one spelling: what two writings of the same words share."""
    t = ''.join(ch for ch in str(text) if ch not in MARKS)
    t = re.sub('[إأآ]', 'ا', t).replace('ة', 'ه').replace('ى', 'ي')
    return ' '.join(re.sub('[^' + AR + ' ]', ' ', t).split())


def letters(text):
    return sum(1 for ch in text if ch in AR)


def accept(seconds, text):
    """Spoken Arabic runs about 0.06–0.09 s per letter; real talk has pauses, so the slow side is
    wider than for a generated clip. Far outside: the clip is not this text."""
    n = letters(text)
    if n < 6 or not MIN_SEC <= seconds <= MAX_SEC:
        return False
    return 0.035 <= seconds / n <= 0.22


def best_prompt(text, candidates):
    """The sentence on screen that this utterance is, or None."""
    a = bare(text).replace(' ', '')
    best, score = None, 0.0
    for c in candidates:
        b = bare(c).replace(' ', '')
        if not b or not 0.75 <= len(a) / len(b) <= 1.33:
            continue
        r = difflib.SequenceMatcher(None, a, b).ratio()
        if r > score:
            best, score = c, r
    return best if score >= MATCH else None


def pausal_word(word):
    idx = [i for i, c in enumerate(word) if c in AR]
    if len(idx) < 2:  # و، ب، ل alone: nothing to stop on
        return word
    last = idx[-1]
    head, tail = word[:last], word[last + 1:]
    if word[last] in 'اى':  # long -aa, and -an written ًا or اً read -aa: fatha before the alif
        head, tail = head.replace(FATHATAN, ''), tail.replace(FATHATAN, '')
        before = head[len(head.rstrip(MARKS)):]
        if not any(c in before for c in 'َُِ'):
            head += FATHA
        return head + word[last] + tail
    # a final shadda + sukun is still read doubled with a vowel by Piper's phonemizer, and «ةْ» is read «-at»
    return head + ('ه' if word[last] == 'ة' else word[last]) + SUKUN


def pausal(text):
    """Every Arabic word ends on a sukun: الْيَوْمُ -> الْيَوْمْ، قَهْوَةً -> قَهْوَهْ، شُكْرًا -> شُكْرَا."""
    return WORD.sub(lambda m: pausal_word(m.group(0)), text)


# --- the recordings -----------------------------------------------------------------------------
def read_meta(rec_dir):
    """Every consented recording under rec_dir, in the order it was made."""
    rows = []
    for meta in sorted(Path(rec_dir).rglob('metadata.jsonl')):
        for line in meta.read_text(encoding='utf-8').splitlines():
            if not line.strip():
                continue
            m = json.loads(line)
            wav = meta.parent / m.get('file_name', '')
            if m.get('consent') is not True or not wav.is_file():
                continue
            rows.append({
                'key': wav.relative_to(rec_dir).as_posix(), 'path': wav, 'text': m.get('text') or '',
                'free': m.get('free') is True, 'session': m.get('session') or '', 'part': int(m.get('part') or 0),
                'prompt_ids': [i for i in (m.get('prompt_ids') or []) if isinstance(i, int)],
                'duration': float(m.get('duration') or 0), 'at': m.get('recorded_at') or '',
            })
    rows.sort(key=lambda r: (r['at'], r['session'], r['part'], r['key']))
    return rows


def utterances(words):
    """Words with times -> runs of words that are said in one breath."""
    out, cur = [], []

    def flush():
        if cur:
            out.append(list(cur))
            cur.clear()

    for w in words:
        if cur:
            gap = w['s'] - cur[-1]['e']
            length = cur[-1]['e'] - cur[0]['s']
            ended = cur[-1]['w'][-1:] in '.!?؟'
            if gap >= GAP_ALWAYS or (length >= MIN_SPLIT_SEC and (gap >= GAP_SPLIT or ended)):
                flush()
            elif w['e'] - cur[0]['s'] > MAX_SEC:
                # too long without a real pause: cut at the longest gap there is
                gaps = [cur[i + 1]['s'] - cur[i]['e'] for i in range(len(cur) - 1)]
                if gaps:
                    k = max(range(len(gaps)), key=gaps.__getitem__) + 1
                    rest = cur[k:]
                    del cur[k:]
                    flush()
                    cur.extend(rest)
                else:
                    flush()
        cur.append(w)
    flush()
    return out


def spot(words, candidates):
    """The sentences on screen, found in the words wherever they were read: [(first word, after last, sentence)].
    A person reading down the list may not pause between two sentences, so pauses alone cannot cut them."""
    hits = []
    for c in dict.fromkeys(candidates):
        target = bare(c).replace(' ', '')
        n = len(bare(c).split())
        if len(target) < 6:
            continue
        best = None
        for i in range(len(words)):
            for j in range(i + max(2, n - 2), min(len(words), i + n + 2) + 1):
                got = bare(' '.join(w['w'] for w in words[i:j])).replace(' ', '')
                if not got or not 0.75 <= len(got) / len(target) <= 1.33:
                    continue
                r = difflib.SequenceMatcher(None, got, target).ratio()
                if best is None or r > best[0]:
                    best = (r, i, j, c)
        if best and best[0] >= MATCH:
            hits.append(best)
    taken, out = set(), []
    for r, i, j, c in sorted(hits, key=lambda h: -h[0]):  # the surest first; a word belongs to one sentence
        if taken.isdisjoint(range(i, j)):
            taken.update(range(i, j))
            out.append((i, j, c))
    return sorted(out)


def plan(row, words, sentence_of):
    """One recording -> the clips to cut from it: [(start, end, text)], and why the rest was dropped."""
    drops = {}

    def drop(why):
        drops[why] = drops.get(why, 0) + 1

    if not row['free'] and row['text'] and accept(row['duration'], row['text']):
        return [(0.0, row['duration'], row['text'])], drops  # one sentence, said as written
    cands = [sentence_of[i] for i in row['prompt_ids'] if i in sentence_of]
    if not row['free'] and row['text']:
        cands.append(row['text'])  # a «جملة جملة» take that ran long: the sentence may still be in it
    clips, at = [], 0
    spans = spot(words, cands)
    for i, j, sentence in spans + [(len(words), len(words), None)]:
        for u in utterances(words[at:i]):  # what was said between two sentences from the screen: his own words
            start, end = u[0]['s'], u[-1]['e']
            text = ' '.join(w['w'] for w in u).strip()
            known = best_prompt(text, cands)
            if known:
                text = known
            elif sum(w['p'] for w in u) / len(u) < MIN_PROB:
                drop('unsure')
                continue
            if not accept(end - start, text):
                drop('length')
                continue
            clips.append((start, end, text))
        if sentence:
            start, end = words[i]['s'], words[j - 1]['e']
            # the sentences on screen are also Whisper's hint: one it wrote without hearing it has low confidence
            if sum(w['p'] for w in words[i:j]) / (j - i) < MIN_SPOT_PROB:
                drop('unsure')
            elif accept(end - start, sentence):
                clips.append((start, end, sentence))
            else:
                drop('length')
        at = j
    return clips, drops


# --- audio ---------------------------------------------------------------------------------------
def read_wav(path):
    import numpy as np
    with wave.open(str(path)) as w:
        assert w.getnchannels() == 1 and w.getsampwidth() == 2, 'mono 16-bit expected: ' + str(path)
        return np.frombuffer(w.readframes(w.getnframes()), dtype='<i2').astype('float32') / 32768.0, w.getframerate()


def resample(y, sr, to):
    if sr == to:
        return y
    from math import gcd
    from scipy.signal import resample_poly
    g = gcd(sr, to)
    return resample_poly(y, to // g, sr // g).astype('float32')


def write_clip(path, y, sr):
    import numpy as np
    y = resample(y, sr, SR_OUT)
    peak = float(np.max(np.abs(y))) if y.size else 0.0
    if peak > 0:
        y = y * (0.89 / peak)  # -1 dBFS, every clip alike
    with wave.open(str(path), 'wb') as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(SR_OUT)
        w.writeframes((np.clip(y, -1, 1) * 32767).astype('<i2').tobytes())


# --- commands ------------------------------------------------------------------------------------
def load_sentences(path):
    return {int(s[0]): s[1] for s in json.loads(Path(path).read_text(encoding='utf-8'))}


def cmd_transcribe(a):
    import whisper
    rows = read_meta(a.rec)
    out = Path(a.out)
    done = json.loads(out.read_text(encoding='utf-8')) if out.exists() else {}
    sentence_of = load_sentences(a.sentences)
    model = whisper.load_model(a.model)
    for n, row in enumerate(rows, 1):
        if row['key'] in done:
            continue
        y, sr = read_wav(row['path'])
        # the sentences that were on screen bias Whisper towards their spelling (it takes ~220 tokens)
        hint = (WHISPER_HINT + ' ' + ' '.join(sentence_of[i] for i in row['prompt_ids'] if i in sentence_of))[:420]
        r = model.transcribe(resample(y, sr, 16000), language='ar', word_timestamps=True, condition_on_previous_text=False,
                             temperature=0.0, initial_prompt=hint)
        done[row['key']] = [{'w': w['word'].strip(), 's': round(float(w['start']), 3), 'e': round(float(w['end']), 3),
                             'p': round(float(w.get('probability', 1.0)), 3)}
                            for seg in r['segments'] for w in seg.get('words', []) if w['word'].strip()]
        if n % 5 == 0 or n == len(rows):
            out.write_text(json.dumps(done, ensure_ascii=False), encoding='utf-8')
            print(f'{n}/{len(rows)} transcribed', flush=True)
    out.write_text(json.dumps(done, ensure_ascii=False), encoding='utf-8')
    return 0 if done else 1


def cmd_cut(a):
    rows = read_meta(a.rec)
    words = json.loads(Path(a.words).read_text(encoding='utf-8'))
    sentence_of = load_sentences(a.sentences)
    out = Path(a.out)
    (out / 'wav').mkdir(parents=True, exist_ok=True)
    lines, report, n = [], {'recordings': len(rows), 'clips': 0, 'seconds': 0.0, 'matched': 0, 'dropped': {}, 'examples': []}, 0
    for row in rows:
        clips, drops = plan(row, words.get(row['key'], []), sentence_of)
        for why, k in drops.items():
            report['dropped'][why] = report['dropped'].get(why, 0) + k
        if not clips:
            continue
        y, sr = read_wav(row['path'])
        known = {sentence_of[i] for i in row['prompt_ids'] if i in sentence_of} | {row['text']}
        for start, end, text in clips:
            a0, a1 = max(0, int((start - PAD_BEFORE) * sr)), min(len(y), int((end + PAD_AFTER) * sr))
            if a1 - a0 < MIN_SEC * sr * 0.8:
                continue
            n += 1
            name = f'{a.speaker}_{n:04d}.wav'
            write_clip(out / 'wav' / name, y[a0:a1], sr)
            lines.append(name + '\t' + text.replace('\t', ' ').replace('\n', ' '))
            report['clips'] += 1
            report['seconds'] += (a1 - a0) / sr
            report['matched'] += text in known
            if len(report['examples']) < 12:
                report['examples'].append({'file': name, 'seconds': round((a1 - a0) / sr, 1), 'text': text})
    report['seconds'] = round(report['seconds'], 1)
    (out / f'{a.speaker}.tsv').write_text('\n'.join(lines) + ('\n' if lines else ''), encoding='utf-8')
    (out / f'{a.speaker}.report.json').write_text(json.dumps(report, ensure_ascii=False, indent=1), encoding='utf-8')
    print(json.dumps({k: v for k, v in report.items() if k != 'examples'}, ensure_ascii=False))
    for e in report['examples']:
        print(' ', e['file'], e['seconds'], 's', e['text'])
    return 0 if lines else 1


def build_list(data_dir, speaker, vowel):
    out, seen = [], set()
    for line in (Path(data_dir) / f'{speaker}.tsv').read_text(encoding='utf-8').splitlines():
        if not line.strip():
            continue
        name, text = line.split('\t', 1)
        if name in seen or not (Path(data_dir) / 'wav' / name).exists():
            continue
        seen.add(name)
        text = vowel(text).replace('|', ' ').strip()
        if text:
            out.append(f'{name}|{text}')
    return out


def site_vowel():
    """The text exactly as the site will give it to this voice: CATT's diacritics, then the pausal endings."""
    import piper_fn  # the site's api/piper.py, written next to this file by the notebook
    catt = piper_fn.catt()
    assert catt, 'CATT (the diacritizer) could not be loaded'
    return lambda t: pausal(catt(t))


def cmd_list(a):
    lines = build_list(a.data, a.speaker, site_vowel())
    Path(a.out).write_text('\n'.join(lines) + '\n', encoding='utf-8')
    print(f'{a.speaker}: {len(lines)} clips, e.g. {lines[0] if lines else ""}')
    return 0 if lines else 1


def main(argv=None):
    ap = argparse.ArgumentParser()
    sub = ap.add_subparsers(dest='cmd', required=True)
    t = sub.add_parser('transcribe')
    t.add_argument('--rec', required=True)
    t.add_argument('--sentences', required=True)
    t.add_argument('--out', required=True)
    t.add_argument('--model', default='large-v3')
    c = sub.add_parser('cut')
    c.add_argument('--rec', required=True)
    c.add_argument('--words', required=True)
    c.add_argument('--sentences', required=True)
    c.add_argument('--speaker', required=True)
    c.add_argument('--out', required=True)
    li = sub.add_parser('list')
    li.add_argument('--data', required=True)
    li.add_argument('--speaker', required=True)
    li.add_argument('--out', required=True)
    a = ap.parse_args(argv)
    return {'transcribe': cmd_transcribe, 'cut': cmd_cut, 'list': cmd_list}[a.cmd](a)


if __name__ == '__main__':
    sys.exit(main())
