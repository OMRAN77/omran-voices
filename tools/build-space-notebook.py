"""Builds space/omran-voices-tts-setup.ipynb, the Kaggle notebook that puts space/ on Hugging Face.

  python3 tools/build-space-notebook.py [--check]

The owner runs it once (and again after changing space/): it makes the Space omran77/omran-voices-tts
(public: a private Space needs a paid account, 402), uploads space/, gives it the secrets HF_TOKEN
(to read the private models) and SPACE_KEY (a new random key every run), waits until it runs, says
both test sentences there (uploaded to omran77/omran-voices-piper/samples to listen), and only then
tells the voices site the address and key: the file tts-space in its private dataset.
No GPU: Settings -> Accelerator None. tests/piper.test.cjs checks the committed notebook is current.
"""
import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / 'space' / 'omran-voices-tts-setup.ipynb'
FILES = ['README.md', 'Dockerfile', 'requirements.txt', 'app.py']

INTRO = '''
# سيرفر الصوتين الخفيفين على Hugging Face

يسوّي (أو يحدّث) الـSpace `omran77/omran-voices-tts`: عام (الخاص يحتاج حساب مدفوع) بس كل طلب يحتاج مفتاح سري،
والموديلات تبقى في مستودعك الخاص. يرفع ملفاته، ويحط فيه السرّين `HF_TOKEN` و`SPACE_KEY` (مفتاح جديد كل تشغيل)،
وينتظر لين يشتغل، ويقول جملة بكل صوت ويرفعها في `omran77/omran-voices-piper` داخل `samples/` (`space_m.wav`
و`space_f.wav`)، وبعدها يعطي موقع الأصوات العنوان والمفتاح (ملف `tts-space` في مستودعه الخاص). ما تحتاج تضيف شي في Vercel.

**على Kaggle:** Settings ← Accelerator **None** (ما يحتاج كرت) و Internet **On**، و Add-ons ← Secrets ← `HF_TOKEN` (✓)،
ثم Save Version ← **Save & Run All (Commit)**. حوالي ١٥ دقيقة.
'''

SETUP = '''
import json, os, secrets, time
from pathlib import Path

try:
    from kaggle_secrets import UserSecretsClient
    HF_TOKEN = UserSecretsClient().get_secret('HF_TOKEN')
except ImportError:
    from google.colab import userdata
    HF_TOKEN = userdata.get('HF_TOKEN')
HF_TOKEN = (HF_TOKEN or '').strip()
assert HF_TOKEN.startswith('hf_'), 'السر HF_TOKEN ناقص'
from huggingface_hub import HfApi
api = HfApi(token=HF_TOKEN)
print('Hugging Face account:', api.whoami()['name'])
SPACE = 'omran77/omran-voices-tts'
MODEL_REPO = 'omran77/omran-voices-piper'
SITE_DATASET = 'omran77/omran-voices-recordings'  # private; the voices site reads tts-space from it
KEY = secrets.token_urlsafe(32)
Path('space').mkdir(exist_ok=True)
'''

PUBLISH = '''
# the Space (public code, no secret in it), the token it reads the private models with, and its key
api.create_repo(SPACE, repo_type='space', space_sdk='docker', private=False, exist_ok=True)
api.add_space_secret(SPACE, 'HF_TOKEN', HF_TOKEN)
api.add_space_secret(SPACE, 'SPACE_KEY', KEY)
api.upload_folder(folder_path='space', repo_id=SPACE, repo_type='space', commit_message='omran voices tts')
try:  # new secrets are read at start (a Space already building just picks them up)
    api.restart_space(SPACE)
except Exception as e:
    print('restart:', str(e)[:200])
print('uploaded to', SPACE)
'''

WAIT = '''
# building the image and loading the two models takes a few minutes
start, stage = time.time(), ''
while time.time() - start < 25 * 60:
    stage = str(api.get_space_runtime(SPACE).stage)
    print(time.strftime('%H:%M:%S'), stage)
    if stage.endswith('RUNNING'):
        break
    if 'ERROR' in stage:
        raise RuntimeError('the Space failed: open https://huggingface.co/spaces/' + SPACE + ' -> Logs')
    time.sleep(30)
assert stage.endswith('RUNNING'), 'the Space did not start in 25 minutes'
'''

TEST = '''
# one sentence in each voice, through the same door the site uses (the key in X-Space-Key)
import requests
url = 'https://' + SPACE.replace('/', '-') + '.hf.space'
auth = {'X-Space-Key': KEY}
for _ in range(20):  # the models may still be loading right after RUNNING
    h = requests.get(url + '/health', headers=auth, timeout=60)
    if h.ok and h.json().get('voices') == ['f', 'm']:
        break
    time.sleep(15)
print('health:', h.status_code, h.text[:300])
print('without the key:', requests.post(url + '/tts', json={'text': 'x', 'voice': 'm'}, timeout=60).status_code, '(must be 401)')
Path('out').mkdir(exist_ok=True)
for spk in ('m', 'f'):
    t = time.time()
    r = requests.post(url + '/tts', headers=auth, timeout=120,
                      json={'text': 'سنلتقي غدا إن شاء الله في البيت بعد صلاة المغرب.', 'voice': spk})
    print(spk, r.status_code, r.headers.get('content-type'), len(r.content), 'bytes in', round(time.time() - t, 1), 's')
    assert r.ok and r.content[:4] == b'RIFF', r.text[:300]
    Path(f'out/space_{spk}.wav').write_bytes(r.content)
api.upload_folder(folder_path='out', path_in_repo='samples', repo_id=MODEL_REPO, commit_message='space test')
print('listen: https://huggingface.co/' + MODEL_REPO + '/tree/main/samples  (space_m.wav, space_f.wav)')
# it works: now the voices site may use it (no extension: the dataset viewer must not read it as data)
api.upload_file(path_or_fileobj=json.dumps({'url': url, 'key': KEY}).encode(), path_in_repo='tts-space',
                repo_id=SITE_DATASET, repo_type='dataset', commit_message='voices server address')
print('the voices site now sends v5 and v4 (Arabic) to', url)
'''


def md(text):
    return {'cell_type': 'markdown', 'metadata': {}, 'source': text.strip('\n').splitlines(True)}


def code(text):
    return {'cell_type': 'code', 'execution_count': None, 'metadata': {}, 'outputs': [],
            'source': text.strip('\n').splitlines(True)}


def build():
    cells = [md(INTRO), code(SETUP)]
    for name in FILES:
        body = (ROOT / 'space' / name).read_text(encoding='utf-8')
        cells.append(code(f'%%writefile space/{name}\n' + body.rstrip('\n') + '\n'))
    cells += [code(PUBLISH), code(WAIT), code(TEST)]
    nb = {
        'cells': cells,
        'metadata': {
            'kernelspec': {'display_name': 'Python 3', 'language': 'python', 'name': 'python3'},
            'language_info': {'name': 'python'},
            'kaggle': {'accelerator': 'none', 'isInternetEnabled': True, 'isGpuEnabled': False},
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
