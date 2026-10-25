"""Turns one voice's clips (made by gen_data.py) into Piper's training list for that voice.

  python prep_train.py --data data --speaker m --out data/m.csv

Reads data/<speaker>.tsv and writes "<file>|<text>", Piper's one-voice format. Each voice is its
own model, so it starts from a finished Arabic voice with every layer in place. (A model with two
voices adds speaker layers that start random; ours spoke gibberish.) The text gets the same
automatic diacritics (tashkeel) Piper adds when it speaks Arabic (PiperVoice: use_tashkeel,
taskeen_threshold 0.8), so the model trains on exactly the phonemes it will be given later.
"""
import argparse
import sys
from pathlib import Path

TASKEEN = 0.8


def rows(data_dir, speaker):
    for line in (Path(data_dir) / f'{speaker}.tsv').read_text(encoding='utf-8').splitlines():
        if not line.strip():
            continue
        name, text = line.split('\t', 1)
        if (Path(data_dir) / 'wav' / name).exists():
            yield name, text


def build(data_dir, speaker, diacritize):
    out, seen = [], set()
    for name, text in rows(data_dir, speaker):
        if name in seen:
            continue
        seen.add(name)
        text = diacritize(text).replace('|', ' ').strip()
        if text:
            out.append(f'{name}|{text}')
    return out


def main(argv=None):
    ap = argparse.ArgumentParser()
    ap.add_argument('--data', required=True)
    ap.add_argument('--speaker', required=True)
    ap.add_argument('--out', required=True)
    a = ap.parse_args(argv)
    from piper.tashkeel import TashkeelDiacritizer
    tashkeel = TashkeelDiacritizer()
    lines = build(a.data, a.speaker, lambda t: tashkeel(t, taskeen_threshold=TASKEEN))
    Path(a.out).write_text('\n'.join(lines) + '\n', encoding='utf-8')
    print(f'{a.speaker}: {len(lines)} clips')
    return 0 if lines else 1


if __name__ == '__main__':
    sys.exit(main())
