// صفحة التسجيل — الخادم: التسجيلات تنحفظ WAV مع نصها واسم صاحبها في مستودع خاص على Hugging Face،
// والعدّاد يطلع من أسماء المجلدات. الاختبار على خادم Hugging Face تجريبي محلّي (tests/_hf-mock.cjs)
// يمشي بنفس خطوات العميل الرسمي. هذا يثبت منطقنا، ما يثبت إن Hugging Face الحقيقي يقبل نفس الطلبات.
const test = require('node:test');
const assert = require('node:assert');
const path = require('path');
const { start, wav } = require('./_hf-mock.cjs');

const ROOT = path.join(__dirname, '..');
const fresh = (rel) => { delete require.cache[require.resolve(path.join(ROOT, rel))]; return require(path.join(ROOT, rel)); };
const REPO = 'omran77/rec-test';

async function withHub(opts, fn) {
  if (typeof opts === 'function') { fn = opts; opts = {}; }
  const hub = await start(opts);
  const old = {};
  const env = { HF_ENDPOINT: hub.url, HF_WRITE_TOKEN: hub.token, VOICES_RECORD_DATASET: REPO, VOICES_RECORD_KEY: 'رابط-عمران' };
  for (const k of Object.keys(env)) { old[k] = process.env[k]; process.env[k] = env[k]; }
  const rec = fresh('api/_recordings.js');
  try { await fn(hub, rec); }
  finally {
    await hub.close();
    for (const k of Object.keys(env)) { if (old[k] === undefined) delete process.env[k]; else process.env[k] = old[k]; }
  }
}

const item = (rid, over = {}) => ({
  rid, sid: 7, text: 'شحالك وايد زماان', original: 'شحالك وايد زمان', reg: 'gulf', topic: 'سلام', ts: Date.UTC(2026, 9, 23, 8, 0, 0),
  wav: wav(2).toString('base64'), ...over,
});

test('WAV: يقبل أحادي 16 بت، ويرفض غير WAV وستيريو وقصير وطويل وصامت', () => {
  const { inspectWav } = fresh('api/_recordings.js');
  assert.deepStrictEqual(inspectWav(wav(2)), { rate: 24000, seconds: 2 });
  assert.match(inspectWav(Buffer.alloc(500)).error, /WAV/);
  const stereo = wav(2); stereo.writeUInt16LE(2, 22);
  assert.match(inspectWav(stereo).error, /أحادي/);
  const bits8 = wav(2); bits8.writeUInt16LE(8, 34);
  assert.match(inspectWav(bits8).error, /16/);
  assert.match(inspectWav(wav(0.2)).error, /قصير/);
  assert.match(inspectWav(wav(31)).error, /طويل/);
  assert.match(inspectWav(wav(2, 24000, 0)).error, /صامت/);
  const weird = wav(2); weird.writeUInt32LE(96000 * 4, 24);
  assert.match(inspectWav(weird).error, /معدّل/);
});

test('الأسماء: تنظيف، ومجلد واحد لنفس الشخص، وما تطلع مسارات خطرة', () => {
  const { cleanName, speakerDir, nameOfDir } = fresh('api/_recordings.js');
  assert.strictEqual(cleanName('  ‮سالم‏   أحمد\n'), 'سالم أحمد');
  assert.strictEqual(cleanName('x'.repeat(50)).length, 30);
  assert.strictEqual(speakerDir('سالم أحمد'), speakerDir(' سالم  أحمد '));
  assert.strictEqual(speakerDir('Salem'), speakerDir('salem'));
  assert.notStrictEqual(speakerDir('سالم'), speakerDir('سالم2'));
  for (const bad of ['../../etc', 'a/b\\c', '...', '.hidden', '??']) {
    const d = speakerDir(bad);
    assert.ok(!/[\\/]|\.\./.test(d) && !d.startsWith('.'), bad + ' -> ' + d);
  }
  assert.strictEqual(nameOfDir(speakerDir('سالم أحمد')), 'سالم أحمد');
});

test('الحفظ: المستودع يتسوّى خاص، والـWAV بـLFS ومعه metadata.jsonl، والمفتاح ما يروح لرابط التخزين', () =>
  withHub(async (hub, rec) => {
    const r = await rec.save({ speaker: 'سالم أحمد', consent: true, items: [item('aaaaaa01'), item('bbbbbb02', { sid: 12, text: 'الجو حار', original: 'الجو حار', wav: wav(3).toString('base64') })] });
    assert.strictEqual(r.ok, true);
    assert.deepStrictEqual(r.saved, ['aaaaaa01', 'bbbbbb02']);
    assert.strictEqual(r.count, 2);
    assert.strictEqual(r.seconds, 5);
    assert.match(r.batch, /^b[0-9a-f]{10}-n2-d50$/);

    const repo = hub.state.repos.get(REPO);
    assert.strictEqual(repo.private, true);
    assert.ok(repo.files.has('README.md'));
    const dir = 'data/' + rec.speakerDir('سالم أحمد') + '/' + r.batch + '/';
    const w1 = repo.files.get(dir + '00007_aaaaaa01.wav');
    assert.ok(w1 && w1.oid && w1.bytes.equals(wav(2)), 'الملف نفسه بالبايت، مخزّن بـLFS');
    assert.ok(repo.files.has(dir + '00012_bbbbbb02.wav'));
    const lines = repo.files.get(dir + 'metadata.jsonl').bytes.toString('utf8').trim().split('\n').map((l) => JSON.parse(l));
    assert.strictEqual(lines.length, 2);
    assert.deepStrictEqual(
      { ...lines[0], recorded_at: undefined },
      { file_name: '00007_aaaaaa01.wav', text: 'شحالك وايد زماان', original_text: 'شحالك وايد زمان', edited: true, speaker: 'سالم أحمد', speaker_id: rec.speakerDir('سالم أحمد'), sentence_id: 7, register: 'gulf', topic: 'سلام', dialect: '', duration: 2, sampling_rate: 24000, recorded_at: undefined, consent: true },
    );
    assert.strictEqual(lines[0].recorded_at, '2026-10-23T08:00:00.000Z');
    assert.strictEqual(lines[1].edited, false, 'نص ما تعدّل = edited:false');
    // WAV كلها LFS، والنص العادي inline
    const kinds = Object.fromEntries(hub.state.commits[0].lines.slice(1).map((l) => [l.value.path.split('/').pop(), l.key]));
    assert.deepStrictEqual(kinds, { '00007_aaaaaa01.wav': 'lfsFile', '00012_bbbbbb02.wav': 'lfsFile', 'metadata.jsonl': 'file' });
    // رابط التخزين الموقّع ما أخذ مفتاح Hugging Face، وطلبات المستودع أخذته
    for (const c of hub.state.calls) {
      if (c.path.startsWith('/s3/')) assert.strictEqual(c.auth, 'no', 'PUT التخزين بلا Authorization');
      else assert.strictEqual(c.auth, 'yes', c.path);
    }
    assert.strictEqual(hub.state.commits.length, 1, 'دفعة وحدة = commit واحد');
  }));

test('إعادة نفس الدفعة (ضاع الرد) ما تتخزّن مرتين ولا تنعدّ مرتين', () =>
  withHub(async (hub, rec) => {
    const body = { speaker: 'مريم', consent: true, items: [item('cccccc03'), item('dddddd04')] };
    const a = await rec.save(body);
    const b = await rec.save(JSON.parse(JSON.stringify(body)));
    assert.strictEqual(b.duplicate, true);
    assert.deepStrictEqual(b.saved, ['cccccc03', 'dddddd04']);
    assert.strictEqual(b.batch, a.batch);
    assert.strictEqual(hub.state.commits.length, 1);
    assert.strictEqual((await rec.stats()).total.count, 2);
  }));

test('تسجيل بايظ ينرفض بسببه والباقي ينحفظ، وإذا كلها بايظة ما يصير commit', () =>
  withHub(async (hub, rec) => {
    const r = await rec.save({ speaker: 'خالد', items: [
      item('eeeeee05'),
      item('ffffff06', { wav: Buffer.alloc(900).toString('base64') }),
      item('gggggg07', { text: '   ' }),
      item('BAD', {}),
      item('eeeeee05'),
      item('hhhhhh08', { wav: wav(0.1).toString('base64') }),
    ] });
    assert.deepStrictEqual(r.saved, ['eeeeee05']);
    assert.deepStrictEqual(r.rejected.map((x) => x.rid), ['ffffff06', 'gggggg07', 'BAD', 'eeeeee05', 'hhhhhh08']);
    assert.match(r.rejected[0].reason, /WAV|قصير/);
    assert.match(r.rejected[1].reason, /النص/);
    assert.strictEqual(hub.state.commits.length, 1);
    const none = await rec.save({ speaker: 'خالد', items: [item('iiiiii09', { wav: 'AAAA' })] });
    assert.deepStrictEqual(none.saved, []);
    assert.strictEqual(hub.state.commits.length, 1, 'ما فيه شي يستاهل commit');
  }));

test('حدود الطلب: اسم قصير، بلا تسجيلات، دفعة أكبر من 12', () =>
  withHub(async (hub, rec) => {
    await assert.rejects(rec.save({ speaker: 'س', items: [item('jjjjjj10')] }), (e) => e.status === 400 && /اسمك/.test(e.message));
    await assert.rejects(rec.save({ speaker: 'سالم', items: [] }), (e) => e.status === 400);
    await assert.rejects(rec.save({ speaker: 'سالم', items: Array.from({ length: 13 }, (_, i) => item('kkkkkk' + String(i).padStart(2, '0'))) }), (e) => e.status === 413);
    assert.strictEqual(hub.state.commits.length, 0);
  }));

test('العدّاد: يطلع من أسماء المجلدات لكل واحد ومجموع الكل، وصفحات القائمة كلها تنقرا', () =>
  withHub({ pageSize: 1 }, async (hub, rec) => {
    await rec.save({ speaker: 'سالم', items: [item('lllllll1'), item('lllllll2', { wav: wav(3).toString('base64') })] });
    await rec.save({ speaker: 'سالم', items: [item('lllllll3', { wav: wav(1.5).toString('base64') })] });
    await rec.save({ speaker: 'مريم', items: [item('mmmmmmm1', { wav: wav(10).toString('base64') })] });
    await rec.save({ speaker: 'Ali', items: [item('nnnnnnn1')] });
    rec.reset();
    const s = await rec.stats();
    assert.deepStrictEqual(s.speakers.map((x) => [x.name, x.count, x.seconds]), [['مريم', 1, 10], ['سالم', 3, 6.5], ['ali', 1, 2]]);
    assert.deepStrictEqual([s.total.count, s.total.seconds], [5, 18.5]);
    const before = hub.state.calls.length;
    await rec.stats();
    assert.strictEqual(hub.state.calls.length, before, 'نتيجة محفوظة 20 ثانية: بلا طلبات جديدة');
  }));

test('العدّاد على مستودع فاضي: صفر، مو خطأ', () =>
  withHub(async (hub, rec) => {
    const s = await rec.stats();
    assert.deepStrictEqual([s.speakers, s.total.count, s.total.seconds], [[], 0, 0]);
  }));

test('مستودع عام = يرفض الرفع (ما تنحط أصوات الناس في مكان عام)', () =>
  withHub({ publicOnCreate: true }, async (hub, rec) => {
    await assert.rejects(rec.save({ speaker: 'سالم', items: [item('ooooooo1')] }), (e) => e.code === 'public_repo' && /عام/.test(e.message));
    assert.strictEqual(hub.state.commits.length, 0);
    assert.strictEqual(hub.state.objects.size, 0, 'ولا ملف انرفع');
  }));

test('أخطاء Hugging Face: 429 ينتظر، 403 يوضّح الصلاحية، والمفتاح ما يطلع في الرسالة', () =>
  withHub(async (hub, rec) => {
    hub.state.failCommit = 429;
    await assert.rejects(rec.save({ speaker: 'سالم', items: [item('ppppppp1')] }), (e) => e.status === 503 && e.code === 'rate' && e.retryAfter === 17);
    hub.state.failBatch = 403;
    await assert.rejects(rec.save({ speaker: 'سالم', items: [item('ppppppp2')] }), (e) => {
      assert.ok(e.code === 'denied' && /Write/.test(e.message));
      assert.ok(!e.message.includes(hub.token));
      return true;
    });
    hub.state.failCommit = 500;
    await assert.rejects(rec.save({ speaker: 'سالم', items: [item('ppppppp3')] }), (e) => e.code === 'down');
    // وبعدها يرجع يشتغل: الأخطاء ما تخرّب شي
    const ok = await rec.save({ speaker: 'سالم', items: [item('ppppppp4')] });
    assert.deepStrictEqual(ok.saved, ['ppppppp4']);
  }));

test('مفتاح الكتابة: غايب أو شكله غلط = خطأ واضح قبل أي اتصال', async () => {
  const old = process.env.HF_WRITE_TOKEN;
  try {
    delete process.env.HF_WRITE_TOKEN;
    const rec = fresh('api/_recordings.js');
    await assert.rejects(rec.save({ speaker: 'سالم', items: [item('qqqqqqq1')] }), (e) => e.code === 'no_token' && /HF_WRITE_TOKEN/.test(e.message));
    process.env.HF_WRITE_TOKEN = 'not-a-token';
    await assert.rejects(rec.stats(), (e) => e.code === 'no_token' && /شكله غلط/.test(e.message));
    process.env.HF_WRITE_TOKEN = '‏hf_' + 'Ab1'.repeat(12) + '\n';
    assert.strictEqual(fresh('api/_recordings.js').writeToken(), 'hf_' + 'Ab1'.repeat(12), 'علامات الاتجاه وسطر زائد ما تكسر المفتاح');
  } finally { if (old === undefined) delete process.env.HF_WRITE_TOKEN; else process.env.HF_WRITE_TOKEN = old; }
});

/* ---------- الواجهة /api/record ---------- */
function call(handler, { method = 'POST', key, body, query } = {}) {
  const res = { code: 0, body: null, headers: {}, setHeader(k, v) { this.headers[k] = v; }, status(c) { this.code = c; return this; }, json(b) { this.body = b; return this; } };
  const req = { method, headers: key === undefined ? {} : { 'x-record-key': encodeURIComponent(key) }, body, query: query || {} };
  return Promise.resolve(handler(req, res)).then(() => res);
}

test('مفتاح غلط: يكتب في سجل Vercel أطوال المفتاح بس (وصل كم حرف، المتوقع كم)، ولا يطلّع قيمته أبدًا', () =>
  withHub(async () => {
    const handler = fresh('api/record.js');
    const old = console.warn, seen = [];
    console.warn = (...a) => seen.push(a.join(' '));
    try {
      const none = await call(handler, { key: undefined, body: {} });
      const wrong = await call(handler, { key: 'omranvoices2025', body: {} });
      assert.strictEqual(none.code, 401); assert.strictEqual(wrong.code, 401);
      assert.ok(seen.some((l) => /VOICES_RECORD_KEY: key mismatch \(received 0 chars, expected 10 chars\)/.test(l)), seen.join(' | '));
      assert.ok(seen.some((l) => /received 15 chars/.test(l)), seen.join(' | '));
      assert.ok(!seen.some((l) => l.includes('رابط-عمران') || l.includes('omranvoices2025')), 'لا المفتاح الصح ولا المرسل يطلع في السجل');
      assert.ok(!JSON.stringify([none.body, wrong.body]).includes('رابط-عمران'), 'ولا في الردّ');
    } finally { console.warn = old; }
  }));

test('/api/record: المفتاح، الطرق، والـJSON', () =>
  withHub(async (hub) => {
    const handler = fresh('api/record.js');
    assert.strictEqual((await call(handler, { key: undefined, body: {} })).code, 401);
    assert.strictEqual((await call(handler, { key: 'غلط', body: {} })).code, 401);
    assert.strictEqual((await call(handler, { method: 'PUT', key: 'رابط-عمران' })).code, 405);
    const bad = await call(handler, { key: 'رابط-عمران', body: '{not json' });
    assert.strictEqual(bad.code, 400);
    // مفتاح الموقع (كلمة السر) ما يفتح صفحة التسجيل
    const old = process.env.VOICES_ACCESS_KEY; process.env.VOICES_ACCESS_KEY = 'site-pass';
    try { assert.strictEqual((await call(handler, { key: 'site-pass', body: {} })).code, 401); } finally { if (old === undefined) delete process.env.VOICES_ACCESS_KEY; else process.env.VOICES_ACCESS_KEY = old; }

    const saved = await call(handler, { key: 'رابط-عمران', body: JSON.stringify({ speaker: 'سالم', consent: true, items: [item('rrrrrrr1')] }) });
    assert.strictEqual(saved.code, 200);
    assert.deepStrictEqual(saved.body.saved, ['rrrrrrr1']);
    assert.strictEqual(saved.headers['Cache-Control'], 'private, no-store');
    const st = await call(handler, { method: 'GET', key: 'رابط-عمران' });
    assert.strictEqual(st.body.total.count, 1);
    const ck = await call(handler, { method: 'GET', key: 'رابط-عمران', query: { check: '1' } });
    assert.deepStrictEqual([ck.body.ok, ck.body.token, ck.body.private, ck.body.user], [true, 'ok', true, 'omran77']);
    hub.state.failCommit = 429;
    const rl = await call(handler, { key: 'رابط-عمران', body: { speaker: 'سالم', items: [item('rrrrrrr2')] } });
    assert.deepStrictEqual([rl.code, rl.body.code, rl.headers['Retry-After']], [503, 'rate', '17']);
  }));

test('/api/record: بلا VOICES_RECORD_KEY يقفل كل شي (500)', async () => {
  const old = process.env.VOICES_RECORD_KEY; delete process.env.VOICES_RECORD_KEY;
  try {
    const res = await call(fresh('api/record.js'), { key: 'أي شي', body: {} });
    assert.strictEqual(res.code, 500);
    assert.match(res.body.error, /VOICES_RECORD_KEY/);
  } finally { if (old !== undefined) process.env.VOICES_RECORD_KEY = old; }
});
