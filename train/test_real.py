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


if __name__ == '__main__':
    unittest.main()
