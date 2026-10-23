'use strict';
// The recording page's pure helpers: no DOM, no network, so tests/record-lib.test.cjs runs
// the very same code in Node. The browser gets it as window.OVRec; Node as module.exports.
(function (root) {
  const TARGET_RATE = 24000;      // saved WAVs: mono, 16-bit, 24 kHz (the engine's rate; 16 kHz is a plain downsample)
  const MAX_TEXT = 300;
  const REGS = ['gulf', 'ar', 'msa'];
  // Every block of 10 sentences: 6 Emirati/Gulf, 2 general Arabic, 2 Modern Standard. A person who
  // stops after 40 sentences still gave the same mix as one who did all 10 000.
  const PATTERN = ['gulf', 'gulf', 'ar', 'gulf', 'msa', 'gulf', 'gulf', 'ar', 'gulf', 'msa'];

  /* ---------- names and text ---------- */
  const INVISIBLE = /[\u0000-\u001f\u007f​-‏‪-‮⁦-⁩﻿]/g;
  function cleanName(raw) {
    return String(raw == null ? '' : raw).normalize('NFC').replace(INVISIBLE, '').replace(/\s+/g, ' ').trim().slice(0, 30).trim();
  }
  // Same letters the server keeps for the speaker's folder, so the page can find its own row in the counter.
  function nameKey(name) {
    return cleanName(name).toLocaleLowerCase().replace(/\s+/g, '_').replace(/[^\p{L}\p{M}\p{N}_-]/gu, '').replace(/^[-_.]+/, '').slice(0, 30);
  }
  function cleanText(raw) {
    return String(raw == null ? '' : raw).normalize('NFC').replace(INVISIBLE, ' ').replace(/\s+/g, ' ').trim().slice(0, MAX_TEXT);
  }

  /* ---------- the order each person sees ---------- */
  function hash32(str) {
    let h = 0x811c9dc5;
    const s = String(str);
    for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193) >>> 0; }
    return h >>> 0;
  }
  function mulberry32(a) {
    return function () {
      a = (a + 0x6d2b79f5) >>> 0;
      let t = a;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }
  function shuffled(arr, rnd) {
    const a = arr.slice();
    for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(rnd() * (i + 1)); const t = a[i]; a[i] = a[j]; a[j] = t; }
    return a;
  }
  // sentences: [[id, text, reg, topic], ...]. Returns indexes into it. The order depends only on the
  // name, so the same person gets the same sequence on every device (and a friend starts elsewhere).
  function buildOrder(sentences, name) {
    const rnd = mulberry32(hash32('ov-order|' + nameKey(name)));
    const lists = { gulf: [], ar: [], msa: [] };
    sentences.forEach((s, i) => { (lists[s[2]] || lists.gulf).push(i); });
    for (const r of REGS) lists[r] = shuffled(lists[r], rnd);
    const at = { gulf: 0, ar: 0, msa: 0 };
    const out = [];
    for (let n = 0; n < sentences.length; n++) {
      let r = PATTERN[n % PATTERN.length];
      if (at[r] >= lists[r].length) r = REGS.find((x) => at[x] < lists[x].length);
      out.push(lists[r][at[r]++]);
    }
    return out;
  }

  /* ---------- audio ---------- */
  function concat(chunks) {
    let n = 0;
    for (const c of chunks) n += c.length;
    const out = new Float32Array(n);
    let o = 0;
    for (const c of chunks) { out.set(c, o); o += c.length; }
    return out;
  }
  // Cuts the silence the tap on the button and the room leave at both ends, keeping a short margin.
  // The threshold follows the room's own noise (10th percentile of 20 ms frames), never below -50 dBFS.
  function trimSilence(x, rate, padSec = 0.25) {
    const win = Math.max(1, Math.round(rate * 0.02));
    const frames = Math.floor(x.length / win);
    if (frames < 3) return x;
    const rms = new Float32Array(frames);
    let peak = 0;
    for (let f = 0; f < frames; f++) {
      let s = 0;
      for (let i = f * win; i < (f + 1) * win; i++) s += x[i] * x[i];
      rms[f] = Math.sqrt(s / win);
      if (rms[f] > peak) peak = rms[f];
    }
    const sorted = Array.from(rms).sort((a, b) => a - b);
    const floor = sorted[Math.floor(frames * 0.1)];
    const thr = Math.max(0.003, Math.min(floor * 3, peak * 0.1));
    let a = -1, b = -1;
    for (let f = 0; f < frames; f++) if (rms[f] > thr) { if (a < 0) a = f; b = f; }
    if (a < 0) return x;
    const pad = Math.round(rate * padSec);
    return x.slice(Math.max(0, a * win - pad), Math.min(x.length, (b + 1) * win + pad));
  }
  // Windowed-sinc resampling (Hann window, 10 zero-crossings each side, cutoff at 97% of the lower
  // Nyquist) from a lookup table: clean enough that nothing above the new Nyquist folds back.
  function resample(x, from, to) {
    if (from === to) return x;
    const ratio = from / to;
    const fc = Math.min(1, to / from) * 0.97;
    const half = Math.ceil(10 / fc);
    const RES = 256;
    const table = new Float32Array(2 * half * RES + 2);
    for (let k = 0; k < table.length; k++) {
      const d = k / RES - half;
      const z = fc * d;
      const sinc = Math.abs(z) < 1e-9 ? 1 : Math.sin(Math.PI * z) / (Math.PI * z);
      table[k] = fc * sinc * (0.5 * (1 + Math.cos(Math.PI * d / half)));
    }
    const n = Math.floor(x.length / ratio);
    const out = new Float32Array(n);
    for (let j = 0; j < n; j++) {
      const c = j * ratio;
      const i0 = Math.max(0, Math.ceil(c - half)), i1 = Math.min(x.length - 1, Math.floor(c + half));
      let sum = 0, wsum = 0;
      for (let i = i0; i <= i1; i++) {
        const w = table[Math.round((i - c + half) * RES)];
        sum += x[i] * w;
        wsum += w;
      }
      out[j] = wsum > 0.5 ? sum / wsum : sum; // unit gain also at the two edges, where part of the kernel is cut off
    }
    return out;
  }
  function toInt16(x) {
    const out = new Int16Array(x.length);
    for (let i = 0; i < x.length; i++) {
      const v = Math.max(-1, Math.min(1, x[i]));
      out[i] = v < 0 ? Math.round(v * 32768) : Math.round(v * 32767);
    }
    return out;
  }
  function encodeWav(int16, rate) {
    const n = int16.length;
    const buf = new ArrayBuffer(44 + n * 2);
    const v = new DataView(buf);
    const str = (o, s) => { for (let i = 0; i < s.length; i++) v.setUint8(o + i, s.charCodeAt(i)); };
    str(0, 'RIFF'); v.setUint32(4, 36 + n * 2, true); str(8, 'WAVE'); str(12, 'fmt ');
    v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 1, true);
    v.setUint32(24, rate, true); v.setUint32(28, rate * 2, true); v.setUint16(32, 2, true); v.setUint16(34, 16, true);
    str(36, 'data'); v.setUint32(40, n * 2, true);
    for (let i = 0; i < n; i++) v.setInt16(44 + i * 2, int16[i], true);
    return new Uint8Array(buf);
  }
  function level(int16) {
    let peak = 0, sum = 0, clip = 0;
    for (let i = 0; i < int16.length; i++) {
      const a = Math.abs(int16[i]);
      if (a > peak) peak = a;
      sum += a * a;
      if (a >= 32700) clip++;
    }
    return { peak: peak / 32768, rms: int16.length ? Math.sqrt(sum / int16.length) / 32768 : 0, clip: int16.length ? clip / int16.length : 0 };
  }
  // block: nothing worth saving. warn: saved, but the person is told.
  function judge(lv, seconds) {
    if (lv.peak < 0.01) return { block: 'ما سمعت صوت. تأكّد من الميكروفون وعيّد.' };
    if (seconds < 0.8) return { block: 'التسجيل قصير. عيّد وكمّل الجملة.' };
    if (lv.peak < 0.06) return { warn: 'الصوت خافت. قرّب الجوال شوي أو ارفع صوتك.' };
    if (lv.clip > 0.005) return { warn: 'الصوت عالي ومقطّع. ابعد الجوال شوي.' };
    return {};
  }
  // A whole take: raw Float32 chunks at the device's rate -> the WAV to save.
  function makeWav(chunks, deviceRate) {
    const trimmed = trimSilence(concat(chunks), deviceRate);
    const int16 = toInt16(resample(trimmed, deviceRate, TARGET_RATE));
    const seconds = int16.length / TARGET_RATE;
    const lv = level(int16);
    return { wav: encodeWav(int16, TARGET_RATE), seconds: Math.round(seconds * 100) / 100, level: lv, verdict: judge(lv, seconds) };
  }

  /* ---------- upload batches and counters ---------- */
  // Takes from the front of the queue (same speaker only) while the JSON stays under Vercel's 4.5 MB.
  function batchPlan(queue, maxItems = 8, maxBytes = 2900000) {
    const out = [];
    let bytes = 0;
    for (const it of queue) {
      if (out.length && it.speaker !== out[0].speaker) break;
      const b = Math.ceil(it.size * 4 / 3) + 600;
      if (out.length && (out.length >= maxItems || bytes + b > maxBytes)) break;
      out.push(it);
      bytes += b;
    }
    return out;
  }
  function fmtTime(seconds) {
    const s = Math.max(0, +seconds || 0);
    return s < 60 ? Math.round(s) + ' ثانية' : (s / 60).toFixed(1) + ' دقيقة';
  }
  function newId() {
    const a = '0123456789abcdefghijklmnopqrstuvwxyz';
    let r = (Date.now() % 1679616).toString(36).padStart(4, '0');
    const c = typeof crypto !== 'undefined' && crypto.getRandomValues ? crypto.getRandomValues(new Uint8Array(10)) : Array.from({ length: 10 }, () => Math.floor(Math.random() * 256));
    for (let i = 0; i < 10; i++) r += a[c[i] % 36];
    return r;
  }

  const api = { TARGET_RATE, REGS, PATTERN, cleanName, nameKey, cleanText, hash32, mulberry32, buildOrder, concat, trimSilence, resample, toInt16, encodeWav, level, judge, makeWav, batchPlan, fmtTime, newId };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.OVRec = api;
})(typeof window !== 'undefined' ? window : globalThis);
