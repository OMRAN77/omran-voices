"""Turns the clips made by gen_data.py into Piper's training list.

  python prep_train.py --data data --out data/metadata.csv

Reads data/<speaker>.tsv (one per voice) and writes "<file>|<speaker>|<text>", Piper's
multi-speaker format. The text gets the same automatic diacritics (tashkeel) Piper adds when it
speaks Arabic (PiperVoice: use_tashkeel, taskeen_threshold 0.8), so the model trains on exactly
the phonemes it will be given later.
"""
import argparse
import sys
from pathlib import Path

TASKEEN = 0.8


def rows(data_dir):
    for tsv in sorted(Path(data_dir).glob('*.tsv')):
        speaker = tsv.stem
        for line in tsv.read_text(encoding='utf-8').splitlines():
            if not line.strip():
                continue
            name, text = line.split('\t', 1)
            if (Path(data_dir) / 'wav' / name).exists():
                yield name, speaker, text


def build(data_dir, diacritize):
    out, seen = [], set()
    for name, speaker, text in rows(data_dir):
        if name in seen:
            continue
        seen.add(name)
        text = diacritize(text).replace('|', ' ').strip()
        if text:
            out.append(f'{name}|{speaker}|{text}')
    return out


def main(argv=None):
    ap = argparse.ArgumentParser()
    ap.add_argument('--data', required=True)
    ap.add_argument('--out', required=True)
    a = ap.parse_args(argv)
    from piper.tashkeel import TashkeelDiacritizer
    tashkeel = TashkeelDiacritizer()
    lines = build(a.data, lambda t: tashkeel(t, taskeen_threshold=TASKEEN))
    Path(a.out).write_text('\n'.join(lines) + '\n', encoding='utf-8')
    speakers = sorted({ln.split('|')[1] for ln in lines})
    print(f'{len(lines)} clips, speakers: {speakers}')
    return 0 if lines else 1


if __name__ == '__main__':
    sys.exit(main())
