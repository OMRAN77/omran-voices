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


def js(code):
    return json.loads(subprocess.run(['node', '-e', code], cwd=ROOT, capture_output=True, text=True, check=True).stdout)


class DialectTest(unittest.TestCase):
    """The engine must hear the same respelled words here as on the site (api/_dialect.js)."""

    @classmethod
    def setUpClass(cls):
        cls.pairs = js("process.stdout.write(JSON.stringify(require('./api/_dialect.js').RULES.map(r=>[r.from,r.to])))")
        cls.rules = gen_data.dialect_rules(cls.pairs)

    def same_as_site(self, texts):
        Path(self.tmp.name).write_text(json.dumps(texts, ensure_ascii=False), encoding='utf-8')
        want = js("const d=require('./api/_dialect.js');const t=require(" + json.dumps(self.tmp.name) + ");"
                  "process.stdout.write(JSON.stringify(t.map(x=>d.apply(x,'ar'))))")
        got = [gen_data.apply_dialect(t, self.rules) for t in texts]
        diff = [(t, w, g) for t, w, g in zip(texts, want, got) if w != g]
        self.assertEqual(diff[:5], [])
        return got

    def setUp(self):
        self.tmp = tempfile.NamedTemporaryFile(suffix='.json', delete=False)

    def tearDown(self):
        Path(self.tmp.name).unlink()

    def test_all_10000_sentences_match_the_site(self):
        got = self.same_as_site([row[1] for row in SENTENCES])
        self.assertGreater(sum(g != row[1] for g, row in zip(got, SENTENCES)), 100)  # it really respells

    def test_edges(self):
        self.same_as_site(['وايد', 'ووايد زين', 'الوايد', 'وايدة', 'وَايد', 'هلا  والله يا خوي', 'مسجك وصل؟ مسجد', 'يعطيك العافية وايد'])


class SelectTest(unittest.TestCase):
    def test_two_voices_never_share_a_sentence_and_the_mix_is_kept(self):
        a = gen_data.select(SENTENCES, 700, 0)
        b = gen_data.select(SENTENCES, 700, 1)
        self.assertEqual((len(a), len(b)), (700, 700))
        self.assertEqual({s[0] for s in a} & {s[0] for s in b}, set())
        regs = [s[2] for s in a]
        self.assertEqual((regs.count('gulf'), regs.count('ar'), regs.count('msa')), (420, 140, 140))
        for _, text, _ in a + b:
            self.assertTrue(5 <= len(text.split()) <= 15 and len(text) <= 200 and '|' not in text)
        self.assertEqual(a, gen_data.select(SENTENCES, 700, 0))  # same picks on a re-run


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
            lines = prep_train.build(d, lambda t: '<' + t + '>')
            self.assertEqual(lines, ['f_2.wav|f|<شحالك   اليوم>', 'm_1.wav|m|<هلا والله>'])


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
