// الصوتين الخفيفين (Piper بالفصحى) على Space خاص للمالك: طلب عربي بصوت v5 أو v4 يروح له بدل المحرك
// (ثانية للجملة، بلا حدّ يومي)، بالنص مثل ما انكتب ومفتاح المالك، وموافقة صاحب الصوت تنفحص مثل أيّ صوت.
// غيرهم (صوت ثاني أو لغة ثانية أو OV_PIPER_OFF=1) يبقى على المحرك. السيرفر نايم أو طايح = رسالة واضحة.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const fresh = (rel) => { delete require.cache[require.resolve(path.join(ROOT, rel))]; return require(path.join(ROOT, rel)); };
const SPACE = 'https://omran77-omran-voices-tts.hf.space';
const TOKEN = 'hf_' + 'a'.repeat(30);
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

// space(url, opts) answers the Space; the engine is replaced and counts its calls.
async function withSite(env, space, fn) {
  const all = { VOICES_DIR: storeDir(), VOICES_ACCESS_KEY: 'k', HF_TOKEN: TOKEN, OV_PIPER_URL: undefined, OV_PIPER_OFF: undefined, ...env };
  const old = {};
  for (const [k, v] of Object.entries(all)) { old[k] = process.env[k]; if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  const realFetch = global.fetch;
  const calls = [];
  global.fetch = async (url, opts = {}) => { calls.push({ url: String(url), opts }); return space(String(url), opts); };
  const engine = fresh('api/_engine.js');
  fresh('api/_voices.js');
  fresh('api/_piper.js');
  const engineCalls = [];
  engine.generate = async (args) => { engineCalls.push(args); return { audio: Buffer.from('RIFF-engine') }; };
  try {
    const tts = fresh('api/tts.js');
    const call = async (body) => {
      const res = { headers: {}, code: 0, setHeader(k, v) { this.headers[k] = v; }, status(c) { this.code = c; return this; }, json(b) { this.body = b; return this; }, send(b) { this.body = b; return this; } };
      await tts({ method: 'POST', headers: { 'x-access-key': 'k' }, body }, res);
      return res;
    };
    return await fn(call, calls, engineCalls);
  } finally {
    global.fetch = realFetch;
    for (const [k, v] of Object.entries(old)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
    fresh('api/_engine.js');
  }
}
const okSpace = (url, opts) => {
  if (url !== SPACE + '/tts') throw new Error('unexpected ' + url);
  return new Response(WAV, { status: 200, headers: { 'Content-Type': 'audio/wav' } });
};

test('v5 وv4 بالعربي يروحون للـSpace: صوت m وf، النص مثل ما انكتب، ومفتاح المالك', () =>
  withSite({}, okSpace, async (call, calls, engineCalls) => {
    const r = await call({ text: 'هلا والله، الجو  حار وايد.', lang: 'ar', voice: { donor: 'v5' } });
    assert.strictEqual(r.code, 200);
    assert.strictEqual(r.headers['Content-Type'], 'audio/wav');
    assert.ok(Buffer.from(r.body).equals(WAV));
    const sent = JSON.parse(calls[0].opts.body);
    assert.deepStrictEqual(sent, { text: 'هلا والله، الجو حار وايد.', voice: 'm' }, 'بدون قاموس اللهجة: Piper يشكّل بروحه');
    assert.strictEqual(calls[0].opts.headers.Authorization, 'Bearer ' + TOKEN);
    assert.strictEqual(JSON.parse((await call({ text: 'مرحبا', lang: 'ar', voice: { donor: 'v4' } }), calls[1].opts.body)).voice, 'f');
    assert.strictEqual(engineCalls.length, 0);
  }));

test('صوت ثاني، أو لغة ثانية، أو OV_PIPER_OFF=1: المحرك مثل قبل وما ينلمس الـSpace', async () => {
  await withSite({}, okSpace, async (call, calls, engineCalls) => {
    assert.strictEqual((await call({ text: 'hello', lang: 'en', voice: { donor: 'v5' } })).code, 200);
    assert.strictEqual((await call({ text: 'هلا', lang: 'ar', voice: { donor: 'v1' } })).code, 200);
    assert.strictEqual(engineCalls.length, 2);
    assert.strictEqual(calls.filter((c) => c.url.startsWith(SPACE)).length, 0);
  });
  await withSite({ OV_PIPER_OFF: '1' }, okSpace, async (call, calls, engineCalls) => {
    assert.strictEqual((await call({ text: 'هلا', lang: 'ar', voice: { donor: 'v5' } })).code, 200);
    assert.strictEqual(engineCalls.length, 1);
    assert.strictEqual(calls.filter((c) => c.url.startsWith(SPACE)).length, 0);
  });
});

test('صوت مو في القائمة (بدون موافقة) ما يوصل الـSpace', () =>
  withSite({}, okSpace, async (call, calls) => {
    const dir = process.env.VOICES_DIR;
    fs.writeFileSync(path.join(dir, 'voices.json'), JSON.stringify([{ id: 'v5', name: 'سالم', gender: 'm', file: 'v5.wav', consent: false }]));
    fresh('api/_voices.js').reset();
    const r = await call({ text: 'هلا', lang: 'ar', voice: { donor: 'v5' } });
    assert.strictEqual(r.code, 404);
    assert.strictEqual(calls.filter((c) => c.url.startsWith(SPACE)).length, 0);
  }));

test('الـSpace نايم أو طايح أو رجّع شي مب صوت: رسالة واضحة بكود معروف', async () => {
  const cases = [
    [() => new Response('<html>building</html>', { status: 503 }), 503, 'piper_down'],
    [() => { throw new TypeError('fetch failed'); }, 503, 'piper_down'],
    [() => new Response('nope', { status: 404 }), 502, 'piper_failed'],
    [() => new Response('<html>ok</html>', { status: 200 }), 502, 'piper_failed'],
  ];
  for (const [space, status, code] of cases) {
    await withSite({}, space, async (call, calls, engineCalls) => {
      const r = await call({ text: 'هلا', lang: 'ar', voice: { donor: 'v4' } });
      assert.strictEqual(r.code, status, code);
      assert.strictEqual(r.body.code, code);
      assert.ok(r.body.error.length > 5);
      assert.strictEqual(engineCalls.length, 0, 'ما يرجع للمحرك المستعرب بروحه');
    });
  }
});

test('سيرفر الـSpace (space/) مبني من ملفّاته: Docker على المنفذ 7860 وبدون مفتاح مكتوب', () => {
  const read = (f) => fs.readFileSync(path.join(ROOT, 'space', f), 'utf8');
  assert.match(read('README.md'), /sdk: docker[\s\S]*app_port: 7860/);
  assert.match(read('Dockerfile'), /--port", "7860"/);
  const app = read('app.py');
  for (const name of ['ar_AE-omran_m_fusha-medium.onnx', 'ar_AE-omran_f_fusha-medium.onnx']) assert.ok(app.includes(name), name);
  assert.ok(!/hf_[A-Za-z0-9]{20,}/.test(app + read('Dockerfile')), 'لا مفتاح في الملفات');
});

test('نوتبوك نشر الـSpace مبني من space/ وكوده سليم (python3 tools/build-space-notebook.py)', () => {
  const { python } = require('./_pc-fake.cjs');
  const py = python();
  assert.ok(py, 'يحتاج Python 3');
  const cp = require('child_process');
  const r = cp.spawnSync(py, [path.join(ROOT, 'tools', 'build-space-notebook.py'), '--check'], { encoding: 'utf8' });
  assert.strictEqual(r.status, 0, 'run: python3 tools/build-space-notebook.py');
  const nb = JSON.parse(fs.readFileSync(path.join(ROOT, 'space', 'omran-voices-tts-setup.ipynb'), 'utf8'));
  const app = nb.cells.map((c) => c.source.join('')).find((s) => s.startsWith('%%writefile space/app.py\n'));
  // %%writefile writes the cell as it is: same code, without the file's last newline
  assert.strictEqual(app.split('\n').slice(1).join('\n').trimEnd(), fs.readFileSync(path.join(ROOT, 'space', 'app.py'), 'utf8').trimEnd());
});
