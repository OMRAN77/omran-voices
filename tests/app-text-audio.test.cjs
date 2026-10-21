// تقسيم الكلام الطويل وقصّ السكوت: الدالّتان من app.js نفسه (تُقتطعان بنصّهما وتُشغَّلان هنا).
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const src = fs.readFileSync(path.join(__dirname, '..', 'app.js'), 'utf8');
function extract(name) {
  const start = src.indexOf('function ' + name + '(');
  assert.ok(start >= 0, name + ' موجودة في app.js');
  let depth = 0;
  for (let i = src.indexOf('{', start); i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}' && --depth === 0) return src.slice(start, i + 1);
  }
  throw new Error('ما انقفلت ' + name);
}
const CHUNK = Number(src.match(/const CHUNK = (\d+)/)[1]);
const splitText = new Function('CHUNK', extract('splitText') + '; return splitText;')(CHUNK);
const trimSilence = new Function(extract('trimSilence') + '; return trimSilence;')();

test('الكلام الطويل ينقسم قطعًا لا تتعدّى حدّ المحرك ولا يضيع منه حرف', () => {
  const text = 'هلا والله، شحالكم اليوم؟ إن شاء الله تمام. '.repeat(14) + 'وهذي جملة أخيرة بدون نقطة';
  const chunks = splitText(text);
  assert.ok(chunks.length > 1);
  for (const c of chunks) assert.ok(c.length <= CHUNK && c.length <= 300, c.length + ' حرف');
  assert.strictEqual(chunks.join(' ').replace(/\s+/g, ''), text.replace(/\s+/g, ''));
});

test('جملة طويلة بلا نقاط تنقسم على الفواصل ثمّ المسافات', () => {
  const text = ('كلمة '.repeat(40) + '، ').repeat(3);
  const chunks = splitText(text);
  for (const c of chunks) assert.ok(c.length <= CHUNK);
  assert.strictEqual(chunks.join(' ').split(/[\s،]+/).filter(Boolean).length, 120);
});

test('الكلام القصير قطعة وحدة، والفارغ لا شي', () => {
  assert.deepStrictEqual(splitText('هلا والله، شحالك؟'), ['هلا والله، شحالك؟']);
  assert.deepStrictEqual(splitText('   \n  '), []);
});

test('قصّ السكوت من الطرفين يبقي الكلام كاملًا', () => {
  const rate = 24000;
  const f = new Int16Array(rate * 6); // 1 ث سكوت، 2 ث صوت، 3 ث نفَس خفيف
  for (let i = rate; i < rate * 3; i++) f[i] = Math.round(12000 * Math.sin(i / 7));
  for (let i = rate * 3; i < f.length; i++) f[i] = (i % 13) - 6;
  const out = trimSilence(f, rate, 32768);
  const secs = out.length / rate;
  assert.ok(secs >= 2 && secs <= 2.4, secs + ' ثانية');
});

test('تسجيل كلّه سكوت لا يكسر شي', () => {
  const out = trimSilence(new Float32Array(24000), 24000);
  assert.ok(out.length < 24000 * 0.2);
});
