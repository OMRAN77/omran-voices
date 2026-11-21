"""Tests for the real-voice training scripts, without a GPU or any download. Run: python3 train/test_real.py"""
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
import prep_real  # noqa: E402


def words(*items):
    """('كلمة', start, end[, prob]) -> Whisper-like words."""
    return [{'w': w, 's': s, 'e': e, 'p': (rest[0] if rest else 0.9)} for w, s, e, *rest in items]


def say(text, start, per_word=0.45, gap=0.05, prob=0.9):
    out, t = [], start
    for w in text.split():
        out.append({'w': w, 's': round(t, 2), 'e': round(t + per_word, 2), 'p': prob})
        t += per_word + gap
    return out


class TextTest(unittest.TestCase):
    def test_bare_is_the_same_for_two_spellings(self):
        self.assertEqual(prep_real.bare('الْيَوْمُ، أَروح إلى القهوة!'), prep_real.bare('اليوم اروح الي القهوه'))

    def test_clip_length_must_fit_its_text(self):
        text = 'بغيت أروح السوق الحين بس الجو حار وايد.'  # 30 letters
        self.assertTrue(prep_real.accept(2.4, text))
        self.assertTrue(prep_real.accept(5.5, text))    # slow, with a pause: still this sentence
        self.assertFalse(prep_real.accept(0.9, text))   # cut short
        self.assertFalse(prep_real.accept(11.0, text))  # a lot more was said than this text
        self.assertFalse(prep_real.accept(3.0, 'هلا'))  # too little text to learn from

    def test_an_utterance_takes_the_spelling_of_the_sentence_on_screen(self):
        cands = ['بغيت ماي بارد عقب العشا.', 'شو رايك نطلع البر باجر؟']
        self.assertEqual(prep_real.best_prompt('بغيت ماي بارد عقب العشاء', cands), cands[0])
        self.assertEqual(prep_real.best_prompt('شو رأيك نطلع البر باكر', cands), cands[1])
        self.assertIsNone(prep_real.best_prompt('اليوم رحت الدوام من الصبح', cands))
        self.assertIsNone(prep_real.best_prompt('بغيت ماي', cands), 'part of a sentence is not the sentence')

    def test_pausal_endings(self):
        cases = {
            'شِحَالُكَ': 'شِحَالُكْ', 'الْيَوْمُ': 'الْيَوْمْ', 'الْجَوُّ': 'الْجَوْ', 'حُرٌّ': 'حُرْ', 'وَايِدٌ': 'وَايِدْ',
            'قَهْوَةً': 'قَهْوَهْ', 'شُكْرًا': 'شُكْرَا', 'شُكْراً': 'شُكْرَا', 'هَلَّا': 'هَلَّا', 'عَلَى': 'عَلَى', 'وَ': 'وَ',
            'يُعْطِيكَ الْعَافِيَةَ.': 'يُعْطِيكْ الْعَافِيَهْ.', 'Hello 3 كتبٍ!': 'Hello 3 كتبْ!',
        }
        for k, v in cases.items():
            self.assertEqual(prep_real.pausal(k), v, k)
        once = prep_real.pausal('الْيَوْمُ الْجَوُّ حُرٌّ')
        self.assertEqual(prep_real.pausal(once), once)


class UtterancesTest(unittest.TestCase):
    def test_cut_at_pauses_and_sentence_ends(self):
        a = say('بغيت ماي بارد عقب العشا.', 0.0)            # 5 words, ends 2.45
        b = say('شو رايك نطلع البر باجر؟', a[-1]['e'] + 0.6)  # after a 0.6 s pause
        c = say('زين', b[-1]['e'] + 0.1)                    # right after a «؟», no pause
        us = prep_real.utterances(a + b + c)
        self.assertEqual([' '.join(w['w'] for w in u) for u in us], ['بغيت ماي بارد عقب العشا.', 'شو رايك نطلع البر باجر؟', 'زين'])

    def test_a_short_pause_inside_a_short_run_does_not_cut(self):
        w = words(('هلا', 0, 0.4), ('والله', 0.9, 1.3), ('شحالك', 1.4, 1.9))  # 0.5 s pause after one word
        self.assertEqual(len(prep_real.utterances(w)), 1)
        w = words(('هلا', 0, 0.4), ('والله', 1.7, 2.1))                        # a long pause always cuts
        self.assertEqual(len(prep_real.utterances(w)), 2)

    def test_a_run_with_no_real_pause_is_cut_at_its_longest_gap_before_12_s(self):
        run = say('كلمة ' * 30, 0.0, per_word=0.42, gap=0.05)  # 14 s with no pause
        run[14]['s'] += 0.2
        for w in run[14:]:
            w['e'] += 0.2
        for w in run[15:]:
            w['s'] += 0.2
        us = prep_real.utterances(run)
        self.assertGreaterEqual(len(us), 2)
        self.assertEqual(len(us[0]), 14, 'cut where the gap was longest')
        for u in us:
            self.assertLessEqual(u[-1]['e'] - u[0]['s'], prep_real.MAX_SEC)


class PlanTest(unittest.TestCase):
    S = {7: 'بغيت ماي بارد عقب العشا.', 12: 'شو رايك نطلع البر باجر؟'}

    def row(self, **over):
        return dict({'key': 'k', 'text': '', 'free': True, 'prompt_ids': [7, 12], 'duration': 50.0}, **over)

    def test_a_continuous_piece_becomes_clips_with_the_screen_spelling(self):
        a = say('بغيت ماي بارد عقب العشاء', 1.0)
        b = say('شو رأيك نطلع البر باكر', a[-1]['e'] + 0.7)
        c = say('والله اليوم الدوام كان طويل وايد وتعبت منه', b[-1]['e'] + 0.8)       # his own words: Whisper's text is kept
        d = say('هاه اممم يعني شسمه هذاك الشي اللي', c[-1]['e'] + 0.9, prob=0.3)     # Whisper unsure: dropped
        clips, drops = prep_real.plan(self.row(), a + b + c + d, self.S)
        self.assertEqual([t for _, _, t in clips], [self.S[7], self.S[12], 'والله اليوم الدوام كان طويل وايد وتعبت منه'])
        self.assertEqual(drops, {'unsure': 1})
        self.assertAlmostEqual(clips[0][0], 1.0)

    def test_sentences_read_with_no_pause_between_them_are_still_cut_apart(self):
        # a reader who does not stop between two sentences, and Whisper without punctuation
        run = say('بغيت ماي بارد عقب العشاء شو رأيك نطلع البر باكر', 2.0, per_word=0.4, gap=0.04)
        clips, drops = prep_real.plan(self.row(), run, self.S)
        self.assertEqual([t for _, _, t in clips], [self.S[7], self.S[12]])
        self.assertEqual(drops, {})
        self.assertAlmostEqual(clips[0][1], run[4]['e'])
        self.assertAlmostEqual(clips[1][0], run[5]['s'])
        # Whisper wrote a screen sentence it did not really hear (very low confidence): not a clip
        ghost = say('بغيت ماي بارد عقب العشاء', 2.0, prob=0.1)
        self.assertEqual(prep_real.plan(self.row(), ghost, self.S), ([], {'unsure': 1}))
        # a sentence read twice is taken once, and each word belongs to one clip
        spans = prep_real.spot(run + say('بغيت ماي بارد عقب العشاء', 9.0), [self.S[7], self.S[12]])
        self.assertEqual(len(spans), 2)
        self.assertTrue(all(a[1] <= b[0] for a, b in zip(spans, spans[1:])))

    def test_one_sentence_said_as_written_is_one_clip_without_whisper(self):
        clips, _ = prep_real.plan(self.row(free=False, text=self.S[7], duration=2.6, prompt_ids=[]), [], self.S)
        self.assertEqual(clips, [(0.0, 2.6, self.S[7])])

    def test_a_sentence_take_that_ran_long_is_treated_as_talk(self):
        # the owner's first takes: 25 s of talk under a 5-word sentence. The sentence text must not label 25 s.
        talk = say('بغيت ماي بارد عقب العشا.', 0.5) + say('وبعدين رحنا السوق واشترينا أغراض البيت كلها', 4.5)
        clips, _ = prep_real.plan(self.row(free=False, text=self.S[7], duration=25.0, prompt_ids=[]), talk, self.S)
        self.assertEqual([t for _, _, t in clips], [self.S[7], 'وبعدين رحنا السوق واشترينا أغراض البيت كلها'])


class FilesTest(unittest.TestCase):
    def test_meta_keeps_consented_recordings_in_order_and_the_list_is_pipers(self):
        with tempfile.TemporaryDirectory() as d:
            d = Path(d)
            b = d / 'b1'
            b.mkdir()
            for name in ('free0001_x.wav', 'free0000_y.wav', '00007_z.wav'):
                with wave.open(str(b / name), 'wb') as w:
                    w.setnchannels(1)
                    w.setsampwidth(2)
                    w.setframerate(24000)
                    w.writeframes(b'\x00\x01' * 2400)
            rows = [
                {'file_name': 'free0001_x.wav', 'text': '', 'free': True, 'session': 's1', 'part': 1, 'prompt_ids': [7, 'x'], 'duration': 50, 'recorded_at': '2026-11-21T08:01:00Z', 'consent': True},
                {'file_name': 'free0000_y.wav', 'text': '', 'free': True, 'session': 's1', 'part': 0, 'prompt_ids': [7], 'duration': 45, 'recorded_at': '2026-11-21T08:00:00Z', 'consent': True},
                {'file_name': '00007_z.wav', 'text': 'هلا', 'duration': 2, 'recorded_at': '2026-11-20T08:00:00Z', 'consent': True},
                {'file_name': 'gone.wav', 'text': 'x', 'duration': 2, 'recorded_at': '2026-11-20T08:00:00Z', 'consent': True},
                {'file_name': '00007_z.wav', 'text': 'no consent', 'duration': 2, 'recorded_at': '2026-11-19T08:00:00Z', 'consent': False},
            ]
            (b / 'metadata.jsonl').write_text('\n'.join(json.dumps(r, ensure_ascii=False) for r in rows) + '\n', encoding='utf-8')
            got = prep_real.read_meta(d)
            self.assertEqual([(r['key'], r['free'], r['part'], r['prompt_ids']) for r in got],
                             [('b1/00007_z.wav', False, 0, []), ('b1/free0000_y.wav', True, 0, [7]), ('b1/free0001_x.wav', True, 1, [7])])

            data = d / 'data'
            (data / 'wav').mkdir(parents=True)
            (data / 'wav' / 'saif_0001.wav').write_bytes(b'x')
            (data / 'saif.tsv').write_text('saif_0001.wav\tهلا | والله\nsaif_0002.wav\tما انحفظ صوتها\nsaif_0001.wav\tهلا\n', encoding='utf-8')
            self.assertEqual(prep_real.build_list(data, 'saif', lambda t: '<' + t + '>'), ['saif_0001.wav|<هلا   والله>'])


def have(*modules):
    import importlib.util
    return all(importlib.util.find_spec(m) for m in modules)


@unittest.skipUnless(have('numpy'), 'needs numpy (the training environments have it)')
class MuffledTest(unittest.TestCase):
    """The first voice (21 Nov) was «صوت هواء ومش واضح»: all 280 clips were muffled at the source."""

    def speech(self, seconds=4.0, seed=1):
        """Noise with the long-term spectrum of clear speech, in syllable-like bursts, with pauses."""
        import numpy as np
        rng = np.random.default_rng(seed)
        n = int(seconds * prep_real.SR_OUT)
        X = np.fft.rfft(rng.standard_normal(n))
        f = np.fft.rfftfreq(n, 1 / prep_real.SR_OUT)
        centers = np.arange(len(prep_real.CLEAR_SPEECH_DB)) * prep_real.EQ_STEP + prep_real.EQ_STEP / 2
        y = np.fft.irfft(X * 10 ** (np.interp(f, centers, prep_real.CLEAR_SPEECH_DB) / 20), n)
        t = np.arange(n) / prep_real.SR_OUT
        env = (np.sin(2 * np.pi * 3 * t) > -0.2) * (t % 2.0 < 1.5)  # words, then half a second of pause
        return (y / np.abs(y).max() * 0.5 * env).astype('float32')

    def muffle(self, y, seed=2):
        """A covered microphone: 16 dB lost from 2 kHz up, and the room's hiss on top."""
        import numpy as np
        X = np.fft.rfft(y)
        f = np.fft.rfftfreq(len(y), 1 / prep_real.SR_OUT)
        lost = np.interp(f, [0, 1000, 2000, 4000, 11025], [0, 0, -14, -18, -18])
        room = np.random.default_rng(seed).standard_normal(len(y)) * 10 ** (-58 / 20)
        return (np.fft.irfft(X * 10 ** (lost / 20), len(y)) + room).astype('float32')

    def pause_to_speech_db(self, y):
        import numpy as np
        t = np.arange(len(y)) / prep_real.SR_OUT
        pause, talk = y[(t % 2.0 > 1.6) & (t % 2.0 < 1.95)], y[t % 2.0 < 1.4]
        return 10 * np.log10(np.mean(pause ** 2) / np.mean(talk ** 2) + 1e-12)

    def test_clear_speech_measures_clear_and_muffled_speech_measures_muffled(self):
        clear = self.speech()
        self.assertLess(abs(prep_real.muffled_by(prep_real.speech_spectrum([clear]))), 2.0)
        self.assertGreater(prep_real.muffled_by(prep_real.speech_spectrum([self.muffle(clear)])), 10.0)

    def test_repair_brings_the_consonants_back_without_raising_the_room(self):
        clear = self.speech()
        dull = self.muffle(clear)
        curve = prep_real.eq_curve(prep_real.speech_spectrum([dull]))
        self.assertLessEqual(max(curve), prep_real.EQ_MAX)
        self.assertLessEqual(max(curve[prep_real.EQ_HIGH_FROM // prep_real.EQ_STEP:]), prep_real.EQ_MAX_HIGH)
        self.assertLessEqual(curve[0], 0.0, 'rumble is never raised')
        fixed = prep_real.repair(dull, curve)
        self.assertEqual(len(fixed), len(dull))
        self.assertLess(abs(prep_real.muffled_by(prep_real.speech_spectrum([fixed]))), 3.0)
        # an equalizer alone would lift the hiss in the pauses by ~10 dB against the speech; the gate must hold it
        self.assertLessEqual(self.pause_to_speech_db(fixed), self.pause_to_speech_db(dull) + 1.0)

    def test_clips_are_repaired_in_place_once_and_clear_clips_are_left_alone(self):
        with tempfile.TemporaryDirectory() as d:
            d = Path(d)
            for i in range(3):
                prep_real.write_clip(d / f'c{i}.wav', self.muffle(self.speech(seed=10 + i), seed=20 + i), prep_real.SR_OUT)
            first = prep_real.repair_clips(d)
            self.assertTrue(first['repaired'])
            self.assertGreater(first['muffled_db'], 10.0)
            self.assertLess(abs(first['after_db']), 3.0)
            self.assertFalse(prep_real.repair_clips(d)['repaired'], 'a second run must not equalize twice')
        with tempfile.TemporaryDirectory() as d:
            d = Path(d)
            prep_real.write_clip(d / 'c.wav', self.speech(), prep_real.SR_OUT)
            before = (d / 'c.wav').read_bytes()
            self.assertFalse(prep_real.repair_clips(d)['repaired'])
            self.assertEqual((d / 'c.wav').read_bytes(), before)


class SecondListeningTest(unittest.TestCase):
    """The person told a story instead of reading the list (21 Nov: 0 of 280 clips were a sentence
    from the screen), so every text was Whisper's guess."""

    def test_a_clip_whose_text_the_second_listening_does_not_hear_is_dropped(self):
        lines = ['a.wav\tقال لي يا حبيبي أنا بنفسي وصلتها.', 'b.wav\tترك التليفون ومطلعي. شلون؟', 'c.wav\tبعد ما تعبوا من البحث.']
        heard = {'a.wav': 'قال لي يا حبيبي انا بنفسي وصّلتها', 'b.wav': 'راح السوق واشترى خبز', 'c.wav': ''}
        kept, out = prep_real.keep_agreed(lines, heard)
        self.assertEqual(kept, lines[:1])
        self.assertEqual(out, ['b.wav', 'c.wav'])
        self.assertEqual(prep_real.agreement('الْيَوْمُ أَروح', 'اليوم اروح'), 1.0)
        self.assertEqual(prep_real.agreement('', 'x'), 0.0)


@unittest.skipUnless(have('torch', 'lightning'), 'needs torch and lightning (the training environment has them)')
class LatestCheckpointTest(unittest.TestCase):
    """The first voice was exported from an early epoch: Lightning 2.6 writes last.ckpt only when a
    "best" checkpoint is written, and the validation number stops improving early."""

    def test_last_ckpt_is_the_newest_epoch_even_when_validation_only_gets_worse(self):
        import lightning as L
        import torch
        from train_main import KeepLatest

        class Toy(L.LightningModule):  # two hand-stepped optimizers, as Piper trains
            def __init__(self):
                super().__init__()
                self.automatic_optimization = False
                self.g, self.d = torch.nn.Linear(4, 4), torch.nn.Linear(4, 1)

            def training_step(self, batch, i):
                for opt, net in zip(self.optimizers(), (self.g, self.d)):
                    loss = net(batch[0]).pow(2).mean()
                    opt.zero_grad()
                    self.manual_backward(loss)
                    opt.step()

            def validation_step(self, batch, i):
                self.log('val_mel', float(self.current_epoch))

            def configure_optimizers(self):
                return [torch.optim.SGD(self.g.parameters(), lr=0.01), torch.optim.SGD(self.d.parameters(), lr=0.01)]

        data = torch.utils.data.DataLoader(torch.utils.data.TensorDataset(torch.randn(16, 4)), batch_size=8)
        with tempfile.TemporaryDirectory() as d:
            trainer = L.Trainer(max_epochs=7, default_root_dir=d, callbacks=[KeepLatest(3)], enable_checkpointing=False,
                                enable_progress_bar=False, enable_model_summary=False)
            trainer.fit(Toy(), data, data)
            found = sorted(p.name for p in Path(d).rglob('*.ckpt*'))
            self.assertEqual(found, ['last.ckpt'], 'one file, and no half-written one left behind')
            ckpt = torch.load(next(Path(d).rglob('last.ckpt')), map_location='cpu', weights_only=False)
            self.assertEqual(ckpt['global_step'], 7 * 2 * 2, 'the model after the last step of the last epoch')


class NotebookTest(unittest.TestCase):
    def test_notebook_is_built_from_these_files_and_its_code_compiles(self):
        r = subprocess.run([sys.executable, str(ROOT / 'tools' / 'build-real-notebook.py'), '--check'])
        self.assertEqual(r.returncode, 0, 'run: python3 tools/build-real-notebook.py')
        nb = json.loads((HERE / 'omran-voice-real.ipynb').read_text(encoding='utf-8'))
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
        self.assertGreaterEqual(n, 8)
        text = json.dumps(nb, ensure_ascii=False)
        import re
        self.assertIsNone(re.search(r'hf_[A-Za-z0-9]{30,}', text), 'no token in the notebook')

    def test_the_clearest_version_is_kept_beside_the_newest_and_a_failed_measure_stops_nothing(self):
        # the notebook's own upload step, with the card, Whisper and Hugging Face replaced by stand-ins
        import os
        import shutil
        import time
        nb = json.loads((HERE / 'omran-voice-real.ipynb').read_text(encoding='utf-8'))
        cell = next(''.join(c['source']) for c in nb['cells'] if 'def upload(' in ''.join(c['source']))
        part = cell[cell.index('SCORES = []'):cell.index('last_up = time.time()')]
        runs = iter([('epoch 4 step 100', 0.5), ('epoch 8 step 200', 0.8), ('epoch 12 step 300', None), ('epoch 16 step 400', 0.6)])
        now, sent = {}, []

        class Api:
            def upload_folder(self, **k):
                sent.append(sorted(p.relative_to('out').as_posix() for p in Path('out').rglob('*') if p.is_file()))

            def upload_file(self, **k):
                sent.append(k['path_in_repo'])

        def export():
            now['at'], now['score'] = next(runs)
            for f in ('out/x.onnx', 'out/x.onnx.json', 'out/samples/saif_gulf_1.wav'):
                Path(f).write_text(now['at'])
            Path('snap.ckpt').write_text(now['at'])
            return now['at']

        def out(cmd, env=None):
            self.assertEqual(env['CUDA_VISIBLE_DEVICES'], '1', 'the card that is not training')
            if now['score'] is None:
                raise RuntimeError('Whisper fell over')
            return 'loading...\nSCORE ' + str(now['score'])

        cwd = os.getcwd()
        with tempfile.TemporaryDirectory() as d:
            os.chdir(d)
            try:
                Path('out/samples').mkdir(parents=True)
                Path('data').mkdir()
                Path('data/saif.report.json').write_text('{}')
                ns = dict(os=os, time=time, shutil=shutil, Path=Path, W=Path(d), gpus=['T4', 'T4'], PY_W='py', WHISPER='w', VOICE='saif',
                          NAME='x', CKPT='ckpt/saif_gulf_r2.ckpt', MODEL_REPO='r', api=Api(), out=out, export=export, print=lambda *a: None)
                exec(part, ns)
                got = [ns['upload']() for _ in range(3)] + [ns['upload'](final=True)]
                self.assertEqual(got[-1], 'epoch 16 step 400')
                self.assertEqual([s for _, _, s in ns['SCORES']], [0.5, 0.8, None, 0.6])
                self.assertTrue(Path('out/best/from.txt').read_text().startswith('epoch 8 step 200, clarity 0.8'))
                self.assertEqual(Path('out/best/x.onnx').read_text(), 'epoch 8 step 200')
                self.assertEqual(Path('out/best/saif_gulf_1.wav').read_text(), 'epoch 8 step 200')
                self.assertEqual(Path('out/x.onnx').read_text(), 'epoch 16 step 400', 'the newest stays the main file')
                self.assertEqual(sent.count('ckpt/saif_gulf_r2.ckpt'), 4)
                self.assertIn('best/x.onnx', sent[-2])
            finally:
                os.chdir(cwd)


if __name__ == '__main__':
    unittest.main()
