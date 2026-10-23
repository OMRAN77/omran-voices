// The 10 000 sentences the friends read: the count, the length, the mix, the dialect, and that
// data/sentences.json is exactly what tools/build-sentences.mjs makes from tools/sentences/*.mjs.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const lib = require('../record-lib.js');
const { hasGulf } = require('../tools/sentences/markers.cjs');

const file = path.join(__dirname, '..', 'data', 'sentences.json');
const rows = JSON.parse(fs.readFileSync(file, 'utf8'));
const TOPICS = { 'السلام': 9, 'الأهل': 12, 'الشغل': 13, 'السوق': 13, 'السيارة': 10, 'الأكل': 13, 'الجو': 8, 'البيت': 7, 'الصحة': 5, 'السفر': 4, 'الجوال': 4, 'المناسبات': 2 };
const norm = (s) => s.replace(/[،؟.!]/g, '').replace(/[أإآٱ]/g, 'ا').replace(/ى/g, 'ي').replace(/ة/g, 'ه').replace(/ؤ/g, 'و').replace(/ئ/g, 'ي').replace(/\s+/g, ' ').trim();
const wordsOf = (s) => s.trim().split(/\s+/).filter(Boolean);
const by = (reg) => rows.filter((r) => r[2] === reg);

test('عدد الجمل وشكلها: ١٠٠٠٠ جملة، معرّف متسلسل، كل صف [id, نص, نوع, موضوع, مصدر]', () => {
  assert.strictEqual(rows.length, 10000);
  rows.forEach((r, i) => {
    assert.strictEqual(r.length, 5);
    assert.strictEqual(r[0], i, 'المعرّف = رقم الصف (يدخل في اسم ملف التسجيل)');
    assert.ok(['gulf', 'ar', 'msa'].includes(r[2]) && r[3] in TOPICS && ['h', 't'].includes(r[4]), 'صف ' + i);
  });
});

test('كل جملة من ٥ إلى ١٥ كلمة، عربي فقط بلا أرقام ولا حروف لاتينية ولا تشكيل، وتنتهي بنقطة أو علامة', () => {
  for (const r of rows) {
    const n = wordsOf(r[1]).length;
    assert.ok(n >= 5 && n <= 15, n + ' كلمة: ' + r[1]);
    assert.match(r[1], /^[ء-يٱ ،؟.!]+$/, r[1]);
    assert.match(r[1], /[.؟!]$/, r[1]);
    assert.ok(!/ {2}/.test(r[1]) && r[1] === r[1].trim(), r[1]);
    assert.ok(r[1].length <= 300, 'الخادم يقصّ فوق ٣٠٠ حرف');
    assert.strictEqual(lib.cleanText(r[1]), r[1], 'الصفحة ما تغيّر النص لما تعرضه');
  }
});

test('ما فيه جملة مكرّرة (حتى لو اختلفت الهمزة أو النقطة)', () => {
  const seen = new Map();
  for (const r of rows) {
    const k = norm(r[1]);
    assert.ok(!seen.has(k), 'مكرّرة: ' + r[1] + ' = ' + seen.get(k));
    seen.set(k, r[1]);
  }
});

test('التوزيع: ٦٠٠٠ خليجي و٢٠٠٠ عربي عام و٢٠٠٠ فصحى، والمواضيع بنسبها في كل نوع', () => {
  assert.deepStrictEqual([by('gulf').length, by('ar').length, by('msa').length], [6000, 2000, 2000]);
  for (const reg of ['gulf', 'ar', 'msa']) {
    const total = by(reg).length;
    for (const [t, w] of Object.entries(TOPICS)) {
      const n = by(reg).filter((r) => r[3] === t).length;
      assert.ok(Math.abs(n - total * w / 100) <= Math.max(3, total * w / 100 * 0.1), reg + ' ' + t + ' ' + n + ' من ' + total * w / 100);
    }
  }
});

test('أول ١٠٠٠ جملة تمثّل الكل: ٦٠٠ و٢٠٠ و٢٠٠، وكل المواضيع موجودة', () => {
  const first = rows.slice(0, 1000);
  assert.deepStrictEqual(['gulf', 'ar', 'msa'].map((g) => first.filter((r) => r[2] === g).length), [600, 200, 200]);
  assert.strictEqual(new Set(first.map((r) => r[3])).size, Object.keys(TOPICS).length);
});

test('الخليجي فيه لهجة فعلًا (٧٠٪ على الأقل فيها كلمة خليجية)، والعام والفصحى بلا ولا كلمة منها', () => {
  const g = by('gulf');
  const share = g.filter((r) => hasGulf(r[1])).length / g.length;
  assert.ok(share >= 0.7, 'نسبة الجمل اللي فيها كلمة خليجية: ' + share);
  for (const r of rows.filter((x) => x[2] !== 'gulf')) assert.ok(!hasGulf(r[1]), r[2] + ': ' + r[1]);
});

test('الكلمات اللي طلبها عمران موجودة بكثرة: وايد، شحالك، بغيت، الحين، هني، يالله، وكلمات المجالس', () => {
  const g = by('gulf').map((r) => r[1]);
  const need = { 'وايد': 450, 'شحالك': 35, 'بغيت': 120, 'الحين': 200, 'هني': 200, 'يالله': 60, 'طال عمرك': 30, 'أبشر': 12, 'خلنا': 50,
    'ما تقصر': 12, 'تسلم وتعيش': 10, 'على عيني ورأسي': 10, 'فديتك': 5, 'مرحبا الساع': 8, 'يا هلا ومسهلا': 10, 'هيه': 12, 'يا مراحب': 15,
    // كلمات لقيناها بالبحث (Eton Institute وThe National وGulf News والاتحاد...) وكلمات خليجية يستخدمها الإماراتي
    'شو الجديد': 8, 'شو اليديد': 8, 'مشكور': 30, 'طرش': 25, 'خلاص': 15, 'وياك': 15, 'وياي': 8, 'ما يخالف': 10, 'تو الناس': 4, 'توني': 100 };
  for (const [w, min] of Object.entries(need)) {
    const n = g.filter((t) => t.includes(w)).length;
    assert.ok(n >= min, w + ' ' + n + ' < ' + min);
  }
});

test('ما فيه تكرار مزعج: الأسماء قليلة وكل اسم مرات قليلة، وبدايات الجمل وعباراتها متنوعة، و«وايد» ما تغطّي الكل', () => {
  const tok = (t) => t.replace(/[،؟.!]/g, ' ').split(/\s+/).filter(Boolean);
  const notName = new Set(['هلا', 'مراحب', 'مرحبا', 'مرحبتين', 'الله', 'رب', 'ليت']);
  const caller = (ts) => { for (let i = 0; i + 1 < ts.length; i++) if (ts[i] === 'يا' && !notName.has(ts[i + 1])) return ts[i + 1]; return null; };
  const maxShare = { gulf: 0.07, ar: 0.03, msa: 0.03 };
  for (const reg of ['gulf', 'ar', 'msa']) {
    const rr = by(reg), names = new Map(), starts = new Map(), grams = new Map();
    let calling = 0, opener = 0;
    for (const r of rr) {
      const ts = tok(r[1]), who = caller(ts);
      if (who) { calling++; names.set(who, (names.get(who) || 0) + 1); }
      const st = ts.slice(0, 3).join(' '); starts.set(st, (starts.get(st) || 0) + 1);
      for (const g of new Set(ts.map((_, i) => ts.slice(i, i + 4).join(' ')).filter((x, i) => i + 4 <= ts.length))) grams.set(g, (grams.get(g) || 0) + 1);
      if (/^(والله|بصراحة|تدري|الصراحة|شوف|أقول|ترى|صدقني|في الحقيقة|كما تعلم|ربما|في الواقع|والحقيقة)/.test(r[1])) opener++;
    }
    assert.ok(calling / rr.length <= maxShare[reg], reg + ' جمل فيها نداء باسم: ' + calling);
    assert.ok(Math.max(0, ...names.values()) <= 12, reg + ' اسم يتكرر: ' + [...names].sort((a, b) => b[1] - a[1])[0]);
    assert.ok(Math.max(...starts.values()) <= 40, reg + ' بداية تتكرر: ' + [...starts].sort((a, b) => b[1] - a[1])[0]);
    assert.ok(Math.max(...grams.values()) <= 50, reg + ' عبارة تتكرر: ' + [...grams].sort((a, b) => b[1] - a[1])[0]);
    assert.ok(opener / rr.length <= 0.14, reg + ' جمل تبدأ بمقدّمة: ' + opener);
  }
  const wayed = by('gulf').filter((r) => tok(r[1]).includes('وايد')).length;
  assert.ok(wayed / 6000 <= 0.13, 'وايد في ' + wayed + ' جملة');
});

test('الترتيب اللي تشوفه الصفحة على الجمل الحقيقية: كل جملة مرة وحدة، وكل ١٠ = ٦ خليجي و٢ و٢', () => {
  const order = lib.buildOrder(rows.map((r) => [r[0], r[1], r[2], r[3]]), 'سالم');
  assert.strictEqual(new Set(order).size, 10000);
  for (let b = 0; b < 1000; b++) {
    const regs = order.slice(b * 10, b * 10 + 10).map((i) => rows[i][2]);
    assert.deepStrictEqual(['gulf', 'ar', 'msa'].map((g) => regs.filter((x) => x === g).length), [6, 2, 2]);
  }
});

test('الملف نفسه ناتج المولّد: نعيد البناء ونقارن (يضمن ما أحد عدّل الملف بيده)', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ov-sent-'));
  const r = spawnSync(process.execPath, [path.join(__dirname, '..', 'tools', 'build-sentences.mjs'), '--out', dir], { encoding: 'utf8' });
  assert.strictEqual(r.status, 0, r.stdout + r.stderr);
  assert.strictEqual(fs.readFileSync(path.join(dir, 'sentences.json'), 'utf8'), fs.readFileSync(file, 'utf8'));
});
