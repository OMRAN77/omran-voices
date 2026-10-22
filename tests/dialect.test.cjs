// قاموس نطق اللهجة: الكلمات الإماراتية تتبدّل للمحرك فقط، والكلمة كاملة بس، والنص اللي كتبه المستخدم ما يتغيّر.
const test = require('node:test');
const assert = require('node:assert');
const path = require('path');
const dialect = require('../api/_dialect');

const SENTENCE = 'السموحة منك ما انتبهت لمسجك، كنت في المول والجو حر وايد، الله يعطيك العافية على هالشغل.';

test('الكلمات اللي طلعت غلط في التجارب تتبدّل كلها', () => {
  const out = dialect.apply(SENTENCE, 'ar');
  for (const w of ['مَا إِنْتَبَهْت', 'لمَسِجَك', 'المُوْلْ', 'حر وايِد', 'هَالشُّغُل', 'يِعْطِيك العافْيَة']) {
    assert.ok(out.includes(w), w + ' ناقصة في: ' + out);
  }
  for (const w of ['ما انتبهت', 'مسجك', ' المول', 'حر وايد', 'هالشغل']) assert.ok(!out.includes(w), w + ' باقية');
});

test('الكلمة كاملة بس: «مسجد» و«المولات» ما تنلمس', () => {
  assert.strictEqual(dialect.apply('رحت المسجد', 'ar'), 'رحت المسجد');
  assert.strictEqual(dialect.apply('المولات زحمة', 'ar'), 'المولات زحمة');
  assert.strictEqual(dialect.apply('مسجدك قريب', 'ar'), 'مسجدك قريب');
});

test('حرف قبل الكلمة (و ف ب ل ك) يبقى والكلمة تتبدّل', () => {
  assert.strictEqual(dialect.apply('والمول', 'ar'), 'والمُوْلْ');
  assert.strictEqual(dialect.apply('بمسجك', 'ar'), 'بمَسِجَك');
  assert.strictEqual(dialect.apply('فأبشر', 'ar'), 'فأَبْشِر');
});

test('العبارة الأطول تغلب، و«وايد» تتبدّل بروحها بدون ما تلمس «حر»', () => {
  for (let i = 1; i < dialect.RULES.length; i++) assert.ok(dialect.RULES[i - 1].from.length >= dialect.RULES[i].from.length);
  assert.strictEqual(dialect.apply('حر وايد', 'ar'), 'حر وايِد');
  assert.strictEqual(dialect.apply('زين وايد', 'ar'), 'زين وايِد');
});

test('ما يتبدّل شي مرّتين، وغير العربي ما ينلمس', () => {
  const once = dialect.apply(SENTENCE, 'ar');
  assert.strictEqual(dialect.apply(once, 'ar'), once);
  assert.strictEqual(dialect.apply(SENTENCE, 'en'), SENTENCE);
  assert.strictEqual(dialect.apply('', 'ar'), '');
});

test('القاموس سليم: كل سطر له نطق مختلف، وما فيه كلمة مكرّرة', () => {
  const seen = new Set();
  for (const r of dialect.RULES) {
    assert.notStrictEqual(r.from, r.to, r.from);
    assert.ok(!seen.has(r.from), 'مكرّرة: ' + r.from);
    seen.add(r.from);
  }
  assert.ok(dialect.RULES.length >= 15); // الملف ما انمسح بالغلط
});

test('/api/tts يرسل للمحرك النص المشكّل، والقطعة الطويلة وايد تروح مثل ما انكتبت', async () => {
  const engine = require('../api/_engine');
  process.env.VOICES_ACCESS_KEY = 'test-key';
  const real = engine.generate;
  const sent = [];
  engine.generate = async (args) => { sent.push(args.text); return { audio: Buffer.from('RIFF') }; };
  try {
    delete require.cache[require.resolve('../api/tts')];
    const tts = require('../api/tts');
    const call = (text) => {
      const res = { headers: {}, code: 0, setHeader(k, v) { this.headers[k] = v; }, status(c) { this.code = c; return this; }, json(b) { this.body = b; return this; }, send(b) { this.body = b; return this; } };
      return tts({ method: 'POST', headers: { 'x-access-key': 'test-key' }, body: { text, lang: 'ar' } }, res).then(() => res);
    };
    const r1 = await call(SENTENCE);
    assert.strictEqual(r1.code, 200);
    assert.strictEqual(sent[0], dialect.apply(SENTENCE, 'ar'));

    // 290 حرف + تشكيل يتعدّى 300: تنرسل مثل ما هي بدل ما يرفضها المحرك
    const long = ('وايد ' .repeat(58)).trim();
    assert.ok(long.length <= 300 && dialect.apply(long, 'ar').length > 300);
    await call(long);
    assert.strictEqual(sent[1], long);
  } finally {
    engine.generate = real;
    delete process.env.VOICES_ACCESS_KEY;
  }
});
