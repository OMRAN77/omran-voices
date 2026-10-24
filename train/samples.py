"""A few test sentences from the exported model, one set per voice, to listen to on Hugging Face.

  python samples.py out/ar_AE-omran-medium.onnx out/samples
"""
import json
import sys
import wave
from pathlib import Path

TEXTS = [
    'هلا والله، شحالك اليوم؟',
    'بغيت أروح السوق الحين بس الجو حار وايد.',
    'باجر إن شاء الله نتلاقى في البيت عقب صلاة المغرب.',
]


def main(model, out_dir):
    from piper import PiperVoice, SynthesisConfig
    voice = PiperVoice.load(model)
    speakers = json.loads(Path(model + '.json').read_text(encoding='utf-8')).get('speaker_id_map') or {'voice': None}
    out = Path(out_dir)
    out.mkdir(parents=True, exist_ok=True)
    for name, sid in speakers.items():
        for i, text in enumerate(TEXTS, 1):
            with wave.open(str(out / f'{name}_{i}.wav'), 'wb') as w:
                voice.synthesize_wav(text, w, syn_config=SynthesisConfig(speaker_id=sid))
    print('samples:', sorted(p.name for p in out.glob('*.wav')))
    return 0


if __name__ == '__main__':
    sys.exit(main(sys.argv[1], sys.argv[2]))
