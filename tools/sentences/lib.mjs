// Shared by the sentence files: frames with slots, and the checks every sentence must pass.
// A frame is a sentence with {slots}; a slot item is a word/phrase or an array ["word", "agreeing form", ...]
// ({food} = item[0], {food.1} = item[1]), so a slot can carry its own gender agreement.

import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
export const { hasGulf } = require('./markers.cjs');

export const TOPICS = [
  // [topic, weight in percent]
  ['السلام', 9], ['الأهل', 12], ['الشغل', 13], ['السوق', 13], ['السيارة', 10], ['الأكل', 13],
  ['الجو', 8], ['البيت', 7], ['الصحة', 5], ['السفر', 4], ['الجوال', 4], ['المناسبات', 2],
];
export const TOTALS = { gulf: 6000, ar: 2000, msa: 2000 };

// Emirati first names, many of them, so no single name shows up again and again (the builder also caps each one).
export const MN = ['سالم', 'خالد', 'راشد', 'سعيد', 'حمدان', 'سلطان', 'ماجد', 'سيف', 'مبارك', 'حمد', 'خليفة', 'ناصر', 'فيصل', 'عبدالله', 'محمد', 'يوسف', 'أحمد', 'علي', 'عيسى', 'هزّاع',
  'زايد', 'منصور', 'عبيد', 'جاسم', 'بطي', 'ثاني', 'حميد', 'سهيل', 'عمر', 'إبراهيم', 'عبدالرحمن', 'عبدالعزيز', 'سعود', 'مطر', 'نهيان', 'سرور', 'جمعة', 'خميس', 'محمود', 'طحنون',
  'ذياب', 'غانم', 'سلمان', 'أنس', 'بدر', 'حازم', 'عادل', 'ياسر', 'وليد', 'تميم', 'مروان', 'فهد', 'رشيد', 'صقر', 'نمر', 'هلال', 'سامي', 'كريم', 'نواف', 'ظاعن',
  'عبيد', 'مرزوق', 'سعدون', 'شاهين', 'حارب', 'ثابت', 'عتيق', 'مانع', 'أنور', 'جابر', 'دلموك', 'ماهر', 'ضاحي', 'علوي', 'عويضة', 'يعقوب'].filter((v, i, a) => a.indexOf(v) === i);
export const FN = ['مريم', 'فاطمة', 'موزة', 'شما', 'حصّة', 'مها', 'عايشة', 'ميثاء', 'نورة', 'لطيفة', 'سلامة', 'آمنة',
  'خولة', 'روضة', 'سارة', 'أمل', 'هند', 'ريم', 'شيخة', 'علياء', 'منى', 'ظبية', 'نوف', 'دانة', 'جواهر', 'وفاء', 'سعاد', 'بدور', 'هدى', 'غلا', 'رفيعة', 'مزنة', 'عفراء', 'سلمى', 'زينب', 'أسماء'];
// "يا {…}" slots: the names, plus the plain words people call each other (so the share of names stays small).
export const VOC = [...MN, 'خوي', 'ربعي', 'غالي', 'ريّال', 'ولدي', 'عمّي', 'أخوي', 'طيّب', 'شيخ', 'حبيبي', 'بعد عمري', 'الشيبة'];
export const FVOC = [...FN, 'خيتي', 'غاليتي', 'بنتي', 'حبيبتي', 'غالية', 'يا بعد قلبي'].map((v) => v.replace(/^يا /, ''));

export const F = (tpl, slots = {}) => ({ tpl, slots });

export function mulberry32(a) {
  return function () {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
export function hash32(str) {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) { h ^= str.charCodeAt(i); h = Math.imul(h, 0x01000193) >>> 0; }
  return h >>> 0;
}
export function shuffle(arr, rnd) {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(rnd() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; }
  return a;
}

// Every sentence a frame can make (all combinations when few, a random sample when the product is huge).
export function expand(frame, rnd) {
  const refs = [...frame.tpl.matchAll(/\{([a-z0-9]+)(?:\.(\d))?\}/gi)];
  const names = [...new Set(refs.map((m) => m[1]))];
  for (const n of names) if (!Array.isArray(frame.slots[n]) || !frame.slots[n].length) throw new Error('slot "' + n + '" missing in: ' + frame.tpl);
  const sizes = names.map((n) => frame.slots[n].length);
  const total = sizes.reduce((a, b) => a * b, 1);
  const fill = (pick) => frame.tpl.replace(/\{([a-z0-9]+)(?:\.(\d))?\}/gi, (_, n, k) => {
    const it = pick[n];
    return Array.isArray(it) ? it[k ? +k : 0] : it;
  });
  const out = [];
  if (total <= 20000) {
    const idx = new Array(names.length).fill(0);
    for (let c = 0; c < total; c++) {
      const pick = {};
      names.forEach((n, i) => { pick[n] = frame.slots[n][idx[i]]; });
      out.push(fill(pick));
      for (let i = names.length - 1; i >= 0; i--) { if (++idx[i] < sizes[i]) break; idx[i] = 0; }
    }
  } else {
    for (let c = 0; c < 4000; c++) {
      const pick = {};
      names.forEach((n) => { const a = frame.slots[n]; pick[n] = a[Math.floor(rnd() * a.length)]; });
      out.push(fill(pick));
    }
  }
  return shuffle(out, rnd);
}

// Written the way people type: no vowel marks, no shadda, no tatweel.
export const clean = (s) => {
  const t = s.replace(/[\u064B-\u0652\u0640]/g, '').trim();
  return /[.؟!]$/.test(t) ? t : t + '.'; // every sentence ends with a stop, so the text reads the same everywhere
};
export const words = (s) => s.trim().split(/\s+/).filter(Boolean).length;
// What the engine will be trained on: Arabic letters, spaces and a little punctuation. No digits, no Latin, no diacritics.
export const ARABIC_ONLY = /^[ء-يٱ ،؟.!]+$/;
// Same sentence in a different spelling counts as a duplicate.
export const norm = (s) => s.replace(/[،؟.!]/g, '').replace(/[أإآٱ]/g, 'ا').replace(/ى/g, 'ي').replace(/ة/g, 'ه').replace(/ؤ/g, 'و').replace(/ئ/g, 'ي').replace(/\s+/g, ' ').trim();
export function valid(s) {
  const n = words(s);
  return n >= 5 && n <= 15 && ARABIC_ONLY.test(s) && !/\s{2,}/.test(s) && s === s.trim() && !/\{|\}/.test(s);
}
