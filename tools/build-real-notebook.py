"""Builds train/omran-voice-real.ipynb: the Kaggle/Colab notebook that trains a light (Piper) voice
from one person's real recordings.

  python3 tools/build-real-notebook.py

The notebook must stand alone, so the scripts in train/ and the site's api/piper.py (its diacritizer)
are written into it. train/test_real.py checks the committed notebook equals a fresh build.
"""
import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / 'train' / 'omran-voice-real.ipynb'


def md(text):
    return {'cell_type': 'markdown', 'metadata': {}, 'source': text.strip('\n').splitlines(True)}


def code(text):
    return {'cell_type': 'code', 'execution_count': None, 'metadata': {}, 'outputs': [],
            'source': text.strip('\n').splitlines(True)}


def writefile(name, body):
    return code(f'%%writefile {name}\n' + body.rstrip('\n') + '\n')


INTRO = '''
# تدريب صوت خاص من تسجيلات حقيقية

النتيجة: نموذج **Piper** صغير بصوت الشخص نفسه وبلهجته، يتعلّم من تسجيلاته في صفحة التسجيل (المستودع الخاص
`omran77/omran-voices-recordings`)، وينحفظ في المستودع الخاص `omran77/omran-voices-piper`. كل شي مجاني.

**على Kaggle:** يمين الصفحة ← Settings ← Accelerator **GPU T4 x2** و Internet **On**. فوق ← Add-ons ← Secrets ←
علّم على `HF_TOKEN` (مفتاح Hugging Face من نوع **Write**، نفس اللي استخدمته المرة اللي فاتت). بعدين فوق يمين
**Save Version** ← **Save & Run All (Commit)**. يشتغل بروحه حتى لو سكّرت الصفحة.

**على Google Colab:** Runtime ← Change runtime type ← **T4 GPU**، وأيقونة المفتاح 🔑 يسار ← `HF_TOKEN` مع
**Notebook access**، ثم Runtime ← **Run all** والصفحة مفتوحة.

التشغيلة تاخذ تقريبًا ١٠ ساعات (التدريب ٩). لما يخلص: انزل لآخر الصفحة وتلقى العيّنات تسمعها على طول. تشغيلة
ثانية تكمل التدريب من آخر نسخة، وتاخذ أي تسجيلات جديدة انضافت.
'''

CONFIG = '''
# ===== الإعدادات =====
SPEAKER = 'سيف'                        # الاسم مثل ما انكتب في صفحة التسجيل
VOICE = 'saif'                         # اسم الصوت في الملفات (حروف إنجليزي صغيرة)
REC_REPO = 'omran77/omran-voices-recordings'
MODEL_REPO = 'omran77/omran-voices-piper'
SENTENCE_URLS = ['https://omran-voices.vercel.app/data/sentences.json', 'https://omran-voices.vercel.app/data/dialects.json']
WHISPER = 'large-v3'                   # يفرّغ التسجيلات (التسجيل المتواصل ما له نص)
TRAIN_HOURS = 9.0                      # وقت التدريب في هالتشغيلة (كرت T4 يمشي ~٠٫٧ خطوة بالثانية: ٩ ساعات ≈ ٢٢ ألف خطوة)؛ تشغيلة ثانية تكمل
ROUND = 2                              # يزيد لما تتغيّر طريقة تجهيز الصوت: التدريب يبدأ من جديد وما يكمل على نسخة تعلّمت من صوت مكتوم
SESSION_HOURS = 11.5                   # أطول جلسة (Kaggle ١٢ ساعة)
UPLOAD_EVERY_MIN = 30                  # نسخة وعيّنات كل نص ساعة
VOICE_FILE = 'ar_AE-{}_gulf-medium'    # ar_AE-saif_gulf-medium.onnx
'''

SETUP = '''
import json, os, shutil, subprocess, tarfile, time, urllib.request
from pathlib import Path

T0 = time.time()
# Kaggle keeps /kaggle/working after the run and caps it at 20 GB: the work happens outside it, and
# everything worth keeping goes to the Hugging Face repo.
W = Path('/tmp/omran') if Path('/kaggle/working').exists() else next(p for p in (Path('/content'), Path.cwd()) if p.exists())
W.mkdir(parents=True, exist_ok=True)
os.chdir(W)
print('working in', W, '-', shutil.disk_usage(W).free // 2**30, 'GB free')


def run(cmd, log=None, env=None):
    """Runs a command and shows its output here (the notebook hides a child process's own output)."""
    p = subprocess.Popen(cmd, shell=isinstance(cmd, str), stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True, env=env)
    tail = []
    for line in p.stdout:
        tail = (tail + [line])[-40:]
        if log is None:
            print(line, end='')
    if p.wait() != 0:
        raise RuntimeError(f'failed ({p.returncode}): {cmd}\\n' + ''.join(tail[-15:]))


def out(cmd):
    return subprocess.run(cmd, capture_output=True, text=True, check=True).stdout.strip()


def hours_left():
    return SESSION_HOURS - (time.time() - T0) / 3600


def secret(name):
    """The secret from Kaggle (Add-ons > Secrets) or Colab (the key icon), whichever this is."""
    try:
        from kaggle_secrets import UserSecretsClient
        return UserSecretsClient().get_secret(name)
    except ImportError:
        pass
    try:
        from google.colab import userdata
    except ImportError:
        return os.environ.get(name, '')
    try:
        return userdata.get(name)
    except Exception as e:
        raise RuntimeError('ضيف السر HF_TOKEN من أيقونة المفتاح يسار الصفحة، وفعّل Notebook access') from e


HF_TOKEN = (secret('HF_TOKEN') or '').strip()
assert HF_TOKEN.startswith('hf_'), 'السر HF_TOKEN ناقص أو مب مفتاح Hugging Face'
from huggingface_hub import HfApi, hf_hub_download, snapshot_download
api = HfApi(token=HF_TOKEN)
print('Hugging Face account:', api.whoami()['name'])

gpus = [g for g in subprocess.run(['nvidia-smi', '--query-gpu=name', '--format=csv,noheader'],
                                  capture_output=True, text=True).stdout.splitlines() if g.strip()]
print('GPUs:', gpus)
assert gpus, 'ما في كرت: Kaggle ← Settings ← Accelerator ← GPU T4 x2 (أو Colab ← Runtime ← Change runtime type ← T4 GPU)'

api.create_repo(MODEL_REPO, private=True, exist_ok=True)
assert api.model_info(MODEL_REPO).private, MODEL_REPO + ' لازم يكون Private'
assert api.dataset_info(REC_REPO).private, REC_REPO + ' لازم يكون Private'
REPO_FILES = set(api.list_repo_files(MODEL_REPO))
'''

ENVS = '''
# Two separate Python 3.11 environments: Whisper (writes the recordings as text) and Piper (trains),
# away from the notebook's own packages. A file ".ok" marks an environment as finished.
run('pip install -q uv')
PY_W, PY_B = str(W / 'envW/bin/python'), str(W / 'envB/bin/python')
TORCH = 'torch==2.6.0 torchaudio==2.6.0'
CU = '--index-url https://download.pytorch.org/whl/cu124'
if not Path('envW/.ok').exists():
    run('rm -rf envW && uv venv envW --python 3.11 --seed -q')
    run(f'uv pip install -q --python {PY_W} {TORCH} {CU}')
    run(f'uv pip install -q --python {PY_W} openai-whisper numpy scipy {TORCH}')
    Path('envW/.ok').touch()
if not Path('envB/.ok').exists():
    # Piper from PyPI (its espeak part comes built). Building it from source needs cmake, and
    # cmake 4 refuses older projects.
    run('rm -rf envB && uv venv envB --python 3.11 --seed -q')
    run(f'uv pip install -q --python {PY_B} {TORCH} {CU}')
    # Lightning is pinned: 2.6 changed when last.ckpt is written (train_main.py), and the next change should not find us on a 10-hour run.
    run(f'uv pip install -q --python {PY_B} "piper-tts[train]==1.8.0" "lightning==2.6.6" cython numpy "setuptools<81" huggingface_hub {TORCH}')
    # The alignment step is a small Cython file the PyPI package leaves out: build it from Piper's source.
    if not Path('piper1-gpl').exists():
        run('git clone -q --depth 1 --branch v1.8.0 https://github.com/OHF-voice/piper1-gpl.git piper1-gpl'
            ' || git clone -q --depth 1 https://github.com/OHF-voice/piper1-gpl.git piper1-gpl')
    mab = Path('mabuild')
    mab.mkdir(exist_ok=True)
    shutil.copy('piper1-gpl/src/piper/train/vits/monotonic_align/core.pyx', mab / 'core.pyx')
    (mab / 'setup.py').write_text('from setuptools import setup, Extension\\n'
                                  'from Cython.Build import cythonize\\n'
                                  'import numpy\\n'
                                  "setup(ext_modules=cythonize([Extension('core', ['core.pyx'], include_dirs=[numpy.get_include()])]))\\n")
    run(f'cd mabuild && {PY_B} setup.py -q build_ext --inplace')
    dest = Path(out([PY_B, '-c', 'import piper, os; print(os.path.dirname(piper.__file__))'])) / 'train/vits/monotonic_align/monotonic_align'
    dest.mkdir(parents=True, exist_ok=True)
    (dest / '__init__.py').touch()
    for so in mab.glob('core*.so'):
        shutil.copy(so, dest)
    Path('envB/.ok').touch()
run([PY_W, '-c', 'import whisper, torch, scipy; print("whisper ok, GPU:", torch.cuda.is_available())'])
run([PY_B, '-c', 'from piper.train.vits.monotonic_align import maximum_path; from piper.phonemize_espeak import EspeakPhonemizer;'
                 ' print("piper ok", EspeakPhonemizer().phonemize("ar", "هلا والله"))'])
'''

DATA = '''
# The person's recordings (private dataset) and our sentences.
key = SPEAKER.strip().lower().replace(' ', '_')
folders = [f.path for f in api.list_repo_tree(REC_REPO, path_in_repo='data', repo_type='dataset')
           if f.path.split('/')[-1].rsplit('-', 1)[0] == key]
assert folders, f'ما لقيت تسجيلات باسم «{SPEAKER}» في {REC_REPO}'
print('recordings of', SPEAKER, ':', folders)
snapshot_download(REC_REPO, repo_type='dataset', allow_patterns=[f + '/**' for f in folders], local_dir='rec', token=HF_TOKEN)
REC = 'rec/data'

sentences = []
for url in SENTENCE_URLS:
    try:
        with urllib.request.urlopen(url, timeout=60) as r:
            sentences += json.loads(r.read().decode('utf-8'))
    except Exception as e:  # the dialect file may not be there: the 10 000 are enough
        print('skipped', url, type(e).__name__)
assert sentences, 'ما قدرت أحمّل الجمل'
Path('sentences.json').write_text(json.dumps(sentences, ensure_ascii=False), encoding='utf-8')
print(len(sentences), 'sentences')
'''

PREPARE = '''
# Step 1: the recordings become clips with their text. Whisper's words are kept in the repo, so a
# second run only transcribes what was recorded since.
WORDS = f'data/real-{VOICE}-words.json'
if WORDS in REPO_FILES and not Path('words.json').exists():
    shutil.copy(hf_hub_download(MODEL_REPO, WORDS, token=HF_TOKEN), 'words.json')
gpu_env = dict(os.environ, CUDA_VISIBLE_DEVICES='0')
run([PY_W, 'prep_real.py', 'transcribe', '--rec', REC, '--sentences', 'sentences.json', '--out', 'words.json', '--model', WHISPER], env=gpu_env)
api.upload_file(path_or_fileobj='words.json', path_in_repo=WORDS, repo_id=MODEL_REPO, commit_message='words ' + VOICE)

shutil.rmtree('data', ignore_errors=True)
run([PY_W, 'prep_real.py', 'cut', '--rec', REC, '--words', 'words.json', '--sentences', 'sentences.json', '--speaker', VOICE, '--out', 'data'])
run([PY_W, 'prep_real.py', 'check', '--data', 'data', '--speaker', VOICE, '--model', WHISPER], env=gpu_env)
report = json.loads(Path(f'data/{VOICE}.report.json').read_text(encoding='utf-8'))
print(f"{report['clips']} clips, {report['seconds'] / 60:.1f} minutes, {report['matched']} with the screen's spelling, misheard and dropped: {report.get('misheard', 0)}")
sound = report.get('sound', {})
print('SOUND: the recording is', sound.get('muffled_db'), 'dB under clear speech at 1.5-4 kHz;',
      f"repaired, now {sound.get('after_db')} dB" if sound.get('repaired') else 'clear enough, left as it is')
assert report['seconds'] >= 5 * 60, 'أقل من ٥ دقايق كلام صالح للتدريب: سجّل أكثر'
run([PY_B, 'prep_real.py', 'list', '--data', 'data', '--speaker', VOICE, '--out', f'data/{VOICE}.csv'])
with tarfile.open('real-data.tar', 'w') as t:
    t.add('data')
api.upload_file(path_or_fileobj='real-data.tar', path_in_repo=f'data/real-{VOICE}.tar', repo_id=MODEL_REPO, commit_message='training data ' + VOICE)
'''

TRAIN = '''
# Step 2: the voice starts from the Arabic voice "kareem" with every layer in place (or continues
# from its own last saved version), and moves toward the person's voice and way of speaking.
NAME = VOICE_FILE.format(VOICE)
CKPT = f'ckpt/{VOICE}_gulf_r{ROUND}.ckpt'
left = min(TRAIN_HOURS, hours_left() - 0.6)  # export and upload need ~30 minutes
assert left > 0.3, 'not enough time left in this session'
hh, mm = int(left), int((left - int(left)) * 60)
Path('out').mkdir(exist_ok=True)
if CKPT in REPO_FILES:
    warm = hf_hub_download(MODEL_REPO, CKPT, token=HF_TOKEN)
    print('continues from its last saved version')
else:
    kareem = [f.path for f in HfApi().list_repo_tree('rhasspy/piper-checkpoints', path_in_repo='ar/ar_JO/kareem/medium',
                                                     repo_type='dataset') if f.path.endswith('.ckpt')][0]
    warm = hf_hub_download('rhasspy/piper-checkpoints', kareem, repo_type='dataset')
    print('starts from', kareem)
cmd = [PY_B, 'train_main.py', 'fit',
       '--data.voice_name', NAME, '--data.csv_path', f'data/{VOICE}.csv', '--data.audio_dir', 'data/wav',
       '--model.sample_rate', '22050', '--data.espeak_voice', 'ar', '--data.cache_dir', f'cache/{VOICE}',
       '--data.trim_silence', 'false',  # prep_real.py cut the clips; Piper's own trim can leave a clip too short to train on
       '--data.config_path', f'out/{NAME}.onnx.json', '--data.batch_size', '16', '--data.num_workers', '2',
       '--model.warmstart_ckpt', warm, '--model.mos_metric', 'none',
       '--trainer.accelerator', 'gpu', '--trainer.devices', '1', '--trainer.max_time', f'00:{hh:02d}:{mm:02d}:00',
       '--trainer.default_root_dir', f'runs/{VOICE}']
print(' '.join(cmd))
train = subprocess.Popen(cmd, env=dict(os.environ, CUDA_VISIBLE_DEVICES='0'), stdout=open('train.log', 'w'), stderr=subprocess.STDOUT)


def export():
    """The newest checkpoint -> the voice file and its samples. Returns where in training it is from, or ''."""
    cks = sorted(W.glob(f'runs/{VOICE}/lightning_logs/version_*/checkpoints/last.ckpt'), key=lambda p: p.stat().st_mtime)
    if not cks:
        print('no checkpoint yet')
        return ''
    shutil.copy(cks[-1], 'snap.ckpt')
    try:
        at = out([PY_B, '-c', "import torch; c = torch.load('snap.ckpt', map_location='cpu', weights_only=False); "
                              "print('epoch', c['epoch'], 'step', c['global_step'])"])
        run([PY_B, '-m', 'piper.train.export_onnx', '--checkpoint', 'snap.ckpt', '--output-file', f'out/{NAME}.onnx'], log=False)
        run([PY_B, 'samples_real.py', f'out/{NAME}.onnx', 'out/samples', f'{VOICE}_gulf'], log=False)
    except (RuntimeError, subprocess.CalledProcessError) as e:
        print('export failed this time:', e)
        return ''
    return at


def upload(final=False):
    ok = export()
    Path('out/logs').mkdir(parents=True, exist_ok=True)
    for f in W.glob('*.log'):
        shutil.copy(f, 'out/logs')
    shutil.copy(f'data/{VOICE}.report.json', 'out/logs')
    api.upload_folder(folder_path='out', repo_id=MODEL_REPO, commit_message=f'{VOICE} voice' + (' (final)' if final else ''))
    if ok:
        api.upload_file(path_or_fileobj='snap.ckpt', path_in_repo=CKPT, repo_id=MODEL_REPO, commit_message='checkpoint ' + VOICE)
    print(time.strftime('%H:%M'), 'uploaded to', MODEL_REPO, f'(model and samples from {ok})' if ok else '(logs only)')
    return ok


last_up = time.time()
while train.poll() is None:
    time.sleep(300)
    lines = Path('train.log').read_text(errors='replace').splitlines()
    print(time.strftime('%H:%M'), (lines[-1] if lines else '...')[-200:])
    if train.poll() is None and time.time() - last_up > UPLOAD_EVERY_MIN * 60:
        upload()
        last_up = time.time()
print('training ended, code', train.returncode)
print(Path('train.log').read_text(errors='replace')[-3000:])
DONE = upload(final=True)
print('done in', round((time.time() - T0) / 3600, 1), 'hours')
'''

LISTEN = '''
# اسمع العيّنات هني. نفسها محفوظة في المستودع الخاص تحت samples/
from IPython.display import Audio, display
assert DONE, 'التدريب ما طلّع نموذج: شوف السجل فوق'
for p in sorted(Path('out/samples').glob(f'{VOICE}_gulf_*.wav')):
    print(p.name)
    display(Audio(filename=str(p)))
'''


def build():
    cells = [
        md(INTRO),
        code(CONFIG),
        code(SETUP),
        writefile('prep_real.py', (ROOT / 'train' / 'prep_real.py').read_text(encoding='utf-8')),
        writefile('samples_real.py', (ROOT / 'train' / 'samples_real.py').read_text(encoding='utf-8')),
        writefile('train_main.py', (ROOT / 'train' / 'train_main.py').read_text(encoding='utf-8')),
        writefile('piper_fn.py', (ROOT / 'api' / 'piper.py').read_text(encoding='utf-8')),
        code(ENVS),
        code(DATA),
        code(PREPARE),
        code(TRAIN),
        code(LISTEN),
    ]
    nb = {
        'cells': cells,
        'metadata': {
            'kernelspec': {'display_name': 'Python 3', 'language': 'python', 'name': 'python3'},
            'language_info': {'name': 'python'},
            'kaggle': {'accelerator': 'nvidiaTeslaT4', 'isInternetEnabled': True, 'isGpuEnabled': True},
        },
        'nbformat': 4,
        'nbformat_minor': 4,
    }
    return json.dumps(nb, ensure_ascii=False, indent=1) + '\n'


if __name__ == '__main__':
    text = build()
    if '--check' in sys.argv:
        sys.exit(0 if OUT.exists() and OUT.read_text(encoding='utf-8') == text else 1)
    OUT.write_text(text, encoding='utf-8', newline='\n')
    print('wrote', OUT.relative_to(ROOT))
