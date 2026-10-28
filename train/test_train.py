"""Tests for the training scripts, without a GPU or any download. Run: python3 train/test_train.py"""
import json
import subprocess
import sys
import tempfile
import unittest
import wave
from pathlib import Path

HERE = Path(__file__).resolve().parent
ROOT = HERE.parent
sys.path.insert(0, str(HERE))
import gen_data  # noqa: E402
import prep_train  # noqa: E402

SENTENCES = json.loads((ROOT / 'data' / 'sentences.json').read_text(encoding='utf-8'))


class SelectTest(unittest.TestCase):
    def test_two_voices_never_share_a_sentence_and_all_are_formal(self):
        a = gen_data.select(SENTENCES, 700, 0)
        b = gen_data.select(SENTENCES, 700, 1)
        self.assertEqual((len(a), len(b)), (700, 700))
        self.assertEqual({s[0] for s in a} & {s[0] for s in b}, set())
        self.assertEqual({s[2] for s in a + b}, {'msa'})
        for _, text, _ in a + b:
            self.assertTrue(5 <= len(text.split()) <= 15 and len(text) <= 200 and '|' not in text)
        self.assertEqual(a, gen_data.select(SENTENCES, 700, 0))  # same picks on a re-run

    def test_the_teacher_reads_piper_vowels_for_exactly_the_picked_sentences(self):
        got = prep_train.vowel(SENTENCES, 700, 2, lambda t: '<' + t + '>')
        picked = gen_data.select(SENTENCES, 700, 0) + gen_data.select(SENTENCES, 700, 1)
        self.assertEqual(got, {str(sid): '<' + text + '>' for sid, text, _ in picked})


class PromptTest(unittest.TestCase):
    """Audar's voice-cloning prompt and its answer (the model card's format)."""

    def test_prompt_carries_the_voice_then_the_sentence(self):
        p = gen_data.prompt([5, 17], 'مَرْحَبًا')
        self.assertTrue(p.startswith('user: Convert the text to speech:<|REF_TEXT_START|><|REF_TEXT_END|>'))
        self.assertIn('<|REF_SPEECH_START|><|speech_5|><|speech_17|><|REF_SPEECH_END|>', p)
        self.assertTrue(p.endswith('<|TARGET_TEXT_START|>مَرْحَبًا<|TARGET_TEXT_END|>\nassistant:<|TARGET_CODES_START|>'))

    def test_only_speech_codes_come_back(self):
        self.assertEqual(gen_data.speech_codes('<|speech_12|>x<|speech_0|><|TARGET_CODES_END|><|speech_|>'), [12, 0])
        self.assertEqual(gen_data.speech_codes('nothing'), [])


class AcceptTest(unittest.TestCase):
    def test_clip_length_must_fit_the_sentence(self):
        text = 'بغيت أروح السوق الحين بس الجو حار وايد.'  # 30 letters
        self.assertTrue(gen_data.accept(2.4, text))
        self.assertFalse(gen_data.accept(0.6, text))   # cut short
        self.assertFalse(gen_data.accept(9.0, text))   # babbling after the sentence
        self.assertFalse(gen_data.accept(16.0, 'كلمة ' * 60))
        self.assertFalse(gen_data.accept(2.0, '...'))


class FilesTest(unittest.TestCase):
    def test_wav_and_resume_and_training_list(self):
        with tempfile.TemporaryDirectory() as d:
            d = Path(d)
            (d / 'wav').mkdir()
            gen_data.write_wav(d / 'wav' / 'm_1.wav', b'\x00\x01' * 22050)
            gen_data.write_wav(d / 'wav' / 'f_2.wav', b'\x00\x01' * 22050)
            with wave.open(str(d / 'wav' / 'm_1.wav')) as w:
                self.assertEqual((w.getnchannels(), w.getsampwidth(), w.getframerate(), w.getnframes()), (1, 2, 22050, 22050))
            (d / 'm.tsv').write_text('m_1.wav\tهلا والله\nm_9.wav\tما انحفظ صوتها\nm_1.wav\tهلا والله\n', encoding='utf-8')
            (d / 'f.tsv').write_text('f_2.wav\tشحالك | اليوم\n', encoding='utf-8')
            self.assertEqual(gen_data.done_ids(d / 'm.tsv'), {'m_1.wav', 'm_9.wav'})
            # one list per voice, in Piper's one-voice format: each voice is its own model
            self.assertEqual(prep_train.build(d, 'm', lambda t: '<' + t + '>'), ['m_1.wav|<هلا والله>'])
            self.assertEqual(prep_train.build(d, 'f', lambda t: '<' + t + '>'), ['f_2.wav|<شحالك   اليوم>'])


class NotebookTest(unittest.TestCase):
    def test_notebook_is_built_from_these_files_and_its_code_compiles(self):
        r = subprocess.run([sys.executable, str(ROOT / 'tools' / 'build-notebook.py'), '--check'])
        self.assertEqual(r.returncode, 0, 'run: python3 tools/build-notebook.py')
        nb = json.loads((HERE / 'omran-voices-piper.ipynb').read_text(encoding='utf-8'))
        n = 0
        for cell in nb['cells']:
            if cell['cell_type'] != 'code':
                continue
            src = ''.join(cell['source'])
            if src.startswith('%%writefile'):
                name, body = src.split('\n', 1)
                if not name.endswith('.py'):
                    continue
                src = body
            compile(src, 'cell', 'exec')
            n += 1
        self.assertGreaterEqual(n, 7)


if __name__ == '__main__':
    unittest.main()
