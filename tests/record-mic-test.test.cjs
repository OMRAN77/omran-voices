// صفحة التسجيل — تجربة المايك قبل أي تسجيل. المالك (٢٢ نوفمبر) بعد ليلتين تدريب على تسجيل مكتوم ما حد سمعه
// قبل: «ابدأ» على تجربة ١٥ ثانية تنسمع ويطلع حكمها. القياس (record-lib.js) يشتغل هنا بدون متصفّح؛ حدوده
// مضبوطة على تسجيل سيف الحقيقي (كل مقاطعه تطلع «مكتوم») وعلى أصوات نظيفة (كلها تعدّي) — محليًّا، لأنّ
// الأصوات ما تنحط في المستودع العام.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const lib = require('../record-lib.js');

// كلام تقريبي: نغمات في نطاق الحروف العلّة (٣٠٠–١٠٠٠)، والحروف (٢–٤ ك)، والصفير (٤–٨ ك)، على مقاطع بينها سكتات،
// وفوقها ضجة غرفة. المستويات بالديسيبل نسبة لنطاق العلّة.
function voice(rate, { sec = 15, amp = 0.25, mid = -14, high = -22, room = -55, talk = 0.75 } = {}) {
  const rnd = lib.mulberry32(7);
  const tones = [[400, 0], [620, 0], [850, 0], [2400, mid], [3300, mid], [5200, high], [6600, high]].filter(([f]) => f < rate / 2 - 200);
  const x = new Float32Array(Math.round(sec * rate));
  const roomAmp = Math.pow(10, room / 20);
  for (let i = 0; i < x.length; i++) {
    const t = i / rate;
    const on = (t % 1) < talk && Math.sin(2 * Math.PI * 4 * t) > -0.3; // syllables, and a pause every second
    let v = 0;
    if (on) for (const [f, db] of tones) v += Math.pow(10, db / 20) * Math.sin(2 * Math.PI * f * t);
    x[i] = Math.max(-1, Math.min(1, amp * v / 3 + roomAmp * (rnd() * 2 - 1)));
  }
  return x;
}
const codes = (x, rate) => lib.micVerdict(lib.micFacts(x, rate)).problems.map((p) => p.code);

test('FFT: نغمة وحدة تطلع في خانتها', () => {
  const n = 1024, re = new Float64Array(n), im = new Float64Array(n);
  for (let i = 0; i < n; i++) re[i] = Math.sin(2 * Math.PI * 37 * i / n);
  lib.fft(re, im);
  const mag = Array.from(re, (r, i) => Math.hypot(r, im[i]));
  assert.ok(Math.abs(mag[37] - n / 2) < 1e-6);
  assert.ok(mag.every((m, i) => i === 37 || i === n - 37 || m < 1e-6));
});

test('صوت واضح من مايك قريب في مكان هادي: ما في مشكلة', () => {
  for (const rate of [48000, 44100]) {
    const f = lib.micFacts(voice(rate), rate);
    assert.deepStrictEqual(lib.micVerdict(f), { ok: true, problems: [] }, JSON.stringify(f));
    assert.ok(f.talkSec > 6 && f.talkSec < 13, 'الكلام من ١٥ ثانية: ' + f.talkSec);
    assert.ok(Math.abs(f.presenceDb - (-14)) < 2.5, 'نطاق الحروف ينقاس صح: ' + f.presenceDb);
    assert.ok(f.snrDb > 30);
  }
});

test('المايك المكتوم (مثل تسجيل سيف الأول: الحروف أوطى ١٦ ديسيبل) ينمسك، ولو نطاق الصفير بروحه ضايع بعد', () => {
  assert.deepStrictEqual(codes(voice(48000, { mid: -28, high: -42 }), 48000), ['muffled']);
  assert.deepStrictEqual(codes(voice(48000, { mid: -15, high: -40 }), 48000), ['muffled'], 'الصفير ضايع = مايك مغطّى');
  assert.deepStrictEqual(codes(voice(48000, { mid: -19, high: -25 }), 48000), [], 'صوت أنعم بس طبيعي: ما ينرفض');
  const text = lib.micVerdict(lib.micFacts(voice(48000, { mid: -28, high: -42 }), 48000)).problems[0].text;
  assert.match(text, /مكتوم/);
});

test('ضجة، صوت واطي، صوت مقطّع، وضع المكالمات، وما في كلام: كل وحدة برسالتها', () => {
  assert.deepStrictEqual(codes(voice(48000, { room: -22 }), 48000), ['noisy']);
  assert.deepStrictEqual(codes(voice(48000, { amp: 0.006, room: -80 }), 48000), ['quiet']);
  assert.deepStrictEqual(codes(voice(48000, { amp: 6 }), 48000), ['loud']);
  assert.deepStrictEqual(codes(voice(16000), 16000), ['narrow'], 'سمّاعة بلوتوث: الجهاز يسجّل ١٦ كيلو');
  assert.deepStrictEqual(codes(voice(48000, { talk: 0.08 }), 48000), ['nospeech']);
  assert.deepStrictEqual(codes(voice(48000, { amp: 0 }), 48000), ['nospeech'], 'ضجة الغرفة بروحها مب كلام');
  assert.deepStrictEqual(codes(new Float32Array(100), 48000), ['nospeech']);
  for (const p of lib.micVerdict(lib.micFacts(voice(48000, { room: -22, mid: -30, high: -45 }), 48000)).problems) assert.ok(p.text.length > 15, 'كل مشكلة معها شو يسوي الشخص');
});

test('الصفحة: كل عنصر يستخدمه الكود موجود، والتسجيل مقفول ورا التجربة', () => {
  const html = fs.readFileSync(path.join(__dirname, '..', 'record.html'), 'utf8');
  const js = fs.readFileSync(path.join(__dirname, '..', 'record.js'), 'utf8');
  const ids = new Set([...js.matchAll(/\$\('([A-Za-z0-9_-]+)'\)/g)].map((m) => m[1]));
  assert.ok(ids.size > 30);
  for (const id of ids) assert.ok(html.includes('id="' + id + '"'), 'ناقص في record.html: ' + id);
  for (const id of ['micTest', 'testGo', 'testPlayer', 'testVerdict', 'testRedo', 'testOk', 'testAnyway', 'testShare', 'micAgain']) assert.ok(ids.has(id), id);
  assert.match(js, /if \(!S\.micPass \|\| S\.state !== 'idle'/, 'start() ما يبدأ قبل التجربة');
  assert.match(js, /const gate = !S\.micPass;/);
  assert.strictEqual(lib.TEST_SEC, 15);
});
