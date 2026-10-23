// Words that mark a sentence as Gulf/Emirati speech (and are NOT used in the general or Standard Arabic sets).
// Shared by the builder (to prefer sentences that carry the dialect) and by tests/sentences.test.cjs.
const GULF = new Set(('وايد شحالك شحالج شخبارك شخبارج شلونك شلونج علومك علومج بغيت أبا تبا يبا نبا نبي الحين هني يالله مب باجر شو ' +
  'يبه يمه ربعي حيل عقب توني توك عطني خوي خيتي ريال العيال الجهال الفريج زين شي لين حنا تكفى عساك كذا هالحين هيه خلنا الساع مسهلا مراحب أبشر فديتك تقصر وتعيش الموتر السامان الدريشة الزولية الكبت الليت الخاشوقة الغرافة الصفرية الغرشة الشيلة أرمس بأرمس بأرمسه أرمسك رمسة الرمسة نشيت رقدت كشخة مطوع بنية حرمة الصالونة الدياي السمج الجشيد الخبيصة البلاليط الغيل القطو عيل صوب صوبنا البنكة الكندشن البيزات بيزات الخردة الدكان بلاش القايلة الغبشة الكوس يتغشمر تتغشمر تتفلسف تتمصخر استوى بند بنند يدش حليله حليلها مستانس منقهر ميانين مسموح لبيه فالك طيب سير تعبناك الدلة الفنيال البيالة المسف المدخن التاوة نتفة هالكثر البرحة العتبة البارجيل الدهريز عريش الدوشق المسند العوافي الشيبة الفرخ قح ملقوف سرحان الشاحوف الفشت القرقور المخورة المرتعشة البرقع البوشية الدوسري المكحلة شبرة عزبة الطعوس الصاهود الوسمي الفقع المسيلة الحيا طحت تطيح').split(' '));
const words = (t) => t.replace(/[،؟.!]/g, ' ').split(/\s+/).filter(Boolean);
// A word counts when it is a marker, or a marker with the conjunction و attached, or a "هال…" demonstrative (هالأيام, هالأسبوع).
function hasGulf(text) {
  for (const w of words(text)) {
    if (GULF.has(w)) return true;
    if (w.length > 3 && w[0] === 'و' && GULF.has(w.slice(1))) return true;
    if (w.length > 4 && w.startsWith('هال')) return true;
  }
  return false;
}
module.exports = { GULF, hasGulf, words };
