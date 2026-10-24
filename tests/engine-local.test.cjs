// المحرك في جهاز المالك: يُستخدم أوّلًا لما يرد، ولما يطفي الجهاز يرجع الموقع للمحرك العام بروحه.
const test = require('node:test');
const assert = require('node:assert');
const crypto = require('crypto');
const path = require('path');

const enginePath = path.join(__dirname, '..', 'api', '_engine.js');
const PC = 'https://omran-pc.tail1234.ts.net';
const KEY = 'Zq8' + 'x'.repeat(29);
const SPACE = 'https://resembleai-chatterbox-multilingual-tts.hf.space';
const WAV = Buffer.alloc(4000, 7);
const SHA = crypto.createHash('sha256').update(WAV).digest('hex');

// pc(url, opts) answers the PC's requests; the public demo answers 503 on /config.
async function withEngine(env, pc, fn) {
  const saved = { url: process.env.OV_ENGINE_URL, key: process.env.OV_ENGINE_KEY };
  for (const [k, v] of Object.entries({ OV_ENGINE_URL: env.url, OV_ENGINE_KEY: env.key })) {
    if (v === undefined) delete process.env[k]; else process.env[k] = v;
  }
  delete require.cache[require.resolve(enginePath)];
  const realFetch = global.fetch;
  const calls = [];
  global.fetch = async (url, opts = {}) => {
    calls.push({ url: String(url), opts });
    if (String(url).startsWith(SPACE)) return new Response('down', { status: 503 });
    return pc(String(url), opts);
  };
  try { return await fn(require(enginePath), calls); } finally {
    global.fetch = realFetch;
    for (const [k, v] of Object.entries({ OV_ENGINE_URL: saved.url, OV_ENGINE_KEY: saved.key })) {
      if (v === undefined) delete process.env[k]; else process.env[k] = v;
    }
  }
}
const ON = { url: PC + '/', key: KEY };
const json = (status, obj) => new Response(JSON.stringify(obj), { status, headers: { 'Content-Type': 'application/json' } });
const healthy = (onTts) => async (url, opts) => {
  if (url === PC + '/health') return opts.headers['X-Engine-Key'] === KEY ? json(200, { ok: true }) : json(401, {});
  if (url === PC + '/tts') return onTts(JSON.parse(opts.body), opts);
  throw new Error('unexpected ' + url);
};
// The public demo's first step for a WAV is the upload, which the mock refuses.
const spaceErr = (err) => /أرفع الصوت للمحرك/.test(err.message);
const toPc = (calls) => calls.filter((c) => c.url.startsWith(PC));
const toSpace = (calls) => calls.filter((c) => c.url.startsWith(SPACE));

test('بدون OV_ENGINE_URL: الحالة off وما ينرسل شي للجهاز', () =>
  withEngine({}, () => { throw new Error('no'); }, async (e, calls) => {
    assert.strictEqual(await e.localStatus(), 'off');
    await assert.rejects(e.generate({ text: 'هلا', lang: 'ar', voice: { wav: WAV } }), spaceErr);
    assert.strictEqual(toPc(calls).length, 0);
    assert.ok(toSpace(calls).length > 0);
  }));

test('رابط مو https أو مفتاح قصير: الحالة bad وما ينستخدم', async () => {
  for (const env of [{ url: 'http://example.com', key: KEY }, { url: PC, key: 'short' }, { url: PC + '/x', key: KEY }]) {
    await withEngine(env, () => { throw new Error('no'); }, async (e, calls) => {
      assert.strictEqual(await e.localStatus(), 'bad', JSON.stringify(env));
      assert.strictEqual(toPc(calls).length, 0);
    });
  }
});

test('الجهاز شغّال: الصوت يروح له مع المفتاح، والقطعة الثانية بالبصمة بس', () =>
  withEngine(ON, healthy((b) => new Response(Buffer.from('RIFFwav'), { status: 200, headers: { 'Content-Type': 'audio/wav' } })), async (e, calls) => {
    assert.strictEqual(await e.localStatus(), 'up');
    const first = await e.generate({ text: ' هلا والله ', lang: 'ar', voice: { wav: WAV }, seed: 3 });
    assert.strictEqual(first.audio.toString(), 'RIFFwav');
    assert.strictEqual(first.refPath, 'local:' + SHA);
    const second = await e.generate({ text: 'شحالك', lang: 'ar', voice: { refPath: first.refPath } });
    assert.strictEqual(second.refPath, undefined);

    const tts = toPc(calls).filter((c) => c.url.endsWith('/tts')).map((c) => ({ h: c.opts.headers, b: JSON.parse(c.opts.body) }));
    assert.strictEqual(tts.length, 2);
    assert.strictEqual(tts[0].h['X-Engine-Key'], KEY);
    assert.deepStrictEqual([tts[0].b.text, tts[0].b.refId, tts[0].b.refWav, tts[0].b.seed], ['هلا والله', SHA, WAV.toString('base64'), 3]);
    assert.deepStrictEqual([tts[1].b.refId, tts[1].b.refWav], [SHA, undefined]);
    assert.strictEqual(toSpace(calls).length, 0);
    // the state is remembered: one health check for both pieces
    assert.strictEqual(toPc(calls).filter((c) => c.url.endsWith('/health')).length, 1);
  }));

test('الجهاز مطفي: يرجع للمحرك العام، وصوت الجهاز يطلب الملف من جديد (ref_gone)', () =>
  withEngine(ON, async () => { throw new TypeError('fetch failed'); }, async (e, calls) => {
    assert.strictEqual(await e.localStatus(), 'down');
    await assert.rejects(e.generate({ text: 'هلا', lang: 'ar', voice: { wav: WAV } }), spaceErr);
    assert.ok(toSpace(calls).length > 0);
    const before = calls.length;
    await assert.rejects(e.generate({ text: 'هلا', lang: 'ar', voice: { refPath: 'local:' + SHA } }), (err) => err.code === 'ref_gone' && err.status === 410);
    assert.strictEqual(calls.length, before, 'no request at all: the caller resends the WAV');
  }));

test('الجهاز شغّال ومسار من المحرك العام: ref_gone عشان ينرسل الملف للجهاز', () =>
  withEngine(ON, healthy(() => { throw new Error('no'); }), async (e, calls) => {
    await assert.rejects(e.generate({ text: 'هلا', lang: 'ar', voice: { refPath: '/tmp/gradio/abc/voice.wav' } }), (err) => err.code === 'ref_gone');
    assert.strictEqual(toPc(calls).filter((c) => c.url.endsWith('/tts')).length, 0);
    assert.strictEqual(toSpace(calls).length, 0);
  }));

test('410 من الجهاز = ref_gone، و500 من المحرك = خطأ واضح بدون رجوع للعام', async () => {
  await withEngine(ON, healthy(() => json(410, { code: 'ref_gone' })), async (e) => {
    await assert.rejects(e.generate({ text: 'هلا', lang: 'ar', voice: { refPath: 'local:' + SHA } }), (err) => err.code === 'ref_gone');
  });
  await withEngine(ON, healthy(() => json(500, { code: 'engine', error: 'OutOfMemoryError: CUDA out of memory' })), async (e, calls) => {
    await assert.rejects(e.generate({ text: 'هلا', lang: 'ar', voice: { wav: WAV } }), (err) => err.status === 502 && /CUDA out of memory/.test(err.message));
    assert.strictEqual(toSpace(calls).length, 0);
  });
});

test('النفق شغّال والمحرك مسكّر (502): نفس الطلب يكمل على المحرك العام، والجهاز ما ينسأل ثاني لين ٣٠ ثانية', () =>
  withEngine(ON, healthy(() => new Response('<html>bad gateway</html>', { status: 502 })), async (e, calls) => {
    await assert.rejects(e.generate({ text: 'هلا', lang: 'ar', voice: { wav: WAV } }), spaceErr);
    assert.ok(toSpace(calls).length > 0);
    assert.strictEqual(await e.localStatus(), 'down');
    const pcCalls = toPc(calls).length;
    await assert.rejects(e.generate({ text: 'هلا', lang: 'ar', voice: { wav: WAV } }));
    assert.strictEqual(toPc(calls).length, pcCalls);
  }));

test('مفتاح غلط: الحالة badkey، والمفتاح ما يطلع في أي رسالة خطأ', () =>
  withEngine({ url: PC, key: 'W'.repeat(32) }, healthy(() => json(401, {})), async (e, calls) => {
    assert.strictEqual(await e.localStatus(), 'badkey');
    const err = await e.generate({ text: 'هلا', lang: 'ar', voice: { wav: WAV } }).catch((x) => x);
    assert.ok(!String(err.message).includes('W'.repeat(32)));
    assert.strictEqual(toPc(calls).filter((c) => c.url.endsWith('/tts')).length, 0);
  }));

test('/api/check يرجّع حالة الجهاز', () =>
  withEngine(ON, healthy(() => { throw new Error('no'); }), async () => {
    const checkPath = path.join(__dirname, '..', 'api', 'check.js');
    const authPath = path.join(__dirname, '..', 'api', '_auth.js');
    delete require.cache[require.resolve(checkPath)];
    const old = process.env.VOICES_ACCESS_KEY;
    process.env.VOICES_ACCESS_KEY = 'pass1234';
    try {
      delete require.cache[require.resolve(authPath)];
      const check = require(checkPath);
      let out;
      const res = { status(c) { this.code = c; return this; }, json(o) { out = o; return this; }, setHeader() {} };
      await check({ method: 'GET', headers: { 'x-access-key': 'pass1234' }, query: {} }, res);
      assert.strictEqual(res.code, 200, JSON.stringify(out));
      assert.strictEqual(out.engine, 'up');
    } finally {
      if (old === undefined) delete process.env.VOICES_ACCESS_KEY; else process.env.VOICES_ACCESS_KEY = old;
    }
  }));
