"""Piper's diacritics for the sentences, before and after the engine reads them.

  python prep_train.py vowel --sentences sentences.json --count 700 --parts 2 --out vowelled.json
  python prep_train.py list --data data --speaker m --out data/m.csv

vowel: the sentences gen_data.py will pick, with the automatic diacritics (tashkeel) Piper adds
when it speaks Arabic (PiperVoice: use_tashkeel, taskeen_threshold 0.8). The engine reads these
vowels, so its clips say exactly what Piper will be given later.

list: one voice's clips as Piper's training list, "<file>|<text>" (one-voice format). Each voice is
its own model, so it starts from a finished Arabic voice with every layer in place. (A model with
two voices adds speaker layers that start random; ours spoke gibberish.) The text gets the same
diacritics, so the model trains on exactly the phonemes it will be given later.
"""
import argparse
import json
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


def vowel(sentences, count, parts, diacritize):
    from gen_data import select
    return {str(sid): diacritize(text) for part in range(parts) for sid, text, _ in select(sentences, count, part)}


def main(argv=None):
    ap = argparse.ArgumentParser()
    sub = ap.add_subparsers(dest='cmd', required=True)
    v = sub.add_parser('vowel')
    v.add_argument('--sentences', required=True)
    v.add_argument('--count', type=int, required=True)
    v.add_argument('--parts', type=int, required=True)
    v.add_argument('--out', required=True)
    li = sub.add_parser('list')
    li.add_argument('--data', required=True)
    li.add_argument('--speaker', required=True)
    li.add_argument('--out', required=True)
    a = ap.parse_args(argv)
    from piper.tashkeel import TashkeelDiacritizer
    tashkeel = TashkeelDiacritizer()
    diacritize = lambda t: tashkeel(t, taskeen_threshold=TASKEEN)  # noqa: E731
    if a.cmd == 'vowel':
        got = vowel(json.loads(Path(a.sentences).read_text(encoding='utf-8')), a.count, a.parts, diacritize)
        Path(a.out).write_text(json.dumps(got, ensure_ascii=False), encoding='utf-8')
        print(f'{len(got)} sentences vowelled, e.g. {next(iter(got.values()), "")}')
        return 0 if got else 1
    lines = build(a.data, a.speaker, diacritize)
    Path(a.out).write_text('\n'.join(lines) + '\n', encoding='utf-8')
    print(f'{a.speaker}: {len(lines)} clips')
    return 0 if lines else 1


if __name__ == '__main__':
    sys.exit(main())
