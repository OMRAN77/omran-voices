"""Builds train/omran-voices-piper.ipynb, the Kaggle notebook that trains the light voice model.

  python3 tools/build-notebook.py          (needs node, for the dialect rules of api/_dialect.js)

The notebook must stand alone (Kaggle cannot read this private repo), so the scripts in train/,
engine-local/requirements.txt and the dialect rules are written into it. tests/train.test.cjs
checks the committed notebook equals a fresh build.
"""
import json
import subprocess
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


def dialect_pairs():
    js = "const d=require('./api/_dialect.js');process.stdout.write(JSON.stringify(d.RULES.map(r=>[r.from,r.to])))"
    return json.loads(subprocess.run(['node', '-e', js], cwd=ROOT, capture_output=True, text=True, check=True).stdout)


INTRO = '''
# تدريب صوتين خفيفين (رجل وامرأة) لعمران

النتيجة: نموذج **Piper** واحد فيه صوتين، يشتغل على أي معالج بسرعة، ويتحفظ في مستودعك الخاص
`omran77/omran-voices-piper` على Hugging Face. كل شي مجاني. يشتغل على **Google Colab** أو **Kaggle**.

**على Google Colab (بدون رقم جوال):**
1. https://colab.research.google.com ← **File** ← **Upload notebook** ← اختر هالملف.
2. **Runtime** ← **Change runtime type** ← **T4 GPU** ← Save.
3. يسار الصفحة أيقونة المفتاح 🔑 (Secrets) ← **Add new secret**: الاسم `HF_TOKEN` والقيمة مفتاح Hugging Face من نوع
   **Write** (نفس `HF_WRITE_TOKEN` اللي في Vercel)، وفعّل **Notebook access**.
4. **Runtime** ← **Run all**. لو طلع تحذير إن النوتبوك مب من Google ← **Run anyway**.
   خلّ الصفحة مفتوحة والجهاز ما ينام. لو Colab قطع: **Run all** مرة ثانية، ويكمل من وين وقف.

**على Kaggle (يحتاج تأكيد رقم الجوال):** Settings ← Accelerator **GPU T4 x2** و Internet **On**، و Add-ons ← Secrets
← `HF_TOKEN` (✓)، ثم Save Version ← **Save & Run All (Commit)**. يشتغل بروحه حتى لو سكّرت الصفحة.

كل ساعة يرفع آخر نسخة من النموذج وعيّنات تسمعها في المستودع (`samples/`). تشغيلة ثانية تكمل من آخر نسخة
وتستخدم نفس البيانات.
'''

CONFIG = '''
# ===== الإعدادات =====
VOICES = [('v5', 'm'), ('v4', 'f')]   # (صوت المتبرع في omran-voices-donors، اسمه في النموذج): رجل، امرأة
SENTENCES_PER_VOICE = 700             # تقريبًا ساعة كلام لكل صوت
MODEL_REPO = 'omran77/omran-voices-piper'
DONORS_REPO = 'omran77/omran-voices-donors'
SENTENCES_URL = 'https://omran-voices.vercel.app/data/sentences.json'
SESSION_HOURS = 11.5                  # أطول جلسة (Kaggle ١٢ ساعة؛ Colab ممكن يقطع قبل، والرفع كل ساعة يحفظ الشغل)
UPLOAD_EVERY_MIN = 60
VOICE_FILE = 'ar_AE-omran-medium'
'''

SETUP = '''
import base64, json, os, shutil, subprocess, tarfile, time, urllib.request
from pathlib import Path

T0 = time.time()
W = next(p for p in (Path('/kaggle/working'), Path('/content'), Path.cwd()) if p.exists())
os.chdir(W)


def run(cmd, log=None):
    """Runs a command and shows its output here (the notebook hides a child process's own output)."""
    p = subprocess.Popen(cmd, shell=isinstance(cmd, str), stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True)
    tail = []
    for line in p.stdout:
        tail = (tail + [line])[-40:]
        if log is None:
            print(line, end='')
    if p.wait() != 0:
        print(''.join(tail))
        raise RuntimeError(f'failed ({p.returncode}): {cmd}')


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
'''

ENVS = '''
# Two separate Python 3.11 environments: the voice engine (makes the data) and Piper (trains),
# each with the exact versions it was written for, away from the notebook's own packages.
run('pip install -q uv')
PY_A, PY_B = str(W / 'envA/bin/python'), str(W / 'envB/bin/python')
TORCH = 'torch==2.6.0 torchaudio==2.6.0'
CU = '--index-url https://download.pytorch.org/whl/cu124'
if not Path(PY_A).exists():
    run('uv venv envA --python 3.11 --seed -q')
    run(f'uv pip install -q --python {PY_A} {TORCH} {CU}')
    run(f'uv pip install -q --python {PY_A} -r reqA.txt {TORCH}')
    run(f'uv pip install -q --python {PY_A} --no-deps chatterbox-tts==0.1.7')
if not Path(PY_B).exists():
    if not Path('piper1-gpl').exists():
        run('git clone -q https://github.com/OHF-voice/piper1-gpl.git piper1-gpl')
        run('cd piper1-gpl && (git checkout -q v1.8.0 || echo "no tag v1.8.0: using main")')
    run('uv venv envB --python 3.11 --seed -q')
    run(f'uv pip install -q --python {PY_B} {TORCH} {CU}')
    run(f'{PY_B} -m pip install -q scikit-build cmake ninja cython wheel "setuptools<81" numpy huggingface_hub')
    run(f'cd piper1-gpl && {PY_B} -m pip install -q -e ".[train]"')
    run(f'cd piper1-gpl && PATH={W}/envB/bin:$PATH ./build_monotonic_align.sh && {PY_B} setup.py build_ext --inplace')
run([PY_A, '-c', 'from chatterbox.mtl_tts import ChatterboxMultilingualTTS; print("voice engine ok")'])
run([PY_B, '-c', 'from piper.phonemize_espeak import EspeakPhonemizer; print("piper ok", EspeakPhonemizer().phonemize("ar", "هلا والله"))'])
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
'''

GENERATE = '''
# Step 1: the engine reads ~700 sentences in each voice (one voice per GPU). What is made is saved
# in the repo every 20 minutes, so a run cut off (Colab) continues where it stopped.
DATA_TAR = 'data/train-data.tar'


def save_data():
    with tarfile.open('train-data.tar', 'w') as t:
        t.add('data')
    api.upload_file(path_or_fileobj='train-data.tar', path_in_repo=DATA_TAR, repo_id=MODEL_REPO, commit_message='training data')


def clips(spk):
    p = Path(f'data/{spk}.tsv')
    return len(p.read_text(encoding='utf-8').splitlines()) if p.exists() else 0


if DATA_TAR in REPO_FILES and not Path('data').exists():
    with tarfile.open(hf_hub_download(MODEL_REPO, DATA_TAR, token=HF_TOKEN)) as t:
        t.extractall('.')
    print('data from an earlier run:', {spk: clips(spk) for _, spk in VOICES})

# a voice with 85% of its sentences is done (the rest were refused by the length check)
todo = [(k, spk) for k, (vid, spk) in enumerate(VOICES) if clips(spk) < 0.85 * SENTENCES_PER_VOICE]
running, last_save = [], time.time()
while todo or running:
    while todo and len(running) < len(gpus):
        k, spk = todo.pop(0)
        gpu = min(set(range(len(gpus))) - {g for _, _, g in running})
        env = dict(os.environ, CUDA_VISIBLE_DEVICES=str(gpu), HF_TOKEN=HF_TOKEN)
        cmd = [PY_A, 'gen_data.py', '--ref', f'ref_{spk}.wav', '--speaker', spk, '--part', str(k),
               '--count', str(SENTENCES_PER_VOICE), '--sentences', 'sentences.json',
               '--dialect', 'dialect.json', '--out', 'data', '--max-minutes', '150']
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
# Step 2: Piper learns both voices in one model. It starts from the Arabic voice "kareem"
# (or from the last saved version, on a second run), and stops in time to export and upload.
run([PY_B, 'prep_train.py', '--data', 'data', '--out', 'data/metadata.csv'])
if 'ckpt/last.ckpt' in REPO_FILES:
    warm = hf_hub_download(MODEL_REPO, 'ckpt/last.ckpt', token=HF_TOKEN)
    print('continuing from the last saved version')
else:
    base = [f.path for f in HfApi().list_repo_tree('rhasspy/piper-checkpoints', path_in_repo='ar/ar_JO/kareem/medium',
                                                    repo_type='dataset') if f.path.endswith('.ckpt')]
    warm = hf_hub_download('rhasspy/piper-checkpoints', base[0], repo_type='dataset')
    print('starting from', base[0])

left = hours_left() - 0.6  # export and upload need ~30 minutes
assert left > 0.5, 'not enough time left in this session'
hh, mm = int(left), int((left - int(left)) * 60)
Path('out').mkdir(exist_ok=True)
cmd = [PY_B, 'train_main.py', 'fit',
       '--data.voice_name', VOICE_FILE, '--data.csv_path', 'data/metadata.csv', '--data.audio_dir', 'data/wav',
       '--model.sample_rate', '22050', '--data.espeak_voice', 'ar', '--data.cache_dir', 'cache',
       '--data.trim_silence', 'false',  # gen_data.py already trimmed; Piper's own trim can leave a clip too short to train on
       '--data.config_path', 'out/config.json', '--data.batch_size', '16', '--data.num_workers', '2',
       '--model.num_speakers', str(len(VOICES)), '--model.warmstart_ckpt', warm, '--model.mos_metric', 'none',
       '--trainer.accelerator', 'gpu', '--trainer.devices', '1', '--trainer.max_time', f'00:{hh:02d}:{mm:02d}:00',
       '--trainer.default_root_dir', 'runs']
print(' '.join(cmd))
train = subprocess.Popen(cmd, stdout=open('train.log', 'w'), stderr=subprocess.STDOUT)


def export_and_upload(final=False):
    cks = sorted(W.glob('runs/lightning_logs/version_*/checkpoints/last.ckpt'), key=lambda p: p.stat().st_mtime)
    if not cks:
        print('no checkpoint yet')
        return
    shutil.copy(cks[-1], 'snap.ckpt')
    try:
        run([PY_B, '-m', 'piper.train.export_onnx', '--checkpoint', 'snap.ckpt', '--output-file', f'out/{VOICE_FILE}.onnx'], log=False)
        shutil.copy('out/config.json', f'out/{VOICE_FILE}.onnx.json')
        run([PY_B, 'samples.py', f'out/{VOICE_FILE}.onnx', 'out/samples'], log=False)
    except RuntimeError as e:
        print('export failed this time:', e)
        return
    api.upload_folder(folder_path='out', repo_id=MODEL_REPO, commit_message='model' + (' (final)' if final else ''))
    api.upload_file(path_or_fileobj='snap.ckpt', path_in_repo='ckpt/last.ckpt', repo_id=MODEL_REPO, commit_message='checkpoint')
    print(time.strftime('%H:%M'), 'uploaded to', MODEL_REPO)


last_up = time.time()
while train.poll() is None:
    time.sleep(300)
    lines = Path('train.log').read_text(errors='replace').splitlines()
    print(time.strftime('%H:%M'), (lines[-1] if lines else '...')[-200:])
    if time.time() - last_up > UPLOAD_EVERY_MIN * 60:
        export_and_upload()
        last_up = time.time()
print(Path('train.log').read_text(errors='replace')[-3000:])
export_and_upload(final=True)
print('done in', round((time.time() - T0) / 3600, 1), 'hours')
'''


def build():
    req = (ROOT / 'engine-local' / 'requirements.txt').read_text(encoding='utf-8')
    cells = [
        md(INTRO),
        code(CONFIG),
        code(SETUP),
        writefile('reqA.txt', req),
        writefile('dialect.json', json.dumps(dialect_pairs(), ensure_ascii=False, indent=0)),
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
