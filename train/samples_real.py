"""A few Gulf sentences from one exported voice, to listen to.

  python samples_real.py out/ar_AE-saif_gulf-medium.onnx out/samples saif_gulf   (writes out/samples/saif_gulf_1.wav ...)

The text goes through the same steps the site will use for this voice (CATT's diacritics, then the
pausal endings), so the samples sound as the site will.
"""
import sys
import wave
from pathlib import Path

TEXTS = [
    'هلا والله، شحالك اليوم؟ عساك بخير.',
    'بغيت أروح السوق الحين، بس الجو حر وايد.',
    'باجر إن شاء الله بنتلاقى في البيت عقب صلاة المغرب.',
    'شو رايك نطلع البر ونسوي قهوة وشاي على الحطب؟',
    'السموحة منك، ما انتبهت للرسالة إلا الحين.',
]


def main(model, out_dir, name):
    from piper import PiperVoice
    from prep_real import site_vowel
    voice = PiperVoice.load(model)
    vowel = site_vowel()
    out = Path(out_dir)
    out.mkdir(parents=True, exist_ok=True)
    for i, text in enumerate(TEXTS, 1):
        with wave.open(str(out / f'{name}_{i}.wav'), 'wb') as w:
            voice.synthesize_wav(vowel(text), w)
    print('samples:', sorted(p.name for p in out.glob(f'{name}_*.wav')))
    return 0


if __name__ == '__main__':
    sys.exit(main(sys.argv[1], sys.argv[2], sys.argv[3]))
