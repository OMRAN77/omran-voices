// الصوتين الخفيفين (Piper بالفصحى) في دالّة Python داخل الموقع نفسه (api/piper.py): طلب عربي بصوت v5 أو v4
// يروح لها بدل المحرك، بالنص مثل ما انكتب ومفتاح محسوب من HF_TOKEN (التوكن نفسه ما يطلع)، وموافقة صاحب
// الصوت تنفحص مثل أيّ صوت. غيرهم يبقى على المحرك. الدالّة ما ردّت أو طاحت = رسالة واضحة.
const test = require('node:test');
const assert = require('node:assert');
const cp = require('child_process');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { python } = require('./_pc-fake.cjs');

const ROOT = path.join(__dirname, '..');
const fresh = (rel) => { delete require.cache[require.resolve(path.join(ROOT, rel))]; return require(path.join(ROOT, rel)); };
const HOST = 'omran-voices.vercel.app';
const FN = 'https://' + HOST + '/api/piper';
const TOKEN = 'hf_' + 'a'.repeat(30);
const KEY = crypto.createHmac('sha256', TOKEN).update('omran-voices-piper').digest('hex');
const WAV = Buffer.concat([Buffer.from('RIFF'), Buffer.alloc(40), Buffer.from('data'), Buffer.alloc(800, 3)]);

function storeDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ov-piper-'));
  const entries = [
    { id: 'v4', name: 'مريم', gender: 'f', file: 'v4.wav', consent: true },
    { id: 'v5', name: 'سالم', gender: 'm', file: 'v5.wav', consent: true },
    { id: 'v1', name: 'علي', gender: 'm', file: 'v1.wav', consent: true },
  ];
  fs.writeFileSync(path.join(dir, 'voices.json'), JSON.stringify(entries));
  for (const e of entries) fs.writeFileSync(path.join(dir, e.file), WAV);
  return dir;
}

// fn(url, opts) answers the site's own function; the engine is replaced and counts its calls.
async function withSite(env, fn, run, host = HOST) {
  const all = { VOICES_DIR: storeDir(), VOICES_ACCESS_KEY: 'k', HF_TOKEN: TOKEN, OV_PIPER_OFF: undefined, VERCEL_AUTOMATION_BYPASS_SECRET: undefined, ...env };
  const old = {};
  for (const [k, v] of Object.entries(all)) { old[k] = process.env[k]; if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  const realFetch = global.fetch;
  const calls = [];
  global.fetch = async (url, opts = {}) => { calls.push({ url: String(url), opts }); return fn(String(url), opts); };
  const engine = fresh('api/_engine.js');
  fresh('api/_voices.js');
  fresh('api/_piper.js');
  const engineCalls = [];
  engine.generate = async (args) => { engineCalls.push(args); return { audio: Buffer.from('RIFF-engine') }; };
  try {
    const tts = fresh('api/tts.js');
    const call = async (body) => {
      const res = { headers: {}, code: 0, setHeader(k, v) { this.headers[k] = v; }, status(c) { this.code = c; return this; }, json(b) { this.body = b; return this; }, send(b) { this.body = b; return this; } };
      await tts({ method: 'POST', headers: { 'x-access-key': 'k', host }, body }, res);
      return res;
    };
    return await run(call, calls, engineCalls);
  } finally {
    global.fetch = realFetch;
    for (const [k, v] of Object.entries(old)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
    fresh('api/_engine.js');
  }
}
// the function wants the site's key
const site = (onTts) => (url, opts) => {
  if (url === FN) return opts.headers['X-Piper-Key'] === KEY ? onTts(url, opts) : new Response('{"error":"key"}', { status: 401 });
  throw new Error('unexpected ' + url);
};
const okFn = site(() => new Response(WAV, { status: 200, headers: { 'Content-Type': 'audio/wav' } }));
const toFn = (calls) => calls.filter((c) => c.url === FN);

test('v5 وv4 بالعربي يروحون لدالّة الموقع نفسه: صوت m وf، النص مثل ما انكتب، والمفتاح المحسوب بدون التوكن', () =>
  withSite({}, okFn, async (call, calls, engineCalls) => {
    const r = await call({ text: 'هلا والله، الجو  حار وايد.', lang: 'ar', voice: { donor: 'v5' } });
    assert.strictEqual(r.code, 200);
    assert.strictEqual(r.headers['Content-Type'], 'audio/wav');
    assert.ok(Buffer.from(r.body).equals(WAV));
    const fn = toFn(calls);
    assert.deepStrictEqual(JSON.parse(fn[0].opts.body), { text: 'هلا والله، الجو حار وايد.', voice: 'm' }, 'بدون قاموس اللهجة: Piper يشكّل بروحه');
    assert.strictEqual(fn[0].opts.headers['X-Piper-Key'], KEY);
    assert.strictEqual(fn[0].opts.headers.Authorization, undefined);
    assert.ok(!JSON.stringify(fn[0].opts).includes(TOKEN), 'التوكن نفسه ما يطلع');
    await call({ text: 'مرحبا', lang: 'ar', voice: { donor: 'v4' } });
    assert.strictEqual(JSON.parse(toFn(calls)[1].opts.body).voice, 'f');
    assert.strictEqual(engineCalls.length, 0);
  }));

test('صوت ثاني، أو لغة ثانية، أو OV_PIPER_OFF=1، أو بدون HF_TOKEN: المحرك مثل قبل', async () => {
  await withSite({}, okFn, async (call, calls, engineCalls) => {
    assert.strictEqual((await call({ text: 'hello', lang: 'en', voice: { donor: 'v5' } })).code, 200);
    assert.strictEqual((await call({ text: 'هلا', lang: 'ar', voice: { donor: 'v1' } })).code, 200);
    assert.strictEqual(engineCalls.length, 2);
    assert.strictEqual(toFn(calls).length, 0);
  });
  for (const env of [{ OV_PIPER_OFF: '1' }, { HF_TOKEN: undefined }]) {
    await withSite(env, okFn, async (call, calls, engineCalls) => {
      assert.strictEqual((await call({ text: 'هلا', lang: 'ar', voice: { donor: 'v5' } })).code, 200);
      assert.strictEqual(engineCalls.length, 1, JSON.stringify(env));
      assert.strictEqual(toFn(calls).length, 0);
    });
  }
});

test('حماية معاينات Vercel: رمز التجاوز ينرسل لو موجود، والعنوان الغلط ينرفض', async () => {
  await withSite({ VERCEL_AUTOMATION_BYPASS_SECRET: 'b'.repeat(32) }, okFn, async (call, calls) => {
    assert.strictEqual((await call({ text: 'هلا', lang: 'ar', voice: { donor: 'v4' } })).code, 200);
    assert.strictEqual(toFn(calls)[0].opts.headers['x-vercel-protection-bypass'], 'b'.repeat(32));
  });
  await withSite({}, okFn, async (call, calls) => {
    assert.strictEqual((await call({ text: 'هلا', lang: 'ar', voice: { donor: 'v4' } })).code, 400);
    assert.strictEqual(calls.length, 0);
  }, 'evil.com/x?');
  assert.strictEqual(fresh('api/_piper.js').address('localhost:3000'), 'http://localhost:3000/api/piper');
});

test('صوت مو في القائمة (بدون موافقة) ما يوصل الدالّة', () =>
  withSite({}, okFn, async (call, calls) => {
    const dir = process.env.VOICES_DIR;
    fs.writeFileSync(path.join(dir, 'voices.json'), JSON.stringify([{ id: 'v5', name: 'سالم', gender: 'm', file: 'v5.wav', consent: false }]));
    fresh('api/_voices.js').reset();
    const r = await call({ text: 'هلا', lang: 'ar', voice: { donor: 'v5' } });
    assert.strictEqual(r.code, 404);
    assert.strictEqual(toFn(calls).length, 0);
  }));

test('الدالّة ما ردّت أو طاحت أو رجّعت شي مب صوت: رسالة واضحة بكود معروف، وما يرجع للمحرك', async () => {
  const cases = [
    [() => new Response('<html>timeout</html>', { status: 504 }), 503, 'piper_down'],
    [() => { throw new TypeError('fetch failed'); }, 503, 'piper_down'],
    [() => new Response('{"error":"model"}', { status: 502 }), 502, 'piper_model'],
    [() => new Response('{"error":"key"}', { status: 401 }), 502, 'piper_key'],
    [() => new Response('nope', { status: 500 }), 502, 'piper_failed'],
    [() => new Response('<html>ok</html>', { status: 200 }), 502, 'piper_failed'],
  ];
  for (const [fn, status, code] of cases) {
    await withSite({}, site(fn), async (call, calls, engineCalls) => {
      const r = await call({ text: 'هلا', lang: 'ar', voice: { donor: 'v4' } });
      assert.strictEqual(r.code, status, code);
      assert.strictEqual(r.body.code, code);
      assert.ok(r.body.error.length > 5);
      assert.strictEqual(engineCalls.length, 0, 'ما يرجع للمحرك المستعرب بروحه');
    });
  }
});

test('api/piper.py: نفس المفتاح، يرفض بدونه، ويرجّع WAV بصوت موجود (بصوت وهمي بدل Piper)', () => {
  const py = python();
  assert.ok(py, 'يحتاج Python 3');
  // the real handler on a local port; voice_for is replaced so the test needs neither Piper nor the models
  const code = `
import importlib.util, json, os, sys, threading, urllib.request, urllib.error
from http.server import ThreadingHTTPServer
spec = importlib.util.spec_from_file_location('piper_fn', sys.argv[1]); m = importlib.util.module_from_spec(spec); spec.loader.exec_module(m)
class Chunk:
    def __init__(self, n): self.audio_int16_bytes = b'xy' * n
class Fake:
    class config: sample_rate = 22050
    def synthesize(self, text): yield Chunk(len(text))
asked = []
m.catt = lambda: None
m.voice_for = lambda spk, token: (asked.append(spk), Fake())[1]
srv = ThreadingHTTPServer(('127.0.0.1', 0), m.handler); threading.Thread(target=srv.serve_forever, daemon=True).start()
def post(body, key, raw=None):
    data = raw if raw is not None else json.dumps(body).encode()
    req = urllib.request.Request('http://127.0.0.1:%d/api/piper' % srv.server_address[1], data=data, method='POST', headers={'X-Piper-Key': key, 'Content-Type': 'application/json'})
    try:
        with urllib.request.urlopen(req) as r: return [r.status, r.headers['Content-Type'], r.read()[:4].decode('latin1')]
    except urllib.error.HTTPError as e: return [e.code, e.headers['Content-Type'], e.read().decode()]
key = m.site_key(m.hf_token())
out = {'key': key, 'noToken': m.site_key(''), 'ok': post({'text': ' مرحبا   بك ', 'voice': 'f'}, key), 'wrong': post({'text': 'x', 'voice': 'm'}, 'x' * 64),
       'voice': post({'text': 'x', 'voice': 'v5'}, key), 'long': post({'text': 'ب' * 1201, 'voice': 'm'}, key), 'json': post(None, key, b'{nope'), 'asked': asked}
print(json.dumps(out))
srv.shutdown()`;
  const r = cp.spawnSync(py, ['-c', code, path.join(ROOT, 'api', 'piper.py')], { encoding: 'utf8', env: { ...process.env, HF_TOKEN: '‏' + TOKEN + '\n' } });
  assert.strictEqual(r.status, 0, r.stderr);
  const out = JSON.parse(r.stdout.trim().split('\n').pop());
  assert.strictEqual(out.key, KEY, 'نفس الحساب في الطرفين (وبعد تنظيف العلامات الخفيّة)');
  assert.strictEqual(out.noToken, '', 'بدون توكن ما في مفتاح: الدالّة ترفض الكل');
  assert.deepStrictEqual(out.ok, [200, 'audio/wav', 'RIFF']);
  assert.strictEqual(out.wrong[0], 401);
  assert.strictEqual(out.voice[0], 404);
  assert.strictEqual(out.long[0], 400);
  assert.strictEqual(out.json[0], 400);
  assert.deepStrictEqual(out.asked, ['f'], 'الموديل ما ينقرا إلا لطلب سليم بالمفتاح');
});

test('api/piper.py: CATT يشكّل الحروف العربيّة وحدها في مكانها، وبين الجمل سكتة، ولو ما انقرا CATT يكمل Piper بروحه', () => {
  const py = python();
  assert.ok(py, 'يحتاج Python 3');
  const code = `
import importlib.util, io, json, os, sys, tempfile, wave, zipfile
spec = importlib.util.spec_from_file_location('piper_fn', sys.argv[1]); m = importlib.util.module_from_spec(spec); spec.loader.exec_module(m)
c = object.__new__(m.Catt)
seen = []
def tags(words):  # fatha on every letter, shadda+damma on the last one: shows where each mark lands
    seen.append(words)
    return ['a'] * (len(words) - 1) + ['<SD>']
c.tags = tags
out = {'vowelled': c('قالَ: 3 كتب، جديدة! نعم'), 'seen': seen}
class Chunk:
    def __init__(self, n): self.audio_int16_bytes = b'xy' * n
class Voice:
    class config: sample_rate = 1000
    def synthesize(self, text):
        out['spoken'] = text
        yield Chunk(100); yield Chunk(50)
m.catt = lambda: (lambda t: '<' + t + '>')
w = wave.open(io.BytesIO(m.speak(Voice(), 'جملة. جملة')))
out['frames'], out['rate'] = w.getnframes(), w.getframerate()
# the real loader: a download that is not the released file is refused, then not tried again for ten minutes
spec.loader.exec_module(m)
d = tempfile.mkdtemp(); bad = os.path.join(d, 'bad.zip')
zipfile.ZipFile(bad, 'w').writestr('encoder.onnx', b'x')
m.CATT_URL = 'file://' + bad
os.environ['CATT_DIR'] = os.path.join(d, 'catt')
out['first'] = m.catt() is None
m.CATT_URL = 'file:///nowhere'
out['again'] = m.catt() is None and m.catt_state['failed_at'] > 0
out['files'] = os.path.exists(os.path.join(d, 'catt', 'encoder.onnx'))
print(json.dumps(out, ensure_ascii=False))`;
  const r = cp.spawnSync(py, ['-c', code, path.join(ROOT, 'api', 'piper.py')], { encoding: 'utf8' });
  assert.strictEqual(r.status, 0, r.stderr);
  const out = JSON.parse(r.stdout.trim().split('\n').pop());
  const F = 'َ', SD = 'ُّ';
  assert.deepStrictEqual(out.seen, ['قال كتب جديدة', ' نعم'.trim()], 'جملة جملة، والحركات القديمة والرموز والأرقام برّا');
  assert.strictEqual(out.vowelled, 'ق' + F + 'ا' + F + 'ل' + F + ': 3 ك' + F + 'ت' + F + 'ب' + F + '، ج' + F + 'د' + F + 'ي' + F + 'د' + F + 'ة' + SD + '! ن' + F + 'ع' + F + 'م' + SD);
  assert.strictEqual(out.spoken, '<جملة. جملة>', 'Piper يستلم النص المشكّل');
  assert.strictEqual(out.rate, 1000);
  assert.strictEqual(out.frames, 100 + 350 + 50, 'سكتة ٠٫٣٥ ث بين الجملتين، مب قبل الأولى');
  assert.ok(out.first && out.again, 'ملف مب نفس المنشور ⇐ بدون CATT، وما يعيد كل طلب');
  assert.strictEqual(out.files, false, 'وما ينفكّ');
});

test('Vercel يبني الدالّة: Piper مثبّت بنسخته، مهلتها، والموديلين بأسمائهم بدون أي سرّ مكتوب', () => {
  const req = fs.readFileSync(path.join(ROOT, 'requirements.txt'), 'utf8');
  assert.match(req, /^piper-tts==1\.8\.0$/m);
  assert.match(req, /^huggingface_hub==/m);
  const conf = JSON.parse(fs.readFileSync(path.join(ROOT, 'vercel.json'), 'utf8'));
  assert.ok(conf.functions['api/piper.py'].maxDuration >= 60);
  const src = fs.readFileSync(path.join(ROOT, 'api', 'piper.py'), 'utf8');
  assert.match(src, /CATT_SHA256 = '[0-9a-f]{64}'/, 'نموذج التشكيل مثبّت ببصمته');
  for (const name of ['ar_AE-omran_m_fusha-medium.onnx', 'ar_AE-omran_f_fusha-medium.onnx', 'omran77/omran-voices-piper']) assert.ok(src.includes(name), name);
  assert.ok(!/hf_[A-Za-z0-9]{20,}/.test(src), 'لا توكن في الملف');
});
