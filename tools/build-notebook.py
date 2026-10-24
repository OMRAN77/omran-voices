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
`omran77/omran-voices-piper` على Hugging Face. كل شي مجاني (كرت Kaggle المجاني).

**قبل التشغيل (مرة وحدة):**
1. يمين الصفحة ← **Settings** ← **Accelerator**: اختر **GPU T4 x2**.
2. **Settings** ← **Internet**: شغّله (Kaggle يطلب تأكيد رقم الجوال أول مرة).
3. فوق ← **Add-ons** ← **Secrets** ← **Add Secret**: الاسم `HF_TOKEN` والقيمة مفتاح Hugging Face من نوع **Write**
   (نفس `HF_WRITE_TOKEN` اللي في Vercel). علّم عليه ✓ عشان النوتبوك يستخدمه.

**التشغيل:** فوق يمين ← **Save Version** ← **Save & Run All (Commit)** ← Save. يشتغل بروحه حتى لو سكّرت
الصفحة (حوالي ١١ ساعة). كل ساعة يرفع آخر نسخة من النموذج وعيّنات تسمعها في المستودع (`samples/`).

**تبغى تحسّنه؟** شغّله مرة ثانية: يكمل من آخر نسخة ويستخدم نفس البيانات بدون ما يولّدها من جديد.
'''

CONFIG = '''
# ===== الإعدادات =====
VOICES = [('v5', 'm'), ('v4', 'f')]   # (صوت المتبرع في omran-voices-donors، اسمه في النموذج): رجل، امرأة
SENTENCES_PER_VOICE = 700             # تقريبًا ساعة كلام لكل صوت
MODEL_REPO = 'omran77/omran-voices-piper'
DONORS_REPO = 'omran77/omran-voices-donors'
SENTENCES_URL = 'https://omran-voices.vercel.app/data/sentences.json'
SESSION_HOURS = 11.5                  # Kaggle يوقف الجلسة بعد ١٢ ساعة
UPLOAD_EVERY_MIN = 60
VOICE_FILE = 'ar_AE-omran-medium'
'''

SETUP = '''
import base64, json, os, shutil, subprocess, tarfile, time, urllib.request
from pathlib import Path

T0 = time.time()
W = Path('/kaggle/working')
os.chdir(W)


def run(cmd, log=None):
    """Runs a command and shows its output here (Kaggle hides a child process's own output)."""
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


from kaggle_secrets import UserSecretsClient
HF_TOKEN = UserSecretsClient().get_secret('HF_TOKEN').strip()
from huggingface_hub import HfApi, hf_hub_download
api = HfApi(token=HF_TOKEN)
print('Hugging Face account:', api.whoami()['name'])

gpus = [g for g in subprocess.run(['nvidia-smi', '--query-gpu=name', '--format=csv,noheader'],
                                  capture_output=True, text=True).stdout.splitlines() if g.strip()]
print('GPUs:', gpus)
assert gpus, 'ما في كرت: Settings ← Accelerator ← GPU T4 x2'
if not all('T4' in g for g in gpus):
    print('تنبيه: الأفضل GPU T4 x2 (الكرت P100 قديم على هالمكتبات).')

api.create_repo(MODEL_REPO, private=True, exist_ok=True)
assert api.model_info(MODEL_REPO).private, MODEL_REPO + ' لازم يكون Private'
REPO_FILES = set(api.list_repo_files(MODEL_REPO))
'''

ENVS = '''
# Two separate Python 3.11 environments: the voice engine (makes the data) and Piper (trains),
# each with the exact versions it was written for, away from Kaggle's own packages.
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
# Step 1: the engine reads ~700 sentences in each voice (both GPUs at once). If an earlier run
# already saved the data in the repo, it is reused.
DATA_TAR = 'data/train-data.tar'
if DATA_TAR in REPO_FILES and not Path('data/wav').exists():
    with tarfile.open(hf_hub_download(MODEL_REPO, DATA_TAR, token=HF_TOKEN)) as t:
        t.extractall('.')
    print('reused data from', MODEL_REPO)
else:
    procs = []
    for k, (vid, spk) in enumerate(VOICES):
        env = dict(os.environ, CUDA_VISIBLE_DEVICES=str(k % len(gpus)), HF_TOKEN=HF_TOKEN)
        cmd = [PY_A, 'gen_data.py', '--ref', f'ref_{spk}.wav', '--speaker', spk, '--part', str(k),
               '--count', str(SENTENCES_PER_VOICE), '--sentences', 'sentences.json',
               '--dialect', 'dialect.json', '--out', 'data', '--max-minutes', '150']
        if len(gpus) == 1 and procs:
            procs[-1][1].wait()
        procs.append((spk, subprocess.Popen(cmd, env=env, stdout=open(f'gen_{spk}.log', 'w'), stderr=subprocess.STDOUT)))
    while any(p.poll() is None for _, p in procs):
        time.sleep(120)
        for spk, _ in procs:
            lines = Path(f'gen_{spk}.log').read_text(errors='replace').splitlines()
            print(time.strftime('%H:%M'), lines[-1] if lines else '...')
    for spk, p in procs:
        print(Path(f'gen_{spk}.log').read_text(errors='replace')[-1500:])
        assert p.returncode == 0, spk + ' failed'
    with tarfile.open('train-data.tar', 'w') as t:
        t.add('data')
    api.upload_file(path_or_fileobj='train-data.tar', path_in_repo=DATA_TAR, repo_id=MODEL_REPO, commit_message='training data')
for _, spk in VOICES:
    n = len(Path(f'data/{spk}.tsv').read_text(encoding='utf-8').splitlines())
    secs = sum((Path('data/wav') / ln.split('\\t')[0]).stat().st_size - 44 for ln in Path(f'data/{spk}.tsv').read_text(encoding='utf-8').splitlines()) / 2 / 22050
    print(f'{spk}: {n} clips, {secs / 60:.0f} minutes')
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
