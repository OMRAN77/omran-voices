"""Builds space/omran-voices-tts-setup.ipynb, the Kaggle notebook that puts space/ on Hugging Face.

  python3 tools/build-space-notebook.py [--check]

The owner runs it once (and again after changing space/): it makes the private Space
omran77/omran-voices-tts, uploads space/, gives it the HF_TOKEN secret, waits until it runs, and
says both test sentences there, uploading them to omran77/omran-voices-piper/samples to listen.
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

يسوّي (أو يحدّث) الـSpace الخاص `omran77/omran-voices-tts`: يرفع ملفاته، ويحط فيه السر `HF_TOKEN`، وينتظر لين يشتغل،
ويقول جملة بكل صوت ويرفعها في `omran77/omran-voices-piper` داخل `samples/` (`space_m.wav` و`space_f.wav`) تسمعها.
موقع الأصوات بعدها يرسل له طلبات v5 وv4 بالعربي.

**على Kaggle:** Settings ← Accelerator **None** (ما يحتاج كرت) و Internet **On**، و Add-ons ← Secrets ← `HF_TOKEN` (✓)،
ثم Save Version ← **Save & Run All (Commit)**. حوالي ١٥ دقيقة.
'''

SETUP = '''
import os, time
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
Path('space').mkdir(exist_ok=True)
'''

PUBLISH = '''
# the private Space with these files and the token it reads the models with
api.create_repo(SPACE, repo_type='space', space_sdk='docker', private=True, exist_ok=True)
assert api.space_info(SPACE).private, SPACE + ' لازم يكون Private'
api.add_space_secret(SPACE, 'HF_TOKEN', HF_TOKEN)
api.upload_folder(folder_path='space', repo_id=SPACE, repo_type='space', commit_message='omran voices tts')
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
# one sentence in each voice, through the same door the site uses (the private Space wants the token)
import requests
url = 'https://' + SPACE.replace('/', '-') + '.hf.space'
auth = {'Authorization': 'Bearer ' + HF_TOKEN}
for _ in range(20):  # the models may still be loading right after RUNNING
    h = requests.get(url + '/health', headers=auth, timeout=60)
    if h.ok and h.json().get('voices') == ['f', 'm']:
        break
    time.sleep(15)
print('health:', h.status_code, h.text[:300])
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
