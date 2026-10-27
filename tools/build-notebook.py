"""Builds train/omran-voices-piper.ipynb, the Kaggle notebook that trains the light voice model.

  python3 tools/build-notebook.py

The notebook must stand alone (Kaggle cannot read this private repo), so the scripts in train/ are
written into it. tests/train.test.cjs checks the committed notebook equals a fresh build.
"""
import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / 'train' / 'omran-voices-piper.ipynb'


def md(text):
    return {'cell_type': 'markdown', 'metadata': {}, 'source': text.strip('\n').splitlines(True)}


def code(text):
    return {'cell_type': 'code', 'execution_count': None, 'metadata': {}, 'outputs': [],
            'source': text.strip('\n').splitlines(True)}


def writefile(name, body):
    return code(f'%%writefile {name}\n' + body.rstrip('\n') + '\n')


INTRO = '''
# تدريب صوتين خفيفين (رجل وامرأة) لعمران

النتيجة: نموذجين **Piper** صغار بالفصحى، واحد لكل صوت، يشتغلون على أي معالج بسرعة، ويتحفظون في مستودعك
الخاص `omran77/omran-voices-piper` على Hugging Face. المعلّم **Audar-TTS** (عربي أولًا، تجاري مسموح) يقرا ٧٠٠ جملة
فصحى مشكّلة بصوت كل متبرع، والنموذج الخفيف يتعلّم منها. كل شي مجاني. يشتغل على **Kaggle** أو **Google Colab**.

**قبل أول تشغيل (مرة وحدة):** وافق على شروط https://huggingface.co/neuphonic/neucodec بحسابك في Hugging Face
(Audar يحتاجه). بدونها النوتبوك يوقف أول شي ويقول لك.

**على Google Colab (بدون رقم جوال):**
1. https://colab.research.google.com ← **File** ← **Upload notebook** ← اختر هالملف.
2. **Runtime** ← **Change runtime type** ← **T4 GPU** ← Save.
3. يسار الصفحة أيقونة المفتاح 🔑 (Secrets) ← **Add new secret**: الاسم `HF_TOKEN` والقيمة مفتاح Hugging Face من نوع
   **Write** (نفس `HF_WRITE_TOKEN` اللي في Vercel)، وفعّل **Notebook access**.
4. **Runtime** ← **Run all**. لو طلع تحذير إن النوتبوك مب من Google ← **Run anyway**.
   خلّ الصفحة مفتوحة والجهاز ما ينام. لو Colab قطع: **Run all** مرة ثانية، ويكمل من وين وقف.

**على Kaggle (يحتاج تأكيد رقم الجوال):** Settings ← Accelerator **GPU T4 x2** و Internet **On**، و Add-ons ← Secrets
← `HF_TOKEN` (✓)، ثم Save Version ← **Save & Run All (Commit)**. يشتغل بروحه حتى لو سكّرت الصفحة.

كل نص ساعة يرفع آخر نسخة من الصوتين، وعيّنات تسمعها في المستودع (`samples/`)، والسجلات (`logs/`).
تشغيلة ثانية تكمل من آخر نسخة وتستخدم نفس البيانات.
'''

CONFIG = '''
# ===== الإعدادات =====
VOICES = [('v5', 'm'), ('v4', 'f')]   # (صوت المتبرع في omran-voices-donors، اسمه في النموذج): رجل، امرأة
SENTENCES_PER_VOICE = 700             # تقريبًا ساعة كلام لكل صوت
MODEL_REPO = 'omran77/omran-voices-piper'
DONORS_REPO = 'omran77/omran-voices-donors'
SENTENCES_URL = 'https://omran-voices.vercel.app/data/sentences.json'
SESSION_HOURS = 11.5                  # أطول جلسة (Kaggle ١٢ ساعة؛ Colab ممكن يقطع قبل، والرفع كل ساعة يحفظ الشغل)
UPLOAD_EVERY_MIN = 30                 # Colab يقطع بدون إنذار: نسخة كل نص ساعة
VOICE_FILE = 'ar_AE-omran_{}_fusha-medium'  # ملف لكل صوت: ar_AE-omran_m_fusha-medium.onnx و …_f_fusha-…
DATA_TAR = 'data/fusha-data.tar'            # بيانات الفصحى (data/train-data.tar القديمة خليجية من المحرك الأول، ما تنستخدم)
'''

SETUP = '''
import base64, json, os, shutil, subprocess, tarfile, time, urllib.request
from pathlib import Path

T0 = time.time()
# Kaggle keeps /kaggle/working after the run and caps it at 20 GB. The two Python environments (several
# GB each) and Piper's checkpoints (~850 MB each, six by default) can pass that, so on Kaggle the work
# happens outside it, in space it does not keep: everything worth keeping goes to the Hugging Face repo.
W = Path('/tmp/omran') if Path('/kaggle/working').exists() else next(p for p in (Path('/content'), Path.cwd()) if p.exists())
W.mkdir(parents=True, exist_ok=True)
os.chdir(W)
print('working in', W, '-', shutil.disk_usage(W).free // 2**30, 'GB free')


def run(cmd, log=None):
    """Runs a command and shows its output here (the notebook hides a child process's own output)."""
    p = subprocess.Popen(cmd, shell=isinstance(cmd, str), stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True)
    tail = []
    for line in p.stdout:
        tail = (tail + [line])[-40:]
        if log is None:
            print(line, end='')
    if p.wait() != 0:
        # the cause goes into the error itself: it is the red text under the cell
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
from huggingface_hub import HfApi, hf_hub_download
api = HfApi(token=HF_TOKEN)
print('Hugging Face account:', api.whoami()['name'])

gpus = [g for g in subprocess.run(['nvidia-smi', '--query-gpu=name', '--format=csv,noheader'],
                                  capture_output=True, text=True).stdout.splitlines() if g.strip()]
print('GPUs:', gpus)
assert gpus, 'ما في كرت: Colab ← Runtime ← Change runtime type ← T4 GPU (أو Kaggle ← Accelerator ← GPU T4 x2)'
if not all('T4' in g for g in gpus):
    print('تنبيه: الأفضل T4 (الكرت P100 قديم على هالمكتبات).')

api.create_repo(MODEL_REPO, private=True, exist_ok=True)
assert api.model_info(MODEL_REPO).private, MODEL_REPO + ' لازم يكون Private'
REPO_FILES = set(api.list_repo_files(MODEL_REPO))
try:  # the teacher's codec is gated: without the accepted terms nothing below can work
    hf_hub_download('neuphonic/neucodec', 'meta.yaml', token=HF_TOKEN)
except Exception as e:
    raise RuntimeError('وافق على شروط https://huggingface.co/neuphonic/neucodec بحسابك في Hugging Face، وبعدين شغّل مرة ثانية') from e
'''

ENVS = '''
# Two separate Python 3.11 environments: the teacher (Audar, makes the data) and Piper (trains),
# each with the exact versions it was written for, away from the notebook's own packages.
# A file ".ok" marks an environment as finished, so a half-made one is made again.
run('pip install -q uv')
PY_A, PY_B = str(W / 'envA/bin/python'), str(W / 'envB/bin/python')
TORCH = 'torch==2.6.0 torchaudio==2.6.0'
CU = '--index-url https://download.pytorch.org/whl/cu124'
if not Path('envA/.ok').exists():
    # the teacher on the GPU (Transformers, as its reference code) and its codec neucodec, with the
    # versions that load together on torch 2.8 (checked: imports ok)
    run('rm -rf envA && uv venv envA --python 3.11 --seed -q')
    run(f'uv pip install -q --python {PY_A} torch==2.8.0 torchaudio==2.8.0 --index-url https://download.pytorch.org/whl/cu126')
    run(f'uv pip install -q --python {PY_A} neucodec==0.0.6 torch==2.8.0 torchaudio==2.8.0 torchao==0.13.0 '
        '"transformers>=4.57,<5" librosa soundfile huggingface_hub')
    Path('envA/.ok').touch()
if not Path('envB/.ok').exists():
    # Piper from PyPI (its espeak part comes built). Building it from source needs cmake, and
    # cmake 4 refuses older projects.
    run('rm -rf envB && uv venv envB --python 3.11 --seed -q')
    run(f'uv pip install -q --python {PY_B} {TORCH} {CU}')
    run(f'uv pip install -q --python {PY_B} "piper-tts[train]==1.8.0" cython numpy "setuptools<81" huggingface_hub {TORCH}')
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
run([PY_A, '-c', 'import neucodec, torch, transformers; print("teacher ok, GPU:", torch.cuda.is_available(), transformers.__version__)'])
run([PY_B, '-c', 'from piper.train.vits.monotonic_align import maximum_path; from piper.phonemize_espeak import EspeakPhonemizer;'
                 ' print("piper ok", EspeakPhonemizer().phonemize("ar", "هلا والله"))'])
'''

DATA = '''
# The donors' samples (private dataset) and our sentences.
def donors():
    names = [f for f in api.list_repo_files(DONORS_REPO, repo_type='dataset') if f.endswith('.json')]
    name = 'voices.json' if 'voices.json' in names else names[0]
    return {v['id']: v for v in json.loads(Path(hf_hub_download(DONORS_REPO, name, repo_type='dataset', token=HF_TOKEN)).read_text())}

dv = donors()
for vid, spk in VOICES:
    v = dv[vid]
    assert v.get('consent') is True, vid + ': no consent'
    if v.get('data'):
        Path(f'ref_{spk}.wav').write_bytes(base64.b64decode(v['data']))
    else:
        shutil.copy(hf_hub_download(DONORS_REPO, v['file'], repo_type='dataset', token=HF_TOKEN), f'ref_{spk}.wav')
    print(spk, '<-', vid, v.get('gender'), v.get('seconds'), 's')
urllib.request.urlretrieve(SENTENCES_URL, 'sentences.json')
print(len(json.loads(Path('sentences.json').read_text())), 'sentences')
# the teacher reads the sentences with Piper's own diacritics: exactly the vowels Piper will be given
run([PY_B, 'prep_train.py', 'vowel', '--sentences', 'sentences.json', '--count', str(SENTENCES_PER_VOICE),
     '--parts', str(len(VOICES)), '--out', 'vowelled.json'])
'''

GENERATE = '''
# Step 1: the teacher reads ~700 formal sentences in each voice (one voice per GPU). What is made is
# saved in the repo every 20 minutes, so a run cut off (Colab) continues where it stopped.

def save_data():
    with tarfile.open('train-data.tar', 'w') as t:
        t.add('data')
    api.upload_file(path_or_fileobj='train-data.tar', path_in_repo=DATA_TAR, repo_id=MODEL_REPO, commit_message='training data')


def clips(spk, ext='tsv'):
    p = Path(f'data/{spk}.{ext}')
    return len(p.read_text(encoding='utf-8').splitlines()) if p.exists() else 0


if DATA_TAR in REPO_FILES and not Path('data').exists():
    with tarfile.open(hf_hub_download(MODEL_REPO, DATA_TAR, token=HF_TOKEN)) as t:
        t.extractall('.')
    print('data from an earlier run:', {spk: (clips(spk), clips(spk, 'rejected')) for _, spk in VOICES})

# a voice is done when every one of its sentences was tried (kept, or refused by the length check)
todo = [(k, spk) for k, (vid, spk) in enumerate(VOICES) if clips(spk) + clips(spk, 'rejected') < SENTENCES_PER_VOICE - 2]
running, last_save = [], time.time()
while todo or running:
    while todo and len(running) < len(gpus):
        k, spk = todo.pop(0)
        gpu = min(set(range(len(gpus))) - {g for _, _, g in running})
        env = dict(os.environ, CUDA_VISIBLE_DEVICES=str(gpu), HF_TOKEN=HF_TOKEN)
        cmd = [PY_A, 'gen_data.py', '--ref', f'ref_{spk}.wav', '--speaker', spk, '--part', str(k),
               '--count', str(SENTENCES_PER_VOICE), '--sentences', 'sentences.json',
               '--vowelled', 'vowelled.json', '--out', 'data', '--max-minutes', '150']
        running.append((spk, subprocess.Popen(cmd, env=env, stdout=open(f'gen_{spk}.log', 'a'), stderr=subprocess.STDOUT), gpu))
    time.sleep(120)
    for item in list(running):
        spk, p, _ = item
        lines = Path(f'gen_{spk}.log').read_text(errors='replace').splitlines()
        print(time.strftime('%H:%M'), lines[-1] if lines else '...')
        if p.poll() is not None:
            running.remove(item)
            if p.returncode != 0:
                print('\\n'.join(lines[-30:]))
                raise RuntimeError(spk + ' failed')
    if time.time() - last_save > 20 * 60 or not (todo or running):
        save_data()
        last_save = time.time()
for _, spk in VOICES:
    rows = Path(f'data/{spk}.tsv').read_text(encoding='utf-8').splitlines()
    secs = sum((Path('data/wav') / ln.split('\\t')[0]).stat().st_size - 44 for ln in rows) / 2 / 22050
    print(f'{spk}: {len(rows)} clips, {secs / 60:.0f} minutes')
'''

TRAIN = '''
# Step 2: each voice is its own Piper model, both training at once (one per GPU; on Colab they share it).
# Each starts from the Arabic voice "kareem" (formal Arabic, like the data) with every layer in place, so
# it speaks clearly from the start and moves toward the donor's voice (or continues from its own last
# saved version, on a second run). A model with both voices had new speaker layers that start random:
# it spoke gibberish.
# It stops in time to export and upload.
def voice_file(spk):
    return VOICE_FILE.format(spk)


def ckpt(spk):  # in the repo; ckpt/m.ckpt and ckpt/f.ckpt are the Gulf run's, not continued
    return f'ckpt/{spk}_fusha.ckpt'


KAREEM = [f.path for f in HfApi().list_repo_tree('rhasspy/piper-checkpoints', path_in_repo='ar/ar_JO/kareem/medium',
                                                 repo_type='dataset') if f.path.endswith('.ckpt')][0]
left = hours_left() - 0.6  # export and upload need ~30 minutes
assert left > 0.5, 'not enough time left in this session'
hh, mm = int(left), int((left - int(left)) * 60)
Path('out').mkdir(exist_ok=True)
trains = {}
for k, (_, spk) in enumerate(VOICES):
    run([PY_B, 'prep_train.py', 'list', '--data', 'data', '--speaker', spk, '--out', f'data/{spk}.csv'])
    if ckpt(spk) in REPO_FILES:
        warm = hf_hub_download(MODEL_REPO, ckpt(spk), token=HF_TOKEN)
        print(spk, 'continues from its last saved version')
    else:
        warm = hf_hub_download('rhasspy/piper-checkpoints', KAREEM, repo_type='dataset')
        print(spk, 'starts from', KAREEM)
    cmd = [PY_B, 'train_main.py', 'fit',
           '--data.voice_name', voice_file(spk), '--data.csv_path', f'data/{spk}.csv', '--data.audio_dir', 'data/wav',
           '--model.sample_rate', '22050', '--data.espeak_voice', 'ar', '--data.cache_dir', f'cache/{spk}',
           '--data.trim_silence', 'false',  # gen_data.py already trimmed; Piper's own trim can leave a clip too short to train on
           '--data.config_path', f'out/{voice_file(spk)}.onnx.json', '--data.batch_size', '16', '--data.num_workers', '2',
           '--model.warmstart_ckpt', warm, '--model.mos_metric', 'none',
           '--trainer.accelerator', 'gpu', '--trainer.devices', '1', '--trainer.max_time', f'00:{hh:02d}:{mm:02d}:00',
           '--trainer.default_root_dir', f'runs/{spk}']
    print(' '.join(cmd))
    env = dict(os.environ, CUDA_VISIBLE_DEVICES=str(k % len(gpus)))
    trains[spk] = subprocess.Popen(cmd, env=env, stdout=open(f'train_{spk}.log', 'w'), stderr=subprocess.STDOUT)


def export(spk):
    cks = sorted(W.glob(f'runs/{spk}/lightning_logs/version_*/checkpoints/last.ckpt'), key=lambda p: p.stat().st_mtime)
    if not cks:
        print(spk, 'no checkpoint yet')
        return False
    shutil.copy(cks[-1], f'snap_{spk}.ckpt')
    onnx = f'out/{voice_file(spk)}.onnx'
    try:
        run([PY_B, '-m', 'piper.train.export_onnx', '--checkpoint', f'snap_{spk}.ckpt', '--output-file', onnx], log=False)
        run([PY_B, 'samples.py', onnx, 'out/samples', f'{spk}_fusha'], log=False)
    except RuntimeError as e:
        print(spk, 'export failed this time:', e)
        return False
    return True


def upload(final=False):
    # the logs go too, so a run that stops can be read on Hugging Face
    done = [spk for _, spk in VOICES if export(spk)]
    Path('out/logs').mkdir(parents=True, exist_ok=True)
    for f in W.glob('*.log'):
        shutil.copy(f, 'out/logs')
    api.upload_folder(folder_path='out', repo_id=MODEL_REPO, commit_message='models' + (' (final)' if final else ''))
    for spk in done:
        api.upload_file(path_or_fileobj=f'snap_{spk}.ckpt', path_in_repo=ckpt(spk), repo_id=MODEL_REPO,
                        commit_message='checkpoint ' + spk)
    print(time.strftime('%H:%M'), 'uploaded', done, 'to', MODEL_REPO)


last_up, ended = time.time(), set()
while len(ended) < len(trains):
    time.sleep(300)
    for spk, p in trains.items():
        if spk in ended:
            continue
        log = Path(f'train_{spk}.log').read_text(errors='replace')
        if p.poll() is None:
            lines = log.splitlines()
            print(time.strftime('%H:%M'), spk, (lines[-1] if lines else '...')[-200:])
        else:
            ended.add(spk)
            print(time.strftime('%H:%M'), spk, 'training ended, code', p.returncode)
            print(log[-3000:])
    if len(ended) < len(trains) and time.time() - last_up > UPLOAD_EVERY_MIN * 60:
        upload()
        last_up = time.time()
upload(final=True)
print('done in', round((time.time() - T0) / 3600, 1), 'hours')
'''


def build():
    cells = [
        md(INTRO),
        code(CONFIG),
        code(SETUP),
        writefile('gen_data.py', (ROOT / 'train' / 'gen_data.py').read_text(encoding='utf-8')),
        writefile('prep_train.py', (ROOT / 'train' / 'prep_train.py').read_text(encoding='utf-8')),
        writefile('samples.py', (ROOT / 'train' / 'samples.py').read_text(encoding='utf-8')),
        writefile('train_main.py', (ROOT / 'train' / 'train_main.py').read_text(encoding='utf-8')),
        code(ENVS),
        code(DATA),
        code(GENERATE),
        code(TRAIN),
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
    OUT.write_text(text, encoding='utf-8')
    print('wrote', OUT.relative_to(ROOT))
