// Builds data/sentences.json (10 000 sentences) from tools/sentences/*.mjs.
//   node tools/build-sentences.mjs [--first1000 <file>] [--out <dir>]    (prints the report; same input -> same output)
// Hand-written sentences come first in every (register, topic) cell; frames fill the rest, round-robin so
// no single frame dominates. Nothing here is random per run: the seed is fixed.
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { TOPICS, TOTALS, MN, FN, expand, mulberry32, hash32, shuffle, norm, valid, clean, hasGulf } from './sentences/lib.mjs';
import gulf1 from './sentences/gulf-1.mjs';
import gulf2 from './sentences/gulf-2.mjs';
import gulf3 from './sentences/gulf-3.mjs';
import gulf4 from './sentences/gulf-4.mjs';
import gulf5 from './sentences/gulf-5.mjs';
import gulf6 from './sentences/gulf-6.mjs';
import gulf7 from './sentences/gulf-7.mjs';
import gulf8 from './sentences/gulf-8.mjs';
import gulf9 from './sentences/gulf-9.mjs';
import gulf10 from './sentences/gulf-10.mjs';
import ar from './sentences/ar.mjs';
import msa from './sentences/msa.mjs';
import dialects from './sentences/dialects.mjs';

const require = createRequire(import.meta.url);
const { PATTERN, DIALECTS } = require('../record-lib.js');
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
// The Gulf files each define some topics; gulf-4 adds more sentences (and frames) to topics already defined.
// A part can be [module, weight]: its frames then get that many turns per round, so the words the owner asked for
// (gulf-5, gulf-6, gulf-8) show up more often than the generic frames.
function merge(...parts) {
  const out = {};
  for (const part of parts) {
    const [p, weight] = Array.isArray(part) ? part : [part, 1];
    for (const [t, d] of Object.entries(p)) {
      out[t] = out[t] || { hand: [], frames: [] };
      out[t].hand.push(...(d.hand || [])); out[t].frames.push(...(d.frames || []).map((f) => ({ ...f, weight })));
    }
  }
  return out;
}
// Every frame that calls someone by name ("... يا {n}") also gets a twin without the name, so the sentence works
// both ways and names stay rare (they are capped below).
function withBare(reg) {
  const out = {};
  for (const [t, d] of Object.entries(reg)) {
    const frames = [];
    for (const f of d.frames || []) {
      frames.push(f);
      const m = /\s+يا\s+\{(n|f)\}/.exec(f.tpl);
      if (m) frames.push({ ...f, tpl: f.tpl.replace(m[0], '') });
    }
    out[t] = { ...d, frames };
  }
  return out;
}
const REG = {
  gulf: withBare(merge(gulf1, gulf2, gulf3, [gulf4, 3], [gulf5, 2], [gulf6, 2], gulf7, [gulf8, 5], [gulf9, 2], [gulf10, 2])),
  ar: withBare(ar), msa: withBare(msa),
};

// ---- limits against repetition (the owner noticed the same names and phrases again and again) ----
const NAME_BUDGET = { gulf: 0.06, ar: 0.04, msa: 0.04 };   // share of a register that may call someone by name
const NAME_CAP = 4;                                         // one name at most this many times in generated sentences
const START_CAP = 30;                                       // sentences beginning with the same three words
const GRAM_CAP = 45;                                        // the same four words in a row, anywhere
const WORD_CAP = { gulf: { 'وايد': 650, 'أبا': 380, 'هني': 330, 'عقب': 330, 'الحين': 330, 'باجر': 300, 'تكفى': 110, 'شو': 260, 'والله': 220 } };
const tok = (t) => t.replace(/[،؟.!]/g, ' ').split(/\s+/).filter(Boolean);
const NOT_A_NAME = new Set(['هلا', 'مراحب', 'مرحبا', 'مرحبتين', 'الله', 'رب', 'ليت']);
const NAMES = new Set([...MN, ...FN].map((x) => clean(x).replace(/[.]$/, '')));
const use = {};
for (const r of ['gulf', 'ar', 'msa']) use[r] = { names: new Map(), nameTotal: 0, start: new Map(), gram: new Map(), words: new Map() };
function caller(ts) {
  for (let i = 0; i + 1 < ts.length; i++) if (ts[i] === 'يا' && !NOT_A_NAME.has(ts[i + 1])) return ts[i + 1];
  for (const w of ts) if (NAMES.has(w)) return w;
  return null;
}
const grams = (ts) => { const g = []; for (let i = 0; i + 4 <= ts.length; i++) g.push(ts.slice(i, i + 4).join(' ')); return [...new Set(g)]; };
function ok(reg, text) {
  const u = use[reg], ts = tok(text), who = caller(ts);
  if (who && (u.nameTotal >= Math.round(TOTALS[reg] * NAME_BUDGET[reg]) || (u.names.get(who) || 0) >= NAME_CAP)) return false;
  const cap = WORD_CAP[reg] || {};
  for (const w of new Set(ts)) if (cap[w] !== undefined && (u.words.get(w) || 0) >= cap[w]) return false;
  if ((u.start.get(ts.slice(0, 3).join(' ')) || 0) >= START_CAP) return false;
  for (const g of grams(ts)) if ((u.gram.get(g) || 0) >= GRAM_CAP) return false;
  return true;
}
function note(reg, text) {
  const u = use[reg], ts = tok(text), who = caller(ts);
  if (who) { u.names.set(who, (u.names.get(who) || 0) + 1); u.nameTotal++; }
  const cap = WORD_CAP[reg] || {};
  for (const w of new Set(ts)) if (cap[w] !== undefined) u.words.set(w, (u.words.get(w) || 0) + 1);
  const st = ts.slice(0, 3).join(' '); u.start.set(st, (u.start.get(st) || 0) + 1);
  for (const g of grams(ts)) u.gram.set(g, (u.gram.get(g) || 0) + 1);
}
// Share of each Gulf topic that must carry at least one Gulf marker word (hand-written ones always go in).
const GULF_SHARE = 0.86;
const REGLABEL = { gulf: 'خليجي', ar: 'عربي', msa: 'فصحى' };

function quotas(total) {
  const q = TOPICS.map(([t, w]) => ({ t, n: Math.floor(total * w / 100), frac: (total * w / 100) % 1 }));
  let left = total - q.reduce((s, x) => s + x.n, 0);
  for (const x of [...q].sort((a, b) => b.frac - a.frac)) { if (left-- > 0) x.n++; }
  return Object.fromEntries(q.map((x) => [x.t, x.n]));
}

const seen = new Set();
const report = [];
const picked = { gulf: [], ar: [], msa: [] };
const dropped = [];

for (const reg of ['gulf', 'ar', 'msa']) {
  const q = quotas(TOTALS[reg]);
  const cells = TOPICS.map(([t]) => {
    const def = REG[reg][t];
    if (!def) throw new Error('missing topic ' + t + ' in ' + reg);
    const rnd = mulberry32(hash32('ov-build|' + reg + '|' + t));
    const hand = [];
    for (const raw of def.hand || []) {
      const s = clean(raw);
      if (!valid(s)) { dropped.push([reg, t, s]); continue; }
      const n = norm(s);
      if (seen.has(n)) { dropped.push([reg, t, 'dup: ' + s]); continue; }
      seen.add(n); hand.push(s);
    }
    const lists = (def.frames || []).map((f) => { const l = expand(f, rnd).map(clean).filter((s) => { if (!valid(s)) { dropped.push([reg, t, s]); return false; } return true; }); l.weight = f.weight || 1; return l; });
    const keep = (l, f) => { const r = l.filter(f); r.weight = l.weight; return r; };
    const m = lists.map((l) => keep(l, hasGulf)), n = lists.map((l) => keep(l, (x) => !hasGulf(x)));
    return { t, quota: q[t], hand, lists, out: [], hi: 0, ptr: lists.map(() => 0), m, n, mp: m.map(() => 0), np: n.map(() => 0) };
  });
  // One sentence from each frame in turn (the turn is remembered in `rr`, so frames share the cell evenly).
  const pull = (c, lists, ptr, limit, rr) => {
    let idle = 0;
    while (c.out.length < limit && idle < lists.length) {
      const i = c[rr] = ((c[rr] || 0) + 1) % lists.length;
      let got = false;
      for (let k = 0; k < (lists[i].weight || 1) && c.out.length < limit; k++) {
        while (ptr[i] < lists[i].length) {
          const s = lists[i][ptr[i]++];
          const n = norm(s);
          if (seen.has(n) || !ok(reg, s)) continue;
          seen.add(n); note(reg, s); c.out.push({ text: s, src: 't' }); got = true;
          break;
        }
      }
      idle = got ? 0 : idle + 1;
    }
  };
  const take = (c, limit) => {
    // hand-written sentences first, then the frames in turn; the cell remembers where it stopped
    while (c.out.length < limit && c.hi < c.hand.length) { const h = c.hand[c.hi++]; note(reg, h); c.out.push({ text: h, src: 'h' }); }
    if (reg === 'gulf') {
      // Gulf cells: sentences that carry a dialect word first (up to GULF_SHARE), the plain ones after
      const want = Math.min(limit, Math.ceil(c.quota * GULF_SHARE));
      const marked = () => c.out.filter((x) => hasGulf(x.text)).length;
      // everything in c.m already carries a marker word, so one call with the number still needed does it
      const need = Math.min(want, c.quota) - marked();
      if (need > 0) pull(c, c.m, c.mp, Math.min(limit, c.out.length + need), 'rm');
      pull(c, c.n, c.np, limit, 'rn');
      pull(c, c.m, c.mp, limit, 'rm');
    } else pull(c, c.lists, c.ptr, limit, 'rl');
  };
  // hand-written ones are registered as seen once, here, so frames never repeat them
  for (const c of cells) take(c, c.quota);
  // a cell that ran dry hands its share to the cells that still have sentences, in proportion
  let short = cells.reduce((s, c) => s + (c.quota - c.out.length), 0);
  const base = short;
  for (let round = 0; short > 0 && round < 50; round++) {
    const open = cells.filter((c) => c.hi < c.hand.length || c.lists.some((l, i) => c.ptr[i] < l.length) || c.m.some((l, i) => c.mp[i] < l.length) || c.n.some((l, i) => c.np[i] < l.length));
    let moved = 0;
    for (const c of open) {
      if (short <= 0) break;
      const before = c.out.length;
      take(c, before + 1);
      if (c.out.length > before) { short--; moved++; }
    }
    if (!moved) break;
  }
  report.push({ reg, base, left: short, cells: cells.map((c) => ({ t: c.t, quota: c.quota, got: c.out.length, hand: c.out.filter((x) => x.src === 'h').length })) });
  for (const c of cells) for (const x of c.out) picked[reg].push({ ...x, reg, topic: c.t });
}

let failed = false;
for (const r of report) {
  console.log('\n== ' + r.reg + ' (' + picked[r.reg].length + '/' + TOTALS[r.reg] + ', ran dry: ' + r.base + ', still missing: ' + r.left + ')');
  for (const c of r.cells) console.log('  ' + c.t.padEnd(10) + String(c.got).padStart(5) + ' /' + String(c.quota).padStart(5) + '   hand ' + c.hand + (c.got < c.quota ? '   <-- SHORT' : ''));
  if (r.left) failed = true;
}
if (dropped.length) console.log('\ndropped (invalid/duplicate): ' + dropped.length + '\n' + dropped.slice(0, 25).map((d) => '  ' + d.join(' | ')).join('\n'));
if (failed) { console.error('\nnot enough sentences: add frames'); process.exit(1); }

// Some composed sentences get a short spoken opener ("والله", "بصراحة،"...), so the lengths and the voice vary
// instead of every sentence of a frame starting the same way. Hand-written ones are left exactly as written.
const OPEN = {
  gulf: { rate: 8, list: ['والله', 'بصراحة،', 'تدري،', 'الصراحة،', 'شوف،', 'أقول،', 'ترى،', 'صدقني،'] },
  ar: { rate: 6, list: ['بصراحة،', 'في الحقيقة،', 'كما تعلم،', 'ربما،'] },
  msa: { rate: 6, list: ['في الواقع،', 'في الحقيقة،', 'والحقيقة،'] },
};
const SKIP_START = /^(أهلا|هلا|مرحب|الله|السلام|وعليكم|صباح|مساء|مبروك|يالله|تكفى|شو|وين|كم|ماذا|هل|كيف|لو|عقب|توني|والله|بصراحة|تدري|شوف|أقول|الصراحة|في )/;
function dress(x) {
  if (x.src !== 't' || !/\.$/.test(x.text) || SKIP_START.test(x.text) || x.text.includes('والله')) return x.text;
  const { rate, list } = OPEN[x.reg];
  const h = hash32('dress|' + x.text) % 100;
  if (h >= rate) return x.text;
  const o = list[hash32('open|' + x.text) % list.length];
  const t = o + ' ' + x.text;
  return valid(t) ? t : x.text;
}

// File order: each register shuffled, then interleaved with the same 6:2:2 pattern the page uses, so the
// first 1000 lines already carry the real mix (600 Gulf / 200 general / 200 Standard).
const lists = {};
for (const reg of Object.keys(picked)) lists[reg] = shuffle(picked[reg], mulberry32(hash32('ov-file|' + reg)));
const at = { gulf: 0, ar: 0, msa: 0 };
const rows = [];
for (let n = 0; n < 10000; n++) {
  const reg = PATTERN[n % PATTERN.length];
  const x = lists[reg][at[reg]++];
  rows.push([n, dress(x), x.reg, x.topic, x.src]);
}
// Each Gulf dialect's hand-written sentences go to data/dialects.json: ids from 10000 on, dialect key as a 6th field.
// data/sentences.json (the 10 000) stays exactly as it was, so recordings already made keep their sentence ids.
const dialectRows = [];
const dialectCount = {};
for (const d of DIALECTS) {
  const def = dialects[d.key];
  if (!def) throw new Error('missing dialect ' + d.key + ' in tools/sentences/dialects.mjs');
  dialectCount[d.key] = 0;
  for (const [t, list] of Object.entries(def)) {
    if (!TOPICS.some(([x]) => x === t)) throw new Error('unknown topic ' + t + ' in dialect ' + d.key);
    for (const raw of list) {
      const s = clean(raw);
      if (!valid(s)) { dropped.push(['dialect:' + d.key, t, s]); continue; }
      const n = norm(s);
      if (seen.has(n)) { dropped.push(['dialect:' + d.key, t, 'dup: ' + s]); continue; }
      seen.add(n);
      dialectRows.push([rows.length + dialectRows.length, s, 'gulf', t, 'h', d.key]);
      dialectCount[d.key]++;
    }
  }
}
for (const k of Object.keys(dialects)) if (!DIALECTS.some((d) => d.key === k)) throw new Error('dialect ' + k + ' is not in DIALECTS (record-lib.js)');
console.log('\n== dialects (after the 10000): ' + Object.entries(dialectCount).map(([k, n]) => k + ' ' + n).join(', '));
if (dropped.some((d) => String(d[0]).startsWith('dialect:'))) { console.error('dialect sentences dropped:\n' + dropped.filter((d) => String(d[0]).startsWith('dialect:')).map((d) => '  ' + d.join(' | ')).join('\n')); process.exit(1); }

const oi = process.argv.indexOf('--out');
const outDir = oi > 0 ? path.resolve(process.argv[oi + 1]) : path.join(root, 'data');
fs.mkdirSync(outDir, { recursive: true });
fs.writeFileSync(path.join(outDir, 'sentences.json'), '[\n' + rows.map((r) => JSON.stringify(r)).join(',\n') + '\n]\n');
fs.writeFileSync(path.join(outDir, 'dialects.json'), '[\n' + dialectRows.map((r) => JSON.stringify(r)).join(',\n') + '\n]\n');
console.log('wrote ' + path.join(outDir, 'dialects.json') + ': ' + dialectRows.length + ' dialect sentences');
const hand = rows.filter((r) => r[4] === 'h').length;
console.log('\nwrote ' + path.join(outDir, 'sentences.json') + ': ' + rows.length + ' sentences (' + hand + ' hand-written, ' + (rows.length - hand) + ' from frames)');

const i = process.argv.indexOf('--first1000');
if (i > 0) {
  const lines = rows.slice(0, 1000).map((r) => (r[0] + 1) + '. [' + REGLABEL[r[2]] + ' · ' + r[3] + '] ' + r[1]);
  fs.writeFileSync(process.argv[i + 1], lines.join('\n') + '\n');
  console.log('wrote ' + process.argv[i + 1]);
}
