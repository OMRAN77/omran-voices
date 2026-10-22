// قاموس نطق اللهجة الإماراتية.
// المحرك تعلّم العربي الفصيح، فبعض كلماتنا يقراها غلط («وايد» تطلع «ويد»، «مسجك» تطلع «مسجد»).
// قبل ما ينرسل النص العربي للمحرك تتبدّل هذي الكلمات بكتابة مشكّلة تخلّيه ينطقها صح.
// المستخدم ما يشوف أي تغيير: النص في الصفحة والسجل يبقى مثل ما كتبه.
//
// تزيد كلمة؟ سطر جديد: المكتوب = اللي يسمعه المحرك
// - تنطبق على الكلمة كاملة بس (ما تلمس كلمة أطول فيها نفس الحروف)، ولو قبلها و/ف/ب/ل/ك تنطبق بعد.
// - العبارة الأطول تنطبق قبل الأقصر، فـ«يعطيك العافية» تغلب أي كلمة فيها.
// - السطر اللي يبدأ بـ# ملاحظة ما تنقرا.
const WORDS = `
# اللي طلع غلط في التجارب (٢١–٢٢ أكتوبر). لا تحط شدّة على آخر الكلمة: «حَرّ وايد» انسحبت راؤها للكلمة اللي بعدها وطلعت «حال روائد».
المول = المُوْلْ
ما انتبهت = مَا إِنْتَبَهْت
مسجك = مَسِجَك
مسج = مَسِج
هالشغل = هَالشُّغُل
وايد = وايِد

# من كلمات مها في التطبيق الرئيسي
هلا والله = هَلا وَالله
أبشر = أَبْشِر
تسلم = تِسْلَم
يعطيك العافية = يِعْطِيك العافْيَة
كفو = كَفُو
شوي = شْوَيّ
وينك = وَيْنَك
حطيته = حَطَّيْتَه
سويته = سَوَّيْتَه
أشوف = أَشُوف
بنحلها = بِنْحِلّها
اطمن = اطَّمَّن
اطمّن = اطَّمَّن
`;

const LETTER = '[\\p{L}\\p{M}]';

function parse(text) {
  const pairs = [];
  for (const raw of text.split('\n')) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const i = line.indexOf('=');
    if (i < 0) continue;
    const from = line.slice(0, i).trim();
    const to = line.slice(i + 1).trim();
    if (from && to) pairs.push([from, to]);
  }
  // longest first, so a phrase wins over a word inside it
  return pairs.sort((a, b) => b[0].length - a[0].length);
}

const escape = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const RULES = parse(WORDS).map(([from, to]) => ({
  from, to,
  // whole word, with an optional one-letter prefix (و ف ب ل ك) kept as written
  re: new RegExp(`(?<!${LETTER})([وفبلك]?)${escape(from).replace(/ /g, '\\s+')}(?!${LETTER})`, 'gu'),
}));

// Returns the text the engine should read. Only Arabic is touched.
function apply(text, lang) {
  if (lang !== 'ar' || !text) return text;
  let out = String(text);
  for (const r of RULES) out = out.replace(r.re, (m, prefix) => prefix + r.to);
  return out;
}

module.exports = { apply, RULES, WORDS };
