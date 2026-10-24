// The recording page. Shows one sentence at a time, records it, trims/resamples it into a 24 kHz WAV
// (record-lib.js), keeps it in IndexedDB until /api/record has taken it, and shows the minutes counter.
(function () {
  'use strict';
  const L = window.OVRec;
  const $ = (id) => document.getElementById(id);
  const MAX_SEC = 25;                 // one sentence never needs more; also keeps the WAV well under the server cap
  const IDLE_CLOSE_MS = 60 * 1000;    // the microphone is released a minute after the last take

  /* ---------- small helpers ---------- */
  const store = {
    get(k) { try { return localStorage.getItem(k); } catch (e) { return null; /* private mode: the page works, it just forgets */ } },
    set(k, v) { try { localStorage.setItem(k, v); return true; } catch (e) { return false; /* same */ } },
  };
  let toastTimer = 0;
  function toast(msg, ms = 4500) {
    const t = $('toast');
    t.textContent = msg; t.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { t.hidden = true; }, ms);
  }
  function status(msg, kind) { const s = $('status'); s.textContent = msg || ''; s.className = kind || ''; }
  function b64(u8) {
    let s = '';
    for (let i = 0; i < u8.length; i += 0x8000) s += String.fromCharCode.apply(null, u8.subarray(i, i + 0x8000));
    return btoa(s);
  }
  const clock = (sec) => Math.floor(sec / 60) + ':' + String(Math.floor(sec % 60)).padStart(2, '0');

  /* ---------- state ---------- */
  const S = {
    key: '', name: '', items: null, order: [], pos: 0,
    state: 'idle',                    // idle | opening | rec | busy | review | saving
    mic: null, rec: null, take: null, peak: 0, closeTimer: 0, tick: 0, raf: 0,
    pend: new Map(),                  // rid -> { speaker, dur } for everything waiting to upload
    flushing: false, again: false, flushTimer: 0, backoff: 0, nextTry: 0, maxItems: 8, keyBad: false,
    stats: null, statsErr: '', shown: { mine: 0, total: 0 }, synced: false,
  };
  const posKey = () => 'ov_rec_pos:' + L.nameKey(S.name) + (S.dialect ? ':' + S.dialect : '');

  /* ---------- the queue (IndexedDB, with memory as the fallback) ---------- */
  const Q = (() => {
    let db = null;
    const mem = new Map();
    const ready = new Promise((res) => {
      try {
        const rq = indexedDB.open('omran-voices-rec', 1);
        rq.onupgradeneeded = () => rq.result.createObjectStore('q', { keyPath: 'rid' });
        rq.onsuccess = () => { db = rq.result; res(); };
        rq.onerror = rq.onblocked = () => res();
      } catch (e) { res(); /* no IndexedDB: recordings wait in memory while the page is open */ }
    });
    const run = (mode, fn) => new Promise((res, rej) => {
      const t = db.transaction('q', mode);
      const rq = fn(t.objectStore('q'));
      t.oncomplete = () => res(rq && rq.result);
      t.onerror = t.onabort = () => rej(t.error);
    });
    return {
      async put(it) {
        await ready;
        if (db) { try { await run('readwrite', (s) => s.put(it)); return; } catch (e) { toast('تخزين الجوال ممتلي، ارفع التسجيلات الحين قبل لا تسكّر الصفحة.'); } }
        mem.set(it.rid, it);
      },
      async all() {
        await ready;
        const rows = db ? await run('readonly', (s) => s.getAll()).catch(() => []) : [];
        return rows.concat([...mem.values()]).sort((a, b) => a.ts - b.ts);
      },
      async del(rids) {
        await ready;
        for (const r of rids) mem.delete(r);
        if (db) await Promise.all(rids.map((r) => run('readwrite', (s) => s.delete(r)).catch(() => null)));
      },
    };
  })();

  /* ---------- server ---------- */
  async function api(method, body, query) {
    const headers = { 'X-Record-Key': encodeURIComponent(S.key) };
    if (body) headers['Content-Type'] = 'application/json';
    const r = await fetch('/api/record' + (query || ''), { method, headers, body: body ? JSON.stringify(body) : undefined, cache: 'no-store' });
    let j = null;
    try { j = await r.json(); } catch (e) { j = null; /* the platform answered with an HTML error page */ }
    return { r, j: j || {} };
  }
  function keyBad() {
    S.keyBad = true;
    toast('الرابط غلط أو قديم. اطلب الرابط الجديد من عمران.', 9000);
    renderPending();
  }

  // record.html?k=...&check=1 — for the owner after setting the Vercel variables: is the write key good, is the dataset there and private?
  async function runCheck() {
    $('checkCard').hidden = false;
    const out = $('checkOut');
    out.textContent = '…';
    try {
      const { r, j } = await api('GET', null, '?check=1');
      const lines = ['HTTP ' + r.status];
      if (j.token) lines.push('مفتاح الكتابة (HF_WRITE_TOKEN): ' + j.token);
      if (j.user) lines.push('الحساب: ' + j.user);
      if (j.repo) lines.push('المستودع: ' + j.repo + (j.private ? ' (خاص)' : ''));
      // What this page sent, without showing it all: compare it with the value set in Vercel.
      const k = String(S.key);
      lines.push('المفتاح اللي أرسلته: ' + (k.length > 4 ? k.slice(0, 2) + '…' + k.slice(-2) : '…') + ' (' + k.length + ' حرف)');
      lines.push(r.ok && j.ok ? 'النتيجة: شغّال ✓' : 'النتيجة: فيه مشكلة — ' + (j.error || j.code || 'غير معروفة'));
      out.textContent = lines.join('\n');
    } catch (e) { out.textContent = 'ما قدرت أوصل للخادم: ' + (e && e.message || e); }
  }

  /* ---------- sentences ---------- */
  const cur = () => S.items[S.order[S.pos]];
  function autosize() { const t = $('text'); t.style.height = 'auto'; t.style.height = Math.max(96, t.scrollHeight + 2) + 'px'; }
  function onEdit() {
    const ed = S.items && S.pos < S.order.length && L.cleanText($('text').value) !== cur()[1];
    $('edited').hidden = !ed; $('revert').hidden = !ed;
    autosize();
  }
  function showSentence() {
    const done = S.pos >= S.order.length;
    $('doneCard').hidden = !done; $('sentenceCard').hidden = done; $('stageCard').hidden = done;
    if (done) return;
    const s = cur();
    $('text').value = s[1];
    $('pos').textContent = 'جملة ' + (S.pos + 1);
    const tag = [s[3], L.dialectLabel(s[5])].filter(Boolean).join(' · ');
    $('topic').textContent = tag;
    $('topic').hidden = !tag;
    onEdit();
    setState('idle');
    status('اضغط الميكروفون وتكلّم');
  }
  function advance() {
    S.pos++;
    store.set(posKey(), String(S.pos));
    showSentence();
  }

  /* ---------- state -> screen ---------- */
  function setState(st) {
    S.state = st;
    const stage = $('stage');
    $('stageCard').classList.toggle('rec-on', st === 'rec');
    stage.hidden = st === 'review' || st === 'saving';
    $('review').hidden = !(st === 'review' || st === 'saving');
    $('text').disabled = st === 'rec' || st === 'busy' || st === 'opening';
    $('mic').disabled = st === 'busy' || st === 'opening';
    $('mic').setAttribute('aria-label', st === 'rec' ? 'وقّف' : 'سجّل');
    $('skip').disabled = st === 'busy' || st === 'saving';
    $('next').disabled = st === 'saving';
    $('redo').disabled = st === 'saving';
    if (st !== 'rec') $('timer').textContent = '0:00';
  }

  /* ---------- the microphone ---------- */
  const WORKLET = 'class P extends AudioWorkletProcessor{constructor(){super();this.b=new Float32Array(2048);this.n=0}' +
    'process(i){const c=i[0]&&i[0][0];if(!c)return true;for(let k=0;k<c.length;k++){this.b[this.n++]=c[k];' +
    'if(this.n===2048){this.port.postMessage(this.b,[this.b.buffer]);this.b=new Float32Array(2048);this.n=0}}return true}}' +
    "registerProcessor('ov-cap',P)";

  function feed(f32) {
    const r = S.rec;
    if (!r) return;
    r.chunks.push(f32);
    r.n += f32.length;
    let p = 0;
    for (let i = 0; i < f32.length; i++) { const a = Math.abs(f32[i]); if (a > p) p = a; }
    if (p > S.peak) S.peak = p;
    if (r.n / S.mic.rate >= MAX_SEC) { status('وصلت ' + MAX_SEC + ' ثانية، وقّفت لك.', 'warn'); stop(); }
  }
  async function openMic() {
    if (S.mic && S.mic.stream.active && S.mic.ctx.state !== 'closed') {
      if (S.mic.ctx.state === 'suspended') await S.mic.ctx.resume();
      return S.mic;
    }
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) throw Object.assign(new Error('unsupported'), { name: 'Unsupported' });
    const stream = await navigator.mediaDevices.getUserMedia({ audio: { channelCount: 1, echoCancellation: false, noiseSuppression: false, autoGainControl: true } });
    const Ctx = window.AudioContext || window.webkitAudioContext;
    const ctx = new Ctx({ latencyHint: 'interactive' });
    if (ctx.state === 'suspended') await ctx.resume();
    const src = ctx.createMediaStreamSource(stream);
    const mute = ctx.createGain();
    mute.gain.value = 0;
    mute.connect(ctx.destination);
    const mic = { stream, ctx, src, node: null, rate: ctx.sampleRate };
    S.mic = mic;
    if (ctx.audioWorklet && window.AudioWorkletNode) {
      try {
        const url = URL.createObjectURL(new Blob([WORKLET], { type: 'text/javascript' }));
        await ctx.audioWorklet.addModule(url);
        URL.revokeObjectURL(url);
        const node = new AudioWorkletNode(ctx, 'ov-cap', { numberOfInputs: 1, numberOfOutputs: 1, channelCount: 1 });
        node.port.onmessage = (e) => feed(e.data);
        src.connect(node); node.connect(mute);
        mic.node = node;
      } catch (e) { mic.node = null; /* the worklet could not load (old browser): the ScriptProcessor below does the same job */ }
    }
    if (!mic.node) {
      const sp = ctx.createScriptProcessor(4096, 1, 1);
      sp.onaudioprocess = (e) => feed(new Float32Array(e.inputBuffer.getChannelData(0)));
      src.connect(sp); sp.connect(mute);
      mic.node = sp;
    }
    return mic;
  }
  function closeMic() {
    clearTimeout(S.closeTimer);
    const m = S.mic;
    if (!m) return;
    S.mic = null;
    try { m.stream.getTracks().forEach((t) => t.stop()); m.ctx.close(); } catch (e) { /* already closed */ }
  }
  function micMessage(e) {
    if (e && e.name === 'NotAllowedError') return 'الميكروفون مقفل على هالصفحة. اسمح له من إعدادات المتصفح ثم عيد المحاولة.';
    if (e && e.name === 'NotFoundError') return 'ما لقيت ميكروفون في الجهاز.';
    if (e && e.name === 'Unsupported') return 'المتصفح ما يدعم التسجيل. جرّب Chrome أو Safari.';
    return 'ما قدرت أشغّل الميكروفون' + (e && e.name ? ' (' + e.name + ')' : '') + '.';
  }

  /* ---------- one take ---------- */
  function meterLoop() {
    S.peak *= 0.82;
    $('mic').style.setProperty('--lvl', String(Math.min(1, S.peak * 2.5)));
    if (S.state === 'rec') S.raf = requestAnimationFrame(meterLoop);
    else $('mic').style.setProperty('--lvl', '0');
  }
  async function start() {
    if (S.state !== 'idle' || !L.cleanText($('text').value)) return;
    setState('opening');
    status('جاري تشغيل الميكروفون…');
    try { await openMic(); } catch (e) { setState('idle'); status(micMessage(e), 'bad'); return; }
    clearTimeout(S.closeTimer);
    S.rec = { chunks: [], n: 0, t0: performance.now() };
    S.peak = 0;
    setState('rec');
    status('تكلّم… وإذا خلصت اضغط مرة ثانية');
    S.tick = setInterval(() => { $('timer').textContent = clock((performance.now() - S.rec.t0) / 1000); }, 200);
    S.raf = requestAnimationFrame(meterLoop);
  }
  function release() {
    clearInterval(S.tick);
    cancelAnimationFrame(S.raf);
    $('mic').style.setProperty('--lvl', '0'); // the meter loop stops with the take, so the halo is cleared here
    clearTimeout(S.closeTimer);
    S.closeTimer = setTimeout(closeMic, IDLE_CLOSE_MS);
  }
  function stop() {
    const r = S.rec;
    if (!r || S.state !== 'rec') return;
    S.rec = null;
    release();
    setState('busy');
    const rate = S.mic.rate;
    setTimeout(() => finish(r, rate), 30); // lets the screen repaint before the (short) heavy work
  }
  function finish(r, rate) {
    const t = L.makeWav(r.chunks, rate);
    if (t.verdict.block) { setState('idle'); status(t.verdict.block, 'bad'); return; }
    S.take = { wav: t.wav, seconds: t.seconds, url: URL.createObjectURL(new Blob([t.wav], { type: 'audio/wav' })) };
    $('player').src = S.take.url;
    setState('review');
    if (t.verdict.warn) status(t.verdict.warn + ' تقدر تعيد أو تكمّل.', 'warn');
    else status('اسمع تسجيلك، وإذا زين اضغط «التالي».', 'ok');
  }
  function dropTake() {
    if (S.take) { URL.revokeObjectURL(S.take.url); $('player').removeAttribute('src'); S.take = null; }
  }
  function redo() {
    if (S.state !== 'review') return;
    dropTake();
    setState('idle');
    status('اضغط الميكروفون وسجّل مرة ثانية');
  }
  async function next() {
    if (S.state !== 'review' || !S.take) return;
    const text = L.cleanText($('text').value);
    if (!text) { status('الجملة فاضية. اكتب النص قبل لا تكمّل.', 'bad'); return; }
    setState('saving');
    const s = cur();
    const it = { rid: L.newId(), speaker: S.name, sid: s[0], text, original: s[1], reg: s[2], topic: s[3] || '', dialect: s[5] || '', ts: Date.now(),
      dur: S.take.seconds, size: S.take.wav.length, wav: S.take.wav };
    await Q.put(it);
    S.pend.set(it.rid, { speaker: it.speaker, dur: it.dur });
    dropTake();
    advance();
    renderStats(); renderPending();
    scheduleFlush();
  }
  function skip() {
    if (!S.items || S.state === 'busy' || S.state === 'saving') return;
    if (S.state === 'rec') { S.rec = null; release(); }
    dropTake();
    advance();
  }

  /* ---------- upload ---------- */
  function scheduleFlush() {
    clearTimeout(S.flushTimer);
    if (!S.pend.size || S.keyBad) return;
    if (S.pend.size >= 5) { flush(); return; }
    S.flushTimer = setTimeout(flush, 20000);
  }
  function retryLater(sec) {
    S.backoff = Math.min(300, Math.max(sec, S.backoff ? S.backoff * 2 : 5));
    S.nextTry = Date.now() + S.backoff * 1000;
    clearTimeout(S.flushTimer);
    S.flushTimer = setTimeout(flush, S.backoff * 1000);
    renderPending();
  }
  async function flush() {
    if (S.flushing) { S.again = true; return; }
    if (S.keyBad) return;
    S.flushing = true;
    clearTimeout(S.flushTimer);
    S.nextTry = 0;
    renderPending();
    try {
      for (;;) {
        const all = await Q.all();
        if (!all.length) break;
        const plan = L.batchPlan(all, S.maxItems);
        const items = plan.map((it) => ({ rid: it.rid, sid: it.sid, text: it.text, original: it.original, reg: it.reg, topic: it.topic, ts: it.ts, wav: b64(it.wav) }));
        let res;
        try { res = await api('POST', { speaker: plan[0].speaker, consent: true, items }); } catch (e) { retryLater(5); return; /* offline: it stays queued */ }
        const { r, j } = res;
        if (r.ok && j.ok) {
          const gone = (j.saved || []).concat((j.rejected || []).map((x) => x.rid));
          await Q.del(gone);
          gone.forEach((rid) => S.pend.delete(rid));
          if (j.rejected && j.rejected.length) toast(j.rejected.length + ' تسجيل ما انقبل: ' + j.rejected[0].reason, 8000);
          S.backoff = 0;
          renderPending();
          loadStats();
          continue;
        }
        if (r.status === 401) { keyBad(); return; }
        if (r.status === 413 && plan.length > 1) { S.maxItems = Math.max(1, Math.floor(plan.length / 2)); continue; }
        if (j.error && r.status !== 503) toast(j.error, 8000);
        retryLater(Math.max(+j.retryAfter || 0, +r.headers.get('Retry-After') || 0));
        return;
      }
    } finally {
      S.flushing = false;
      renderPending();
      if (S.again) { S.again = false; scheduleFlush(); }
    }
  }
  function renderPending() {
    const n = S.pend.size;
    $('pend').hidden = n === 0;
    if (!n) return;
    let t = n + (n === 1 ? ' تسجيل' : ' تسجيلات') + ' بانتظار الرفع';
    if (S.keyBad) t += ' — الرابط غلط';
    else if (S.flushing) t += ' — جاري الرفع…';
    else if (S.nextTry) t += ' — أعيد المحاولة بعد ' + Math.max(1, Math.ceil((S.nextTry - Date.now()) / 1000)) + ' ثانية';
    $('pendText').textContent = t;
    $('pend').classList.toggle('late', !!S.nextTry || S.keyBad);
    $('sync').disabled = S.flushing;
  }

  /* ---------- counter ---------- */
  function mineRow() { return S.stats && S.stats.speakers.find((x) => L.nameKey(x.name) === L.nameKey(S.name)); }
  function renderStats() {
    let pend = 0;
    for (const p of S.pend.values()) if (L.nameKey(p.speaker) === L.nameKey(S.name)) pend += p.dur;
    const row = mineRow();
    // Counts only grow: a server answer cached a few seconds ago must not make the numbers step back.
    const mine = Math.max(S.shown.mine, (row ? row.seconds : 0) + pend);
    const total = Math.max(S.shown.total, (S.stats ? S.stats.total.seconds : 0) + pend);
    S.shown = { mine, total };
    $('mine').textContent = L.fmtTime(mine);
    $('total').textContent = S.stats || pend ? L.fmtTime(total) : '…';
    const rows = S.stats ? S.stats.speakers.map((x) => ({ name: x.name, seconds: x.seconds, me: L.nameKey(x.name) === L.nameKey(S.name) })) : [];
    const me = rows.find((x) => x.me);
    if (me) me.seconds = Math.max(me.seconds, mine); else if (mine > 0) rows.push({ name: S.name, seconds: mine, me: true });
    rows.sort((a, b) => b.seconds - a.seconds);
    const top = rows.length ? rows[0].seconds || 1 : 1;
    const box = $('people');
    box.textContent = '';
    for (const x of rows) {
      const d = document.createElement('div'); d.className = 'p' + (x.me ? ' me' : '');
      const n = document.createElement('span'); n.className = 'n'; n.textContent = x.name;
      const b = document.createElement('span'); b.className = 'b'; const i = document.createElement('i'); i.style.width = Math.max(2, x.seconds / top * 100) + '%'; b.appendChild(i);
      const m = document.createElement('span'); m.className = 'm'; m.textContent = L.fmtTime(x.seconds);
      d.append(n, b, m);
      box.appendChild(d);
    }
    $('peopleSum').textContent = S.statsErr ? S.statsErr : 'مين سجّل كم' + (rows.length ? ' (' + rows.length + ')' : '');
  }
  async function loadStats() {
    try {
      const { r, j } = await api('GET');
      if (r.status === 401) { keyBad(); return; }
      if (r.ok && Array.isArray(j.speakers)) { S.stats = j; S.statsErr = ''; firstSync(); } else S.statsErr = j.error || 'العدّاد ما اشتغل.';
    } catch (e) { S.statsErr = S.stats ? '' : 'ما قدرت أجيب العدّاد (ما فيه نت؟)'; /* the last numbers stay on screen */ }
    renderStats();
  }
  // A new device for a name that already recorded elsewhere: carry on from where the count says, not from 1.
  function firstSync() {
    if (S.synced) return;
    S.synced = true;
    const row = mineRow();
    // (only for the plain order: a picked dialect reorders the start, so the count does not map to a place)
    if (!S.dialect && store.get(posKey()) == null && row && row.count > S.pos && S.state === 'idle') {
      S.pos = Math.min(row.count, S.order.length);
      store.set(posKey(), String(S.pos));
      showSentence();
      toast('كمّلنا لك من الجملة ' + (S.pos + 1) + ' على حسب تسجيلاتك اللي فاتت.');
    }
  }

  /* ---------- start ---------- */
  async function begin() {
    $('setup').hidden = true; $('app').hidden = false;
    $('who').textContent = 'مسجّل باسم: ' + S.name;
    S.stats = S.stats; S.synced = false; S.shown = { mine: 0, total: S.shown.total };
    if (!S.items) {
      status('جاري تحميل الجمل…');
      try {
        const r = await fetch('/data/sentences.json');
        if (!r.ok) throw new Error('http ' + r.status);
        S.items = await r.json();
        // the Gulf dialect sentences (ids 10000+); without them the page still works with the 10 000
        try { const d = await fetch('/data/dialects.json'); if (d.ok) S.items = S.items.concat(await d.json()); } catch (e) { /* keep the 10 000 */ }
      } catch (e) { setState('idle'); status('ما قدرت أحمّل الجمل. حدّث الصفحة.', 'bad'); return; }
    }
    S.order = L.buildOrder(S.items, S.name, S.dialect);
    const saved = parseInt(store.get(posKey()), 10);
    S.pos = saved > 0 ? Math.min(saved, S.order.length) : 0;
    showSentence();
    renderStats(); renderPending();
    loadStats();
    scheduleFlush();
  }
  function showSetup(msg) {
    dropTake();
    if (S.rec) { S.rec = null; release(); }
    $('app').hidden = true; $('setup').hidden = false;
    $('name').value = S.name;
    $('consent').checked = store.get('ov_rec_consent') === '1';
    $('dialect').value = S.dialect || '';
    $('seterr').textContent = msg || '';
  }
  function go() {
    const name = L.cleanName($('name').value);
    if (name.length < 2) { $('seterr').textContent = 'اكتب اسمك (حرفين على الأقل).'; return; }
    if (!L.nameKey(name)) { $('seterr').textContent = 'اكتب اسمك بحروف.'; return; }
    if (!$('consent').checked) { $('seterr').textContent = 'لازم توافق قبل لا نبدأ.'; return; }
    if (L.nameKey(name) !== L.nameKey(S.name)) S.shown = { mine: 0, total: S.shown.total };
    S.name = name;
    S.dialect = $('dialect').value || '';
    store.set('ov_rec_name', name); store.set('ov_rec_consent', '1'); store.set('ov_rec_dialect', S.dialect);
    begin();
  }

  function fillDialects() {
    const sel = $('dialect');
    for (const d of L.DIALECTS) {
      const o = document.createElement('option');
      o.value = d.key; o.textContent = d.label + (d.soon ? ' (قريب)' : ''); o.disabled = !!d.soon;
      sel.appendChild(o);
    }
  }
  function init() {
    fillDialects();
    const u = new URL(location.href);
    const k = u.searchParams.get('k');
    if (k) {
      S.key = k;
      if (store.set('ov_rec_key', k)) { // the key leaves the address bar once it is remembered
        u.searchParams.delete('k');
        history.replaceState(null, '', u.pathname + u.search + u.hash);
      }
    } else S.key = store.get('ov_rec_key') || '';
    if (!S.key) { $('badkey').hidden = false; return; }
    if (u.searchParams.get('check')) runCheck();

    $('go').onclick = go;
    $('name').addEventListener('keydown', (e) => { if (e.key === 'Enter') go(); });
    $('mic').onclick = () => (S.state === 'rec' ? stop() : start());
    $('redo').onclick = redo;
    $('next').onclick = next;
    $('skip').onclick = skip;
    $('revert').onclick = () => { $('text').value = cur()[1]; onEdit(); };
    $('text').addEventListener('input', onEdit);
    $('rename').onclick = () => showSetup('');
    $('sync').onclick = () => { S.backoff = 0; flush(); };
    window.addEventListener('resize', autosize);
    window.addEventListener('online', () => { S.backoff = 0; flush(); });
    window.addEventListener('pagehide', closeMic);
    window.addEventListener('beforeunload', (e) => { if (S.state === 'rec' || S.state === 'review') { e.preventDefault(); e.returnValue = ''; } });
    document.addEventListener('visibilitychange', () => {
      if (document.hidden) { if (S.state !== 'rec') closeMic(); if (S.pend.size) flush(); } else loadStats();
    });
    document.addEventListener('keydown', (e) => {
      if (e.ctrlKey || e.metaKey || e.altKey || $('app').hidden) return;
      const tag = (document.activeElement && document.activeElement.tagName) || '';
      if (tag === 'TEXTAREA' || tag === 'INPUT') return;
      if (e.key === ' ' || e.code === 'Space') { e.preventDefault(); if (S.state === 'rec') stop(); else if (S.state === 'idle') start(); }
      else if (e.key === 'Enter' && S.state === 'review') { e.preventDefault(); next(); }
      else if ((e.key === 'r' || e.key === 'R' || e.key === 'ر') && S.state === 'review') redo();
      else if ((e.key === 's' || e.key === 'S' || e.key === 'س') && (S.state === 'idle' || S.state === 'review')) skip();
    });
    setInterval(() => { if (!document.hidden && !$('app').hidden) loadStats(); }, 30000);
    setInterval(() => { if (S.nextTry && !S.flushing) renderPending(); }, 1000);

    Q.all().then((rows) => {
      rows.forEach((x) => S.pend.set(x.rid, { speaker: x.speaker, dur: x.dur }));
      S.name = store.get('ov_rec_name') || '';
      S.dialect = store.get('ov_rec_dialect') || '';
      if (!L.DIALECTS.some((d) => d.key === S.dialect && !d.soon)) S.dialect = '';
      if (S.name && store.get('ov_rec_consent') === '1') begin(); else showSetup('');
    });
  }
  init();
})();
