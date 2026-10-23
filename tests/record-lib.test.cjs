// صفحة التسجيل — دوال الصفحة الصافية: ترتيب كل شخص، قصّ السكوت، تحويل المعدّل، ترميز WAV، تقييم الصوت.
// نفس الكود اللي في المتصفّح (record-lib.js) يشتغل هنا بدون DOM.
const test = require('node:test');
const assert = require('node:assert');
const lib = require('../record-lib.js');
const server = require('../api/_recordings.js');

const sine = (freq, sec, rate, amp = 0.5) => Float32Array.from({ length: Math.round(sec * rate) }, (_, i) => amp * Math.sin(2 * Math.PI * freq * i / rate));
const rmsOf = (x, a = 0, b = x.length) => { let s = 0; for (let i = a; i < b; i++) s += x[i] * x[i]; return Math.sqrt(s / Math.max(1, b - a)); };

function corpus(g, a, m) {
  const out = [];
  const add = (reg, n) => { for (let i = 0; i < n; i++) out.push([out.length, reg + ' ' + i, reg, 't']); };
  add('gulf', g); add('ar', a); add('msa', m);
  return out;
}

test('الترتيب: كل جملة مرة وحدة، وكل ١٠ جمل = ٦ خليجي و٢ عربي عام و٢ فصحى', () => {
  const s = corpus(600, 200, 200);
  const order = lib.buildOrder(s, 'سالم');
  assert.strictEqual(order.length, s.length);
  assert.strictEqual(new Set(order).size, s.length, 'بدون تكرار ولا نقص');
  for (let b = 0; b < 40; b++) {
    const regs = order.slice(b * 10, b * 10 + 10).map((i) => s[i][2]);
    assert.deepStrictEqual([regs.filter((r) => r === 'gulf').length, regs.filter((r) => r === 'ar').length, regs.filter((r) => r === 'msa').length], [6, 2, 2], 'الكتلة ' + b);
  }
});

test('الترتيب: نفس الاسم نفس الترتيب (حتى لو تغيّرت المسافات وحجم الحروف)، واسم ثاني يبدأ من مكان ثاني', () => {
  const s = corpus(300, 100, 100);
  assert.deepStrictEqual(lib.buildOrder(s, 'Salem Ahmed'), lib.buildOrder(s, '  salem   AHMED '));
  const a = lib.buildOrder(s, 'سالم'), b = lib.buildOrder(s, 'مريم');
  const same = a.slice(0, 50).filter((x, i) => x === b[i]).length;
  assert.ok(same < 10, 'أول ٥٠ جملة تختلف بين اثنين: ' + same);
});

test('الترتيب: إذا خلص نوع كمّل من الباقي، وما يطلع جملة ناقصة', () => {
  const s = corpus(4, 0, 30);
  const order = lib.buildOrder(s, 'سالم');
  assert.strictEqual(new Set(order).size, 34);
  assert.deepStrictEqual(order.map((i) => s[i][2]).filter((r) => r === 'gulf').length, 4);
});

test('قصّ السكوت: يشيل الصمت من الطرفين ويخلّي هامش، وصوت بلا سكوت ما ينقص منه شي', () => {
  const rate = 24000;
  const noise = (sec) => Float32Array.from({ length: Math.round(sec * rate) }, () => (Math.random() - 0.5) * 0.004);
  const x = lib.concat([noise(1), sine(300, 0.5, rate), noise(1)]);
  const t = lib.trimSilence(x, rate);
  assert.ok(Math.abs(t.length / rate - 1.0) < 0.1, 'نص ثانية كلام + هامش ٠٫٢٥ من كل طرف: ' + t.length / rate);
  assert.ok(rmsOf(t, Math.round(0.3 * rate), Math.round(0.7 * rate)) > 0.3, 'الكلام داخل القصّ');
  const clean = sine(300, 1, rate);
  assert.ok(lib.trimSilence(clean, rate).length >= clean.length - 2);
  const silent = new Float32Array(rate);
  assert.strictEqual(lib.trimSilence(silent, rate).length, rate, 'صمت كامل ما ينقصّ (يحكم عليه التقييم)');
  assert.strictEqual(lib.trimSilence(new Float32Array(10), rate).length, 10);
});

test('تحويل المعدّل: التردد والمستوى يثبتون، وما فوق النصف الجديد ينقطع بدل ما ينقلب', () => {
  const zc = (x) => { let n = 0; for (let i = 1; i < x.length; i++) if ((x[i - 1] < 0) !== (x[i] < 0)) n++; return n; };
  for (const [from, to, f] of [[48000, 24000, 440], [44100, 24000, 1000], [16000, 24000, 300], [48000, 24000, 5000]]) {
    const y = lib.resample(sine(f, 1, from, 0.5), from, to);
    assert.ok(Math.abs(y.length - to) <= 1, from + ' -> ' + to + ' طول ' + y.length);
    const mid = y.subarray(Math.round(to * 0.2), Math.round(to * 0.8));
    assert.ok(Math.abs(rmsOf(mid) - 0.5 / Math.SQRT2) < 0.012, 'المستوى ' + rmsOf(mid));
    const freq = zc(mid) / 2 / (mid.length / to);
    assert.ok(Math.abs(freq - f) < f * 0.02 + 3, 'التردد ' + freq + ' من ' + f);
  }
  // ١٥ كيلو هرتز بعد نصف ٢٤ كيلو: لازم يختفي (لو انقلب صار صوت مزعج عند ٩ كيلو)
  const high = lib.resample(sine(15000, 1, 48000, 0.5), 48000, 24000);
  assert.ok(rmsOf(high.subarray(2000, high.length - 2000)) < 0.01, 'ما انقلب: ' + rmsOf(high));
  const same = sine(200, 0.1, 24000);
  assert.strictEqual(lib.resample(same, 24000, 24000), same);
});

test('WAV: الهيدر صحيح، والخادم يقبله، ورجوع الأرقام مثل ما دخلت', () => {
  const pcm = lib.toInt16(sine(220, 1, 24000, 0.5));
  const w = lib.encodeWav(pcm, 24000);
  assert.strictEqual(w.length, 44 + 48000);
  assert.strictEqual(Buffer.from(w.subarray(0, 4)).toString(), 'RIFF');
  const v = new DataView(w.buffer);
  assert.deepStrictEqual([v.getUint16(20, true), v.getUint16(22, true), v.getUint32(24, true), v.getUint16(34, true), v.getUint32(40, true)], [1, 1, 24000, 16, 48000]);
  assert.strictEqual(v.getInt16(44 + 2 * 100, true), pcm[100]);
  assert.deepStrictEqual(server.inspectWav(Buffer.from(w)), { rate: 24000, seconds: 1 }, 'اللي تكتبه الصفحة يقبله الخادم');
  assert.deepStrictEqual(Array.from(lib.toInt16(Float32Array.of(2, -2, 0, 1, -1))), [32767, -32768, 0, 32767, -32768], 'القطع عند الحدّ بدل الالتفاف');
});

test('التسجيل الكامل: عيّنات خام بمعدّل الجهاز -> WAV نظيف ٢٤ كيلو، والتقييم يحكم', () => {
  const rate = 48000;
  const pad = () => new Float32Array(rate);
  const ok = lib.makeWav([pad(), sine(250, 2, rate, 0.4), pad()], rate);
  assert.ok(ok.seconds > 2.3 && ok.seconds < 2.8, 'ثانيتين + هامش: ' + ok.seconds);
  assert.deepStrictEqual(ok.verdict, {});
  assert.deepStrictEqual(server.inspectWav(Buffer.from(ok.wav)).rate, 24000);
  assert.match(lib.makeWav([sine(250, 2, rate, 0.03)], rate).verdict.warn, /خافت/);
  assert.match(lib.makeWav([sine(250, 2, rate, 1.5)], rate).verdict.warn, /مقطّع/);
  assert.match(lib.makeWav([new Float32Array(rate * 2)], rate).verdict.block, /ما سمعت/);
  assert.match(lib.makeWav([sine(250, 0.3, rate, 0.4)], rate).verdict.block, /قصير/);
  // معدّل الجهاز ٤٤٫١ (آيفون وبعض الأندرويد)
  const i = lib.makeWav([sine(250, 2, 44100, 0.4)], 44100);
  assert.ok(Math.abs(i.seconds - 2) < 0.7 && server.inspectWav(Buffer.from(i.wav)).rate === 24000);
});

test('دفعات الرفع: من نفس الشخص، وتحت حدّ العدد والحجم، والباقي ينتظر', () => {
  const mk = (n, speaker, size = 300000) => Array.from({ length: n }, (_, i) => ({ rid: 'r' + i, speaker, size }));
  assert.strictEqual(lib.batchPlan(mk(20, 'أ', 100000)).length, 8, 'تسجيلات قصيرة: يوقف الحدّ على العدد');
  assert.strictEqual(lib.batchPlan(mk(20, 'أ')).length, 7, 'تسجيل ٣٠٠ ألف بايت (٦ ثواني): سبعة تملأ ٢٫٩ م.ب بعد الترميز');
  assert.strictEqual(lib.batchPlan(mk(20, 'أ', 1000000)).length, 2, 'حجم ١ م.ب للواحد: اثنين بس تحت ٢٫٩ م.ب');
  assert.strictEqual(lib.batchPlan(mk(1, 'أ', 2900000)).length, 1, 'تسجيل كبير لحاله يطلع لحاله مو يعلق');
  const mixed = [...mk(3, 'أ'), ...mk(3, 'ب')];
  assert.deepStrictEqual(lib.batchPlan(mixed).map((x) => x.speaker), ['أ', 'أ', 'أ']);
  assert.deepStrictEqual(lib.batchPlan([]), []);
});

test('الأسماء والوقت والمعرّفات: متّفقة مع الخادم', () => {
  assert.strictEqual(lib.cleanName('  ‮سالم‏   أحمد\n'), 'سالم أحمد');
  for (const n of ['سالم أحمد', 'Salem  Ali', 'م.عبدالله!', '../x']) {
    assert.ok(server.speakerDir(n).startsWith(lib.nameKey(n) + '-'), n + ' -> ' + server.speakerDir(n) + ' / ' + lib.nameKey(n));
    assert.strictEqual(lib.nameKey(server.nameOfDir(server.speakerDir(n))), lib.nameKey(n), 'يلاقي نفسه في العدّاد');
  }
  assert.strictEqual(lib.cleanText(' الجو‏   حار\n وايد '), 'الجو حار وايد');
  assert.strictEqual(lib.fmtTime(0), '0 ثانية');
  assert.strictEqual(lib.fmtTime(34.4), '34 ثانية');
  assert.strictEqual(lib.fmtTime(90), '1.5 دقيقة');
  assert.strictEqual(lib.fmtTime(7980), '133.0 دقيقة');
  const ids = new Set(Array.from({ length: 500 }, () => lib.newId()));
  assert.strictEqual(ids.size, 500);
  for (const id of ids) assert.match(id, /^[a-z0-9]{6,32}$/);
});
