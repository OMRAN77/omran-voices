"""A few test sentences from one exported voice, to listen to on Hugging Face.

  python samples.py out/ar_AE-omran_m-medium.onnx out/samples m      (writes out/samples/m_1.wav ...)
"""
import sys
import wave
from pathlib import Path

TEXTS = [  # formal Arabic, like the training sentences; Piper adds the diacritics itself
    'مرحبا، كيف حالك اليوم؟',
    'أريد أن أذهب إلى السوق الآن، لكن الجو حار جدا.',
    'سنلتقي غدا إن شاء الله في البيت بعد صلاة المغرب.',
]


def main(model, out_dir, name):
    from piper import PiperVoice
    voice = PiperVoice.load(model)
    out = Path(out_dir)
    out.mkdir(parents=True, exist_ok=True)
    for i, text in enumerate(TEXTS, 1):
        with wave.open(str(out / f'{name}_{i}.wav'), 'wb') as w:
            voice.synthesize_wav(text, w)
    print('samples:', sorted(p.name for p in out.glob(f'{name}_*.wav')))
    return 0


if __name__ == '__main__':
    sys.exit(main(sys.argv[1], sys.argv[2], sys.argv[3]))
