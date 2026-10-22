// مفتاح Hugging Face: العلامات المخفية تنشال، والمفتاح الغلط ما يوصل لترويسة الطلب (كان TypeError = 500).
const test = require('node:test');
const assert = require('node:assert');
const path = require('path');

const enginePath = path.join(__dirname, '..', 'api', '_engine.js');
async function withToken(value, fn) {
  const old = process.env.HF_TOKEN;
  if (value === undefined) delete process.env.HF_TOKEN; else process.env.HF_TOKEN = value;
  delete require.cache[require.resolve(enginePath)];
  try { return await fn(require(enginePath)); } finally {
    if (old === undefined) delete process.env.HF_TOKEN; else process.env.HF_TOKEN = old;
  }
}
const TOKEN = 'hf_' + 'Ab1'.repeat(12);

test('مفتاح سليم ملفوف بعلامات اتجاه مخفية ومسافات ينقبل نظيفًا', () =>
  withToken('‏ ' + TOKEN + '‎\r\n', (e) => assert.strictEqual(e.hfToken(), TOKEN)));

test('كلام عربي أو مفتاح مزوّد ثاني مكان HF_TOKEN ما ينستخدم', async () => {
  await withToken('عبدالله', (e) => assert.strictEqual(e.hfToken(), ''));
  await withToken('sk-or-v1-abc', (e) => assert.strictEqual(e.hfToken(), ''));
  await withToken(undefined, (e) => assert.strictEqual(e.hfToken(), ''));
});

test('مفتاح عربي ما يطيّح الطلب: يروح بدون Authorization بدل TypeError', () =>
  withToken('عبدالله', async (e) => {
    const realFetch = global.fetch;
    const sent = [];
    global.fetch = async (url, opts = {}) => { new Headers(opts.headers); sent.push(opts.headers || {}); return new Response('down', { status: 503 }); };
    try {
      await assert.rejects(e.generate({ text: 'test', lang: 'en', voice: { refPath: '/tmp/gradio/abc/voice.wav' } }), (err) => {
        assert.ok(err instanceof e.EngineError, err.name + ': ' + err.message);
        return true;
      });
      assert.ok(sent.length > 0);
      for (const h of sent) assert.strictEqual(h.Authorization, undefined);
    } finally { global.fetch = realFetch; }
  }));

test('Hugging Face يطلب مفتاح ونحن أرسلنا واحد = رسالة «ما قبل المفتاح» لا «خلص حدّك»', () =>
  withToken(TOKEN, async (e) => {
    const realFetch = global.fetch;
    const sse = 'data: ' + JSON.stringify({ msg: 'process_completed', success: false, output: { error: 'You have exceeded your ZeroGPU runs limit. Authenticate with a Hugging Face token for more quota' } }) + '\n\n';
    global.fetch = async (url) => {
      if (String(url).endsWith('/config')) return Response.json({ dependencies: [{ id: 3, api_name: 'generate_tts_audio', targets: [[9, 'click']] }] });
      if (String(url).includes('/queue/join')) return Response.json({ event_id: 'x' });
      return new Response(sse);
    };
    try {
      await assert.rejects(e.generate({ text: 'test', lang: 'en', voice: { refPath: '/tmp/gradio/abc/voice.wav' } }), (err) => {
        assert.strictEqual(err.code, 'quota');
        assert.match(err.message, /ما قبل مفتاح/);
        return true;
      });
    } finally { global.fetch = realFetch; }
  }));
