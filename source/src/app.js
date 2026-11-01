(function () {
'use strict';
const E = window.FBEngine, NB = E.NB, clamp = E.clamp;
const $ = (id) => document.getElementById(id);
const nextFrame = () => new Promise((r) => requestAnimationFrame(r));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const DPR = () => Math.min(window.devicePixelRatio || 1, 2.5);
const SMALL = () => window.innerWidth < 760;
const TOUCH = matchMedia('(pointer: coarse)').matches;
const TILE = 512;
const PROXY_H = 144;
const IN_VIEWER = !!(window.claude && typeof window.claude.use === 'function');
const MUXER_URL = window.__FB_MUXER_URL || 'https://cdn.jsdelivr.net/npm/mp4-muxer@5.2.2/build/mp4-muxer.js';

/* ------------------------------------------------------------ settings */
const DEV0 = { depth: 0.5, lockBand: -1, smooth: 12, stabilize: 0.85, seams: 0.5, stretch: 1, source: 'motion', fixed: 12, trimIn: 0, trimOut: 1, direction: 'auto', layers: 'smooth' };
const SRC0 = { slit: 0.5, cropTop: 0.08, cropBot: 0.92, level: 0, outH: 1080, gps: false, keep: true };
const EX0 = { scale: 1, style: 'sweep', frame: '1920x1080', pace: 'real', len: 20, fps: 30, line: true };
const prefs = {
  get(k, d) { try { const v = localStorage.getItem('fensterband.' + k); return Object.assign({}, d, v ? JSON.parse(v) : {}); } catch (e) { return Object.assign({}, d); } },
  set(k, v) { try { localStorage.setItem('fensterband.' + k, JSON.stringify(v)); } catch (e) { /* storage unavailable */ } },
};

const S = {
  mode: 'demo',
  dev: prefs.get('dev', DEV0),
  src: prefs.get('src', SRC0),
  ex: prefs.get('export', EX0),
  sess: null, track: null, version: 0,
  source: null, cap: null,
  scanning: null,
  view: { z: 0.5, x: 0, y: 0, mode: 'fit', follow: true },
  hoverFrame: -1,
  clip: null, demoT0: 0, demoFi: -1,
  dirty: { stage: true, graph: true, overview: true },
};
S.dev.trimIn = 0; S.dev.trimOut = 1; S.dev.lockBand = -1;

/* --------------------------------------------------------------- colors */
const C = {};
function readColors() {
  const cs = getComputedStyle(document.documentElement);
  for (const k of ['ground', 'panel', 'sunk', 'stage', 'ink', 'ink-2', 'muted', 'line', 'line-strong', 'signal', 'signal-hi', 'data', 'rec']) C[k] = cs.getPropertyValue('--' + k).trim() || '#888';
  C.mono = cs.getPropertyValue('--f-mono').trim() || 'monospace';
  C.display = cs.getPropertyValue('--f-display').trim() || 'sans-serif';
  markAll();
}

/* -------------------------------------------------------------- helpers */
function mk(w, h) { const c = document.createElement('canvas'); c.width = Math.max(1, w | 0); c.height = Math.max(1, h | 0); return c; }
const fmtInt = (n) => String(Math.round(n)).replace(/\B(?=(\d{3})+(?!\d))/g, ' ');
function fmtTime(s, dec = 1) {
  const q = Math.pow(10, dec);
  s = Math.round(Math.max(0, s) * q) / q;
  const m = Math.floor(s / 60), r = s - m * 60;
  return m + ':' + (r < 10 ? '0' : '') + r.toFixed(dec);
}
function stamp() {
  const d = new Date(), p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}`;
}
let toastTimer = 0;
function toast(msg, err) {
  const t = $('toast');
  t.textContent = msg;
  t.classList.toggle('err', !!err);
  t.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove('show'), err ? 5600 : 2600);
}
function markAll() { S.dirty.stage = S.dirty.graph = S.dirty.overview = true; }
function waitFor(fn, ms) {
  return new Promise((res) => {
    const t0 = performance.now();
    (function chk() { if (fn()) res(true); else if (performance.now() - t0 > ms) res(false); else setTimeout(chk, 30); })();
  });
}
function once(el, ev, ms) {
  return new Promise((res) => {
    let to = 0;
    const h = () => { clearTimeout(to); el.removeEventListener(ev, h); res(true); };
    el.addEventListener(ev, h);
    to = setTimeout(() => { el.removeEventListener(ev, h); res(false); }, ms || 4000);
  });
}

/* draw the source frame, rotated by `level` about its centre, mapping source
   rows [sy0, sy1) onto a dw x dh canvas */
function drawSource(ctx, el, W, H, level, sy0, sy1, dw, dh) {
  const s = dh / (sy1 - sy0);
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.fillStyle = '#000';
  ctx.fillRect(0, 0, dw, dh);
  ctx.setTransform(s, 0, 0, s, 0, -sy0 * s);
  if (level) { ctx.translate(W / 2, H / 2); ctx.rotate(level); ctx.translate(-W / 2, -H / 2); }
  ctx.drawImage(el, 0, 0, W, H);
  ctx.setTransform(1, 0, 0, 1, 0, 0);
}

function makeGeom(source, src) {
  const W = source.w, H = source.h;
  const cropH = (src.cropBot - src.cropTop) * H;
  const OH = Math.max(96, Math.min(src.outH, Math.round(cropH))) & ~1;
  const sOut = OH / cropH;
  const M = Math.round(OH * 0.06);
  const AW = W >= H ? 384 : 288;
  const capW = Math.round(W * sOut);
  return {
    srcW: W, srcH: H, level: src.level * Math.PI / 180, slit: src.slit,
    cropTop: src.cropTop, cropBot: src.cropBot,
    OH, sOut, M, capW, capH: OH + 2 * M, AW, AH: Math.round(AW * H / W), kOut: capW / AW,
  };
}
const geomKey = (g) => [g.srcW, g.srcH, g.level.toFixed(4), g.slit.toFixed(4), g.cropTop.toFixed(4), g.cropBot.toFixed(4), g.OH].join('|');
const proxyTier = () => (S.sess ? PROXY_H / S.sess.geom.OH : 0.1);

/* --------------------------------------------------------- strip store
   Every frame keeps one strip around the slit. Recent strips stay raw in
   memory; older ones live as JPEG and are decoded when a render needs them.
   A small proxy copy of each strip is always kept for overviews. */
const ENC_WORKER = `
let cv = null, ctx = null;
self.onmessage = async (e) => {
  const { id, w, h, buf, q } = e.data;
  try {
    if (!cv) { cv = new OffscreenCanvas(w, h); ctx = cv.getContext('2d'); }
    if (cv.width !== w || cv.height !== h) { cv.width = w; cv.height = h; }
    ctx.putImageData(new ImageData(new Uint8ClampedArray(buf), w, h), 0, 0);
    const blob = await cv.convertToBlob({ type: 'image/jpeg', quality: q });
    self.postMessage({ id, blob });
  } catch (err) { self.postMessage({ id, error: String(err) }); }
};`;
const jpegCv = mk(8, 8), jpegCtx = jpegCv.getContext('2d');
const decCv = mk(8, 8), decCtx = decCv.getContext('2d', { willReadFrequently: true });
const encPool = (() => {
  const workers = [], waits = new Map();
  let ok = false, seq = 0, next = 0;
  try {
    if (typeof OffscreenCanvas !== 'undefined' && typeof Worker !== 'undefined') {
      const url = URL.createObjectURL(new Blob([ENC_WORKER], { type: 'text/javascript' }));
      const n = Math.max(1, Math.min(3, (navigator.hardwareConcurrency || 4) - 2));
      for (let i = 0; i < n; i++) {
        const w = new Worker(url);
        w.onmessage = (e) => {
          const p = waits.get(e.data.id);
          if (!p) return;
          waits.delete(e.data.id);
          if (e.data.blob) p.res(e.data.blob); else { ok = false; p.rej(new Error(e.data.error)); }
        };
        workers.push(w);
      }
      ok = true;
    }
  } catch (e) { ok = false; }
  return {
    get size() { return ok ? workers.length + 1 : 1; },
    encode(img) {
      if (!ok) return encodeJPEGMain(img);
      const id = ++seq, copy = img.data.slice().buffer;
      return new Promise((res, rej) => {
        waits.set(id, { res, rej });
        workers[next++ % workers.length].postMessage({ id, w: img.width, h: img.height, buf: copy, q: 0.9 }, [copy]);
      }).catch(() => encodeJPEGMain(img));
    },
  };
})();
function encodeJPEG(img) { return encPool.encode(img); }
function encodeJPEGMain(img) {
  jpegCv.width = img.width; jpegCv.height = img.height;
  jpegCtx.putImageData(img, 0, 0);
  return new Promise((res, rej) => jpegCv.toBlob((b) => (b ? res(b) : rej(new Error('encode'))), 'image/jpeg', 0.93));
}
async function decodeJPEG(blob) {
  const bmp = await createImageBitmap(blob);
  decCv.width = bmp.width; decCv.height = bmp.height;
  decCtx.drawImage(bmp, 0, 0);
  const img = decCtx.getImageData(0, 0, bmp.width, bmp.height);
  if (bmp.close) bmp.close();
  return img;
}

class StripStore {
  constructor(budget) {
    this.meta = []; this.full = []; this.blob = []; this.proxy = [];
    this.lru = new Map(); this.raw = 0; this.blobBytes = 0; this.budget = budget;
    this.q = []; this.encoding = false; this.inflight = 0; this.dead = false; this.protect = [-1, -1];
    this.getFull = (t) => { const m = this.meta[t]; return m && m.ref ? m.ref : null; };
    this.getProxy = (t) => this.proxy[t] || null;
  }
  add(t, img, meta, proxy) {
    meta.ref = { data: img.data, w: img.width, h: img.height, cx: meta.cx, M: meta.M, sx: 1, sy: 1 };
    this.meta[t] = meta; this.full[t] = img; this.proxy[t] = proxy;
    this.raw += img.data.length;
    this.lru.set(t, 1);
    this.q.push(t);
    this._pump();
    this._evict();
  }
  get bytes() { return this.raw + this.blobBytes; }
  pending() { return this.q.length + this.inflight; }
  get pressure() { return this.raw / this.budget; }
  _pump() {
    const limit = encPool.size + 1;
    while (this.q.length && this.inflight < limit && !this.dead) {
      const t = this.q.shift();
      const img = this.full[t];
      if (!img || this.blob[t]) continue;
      this.inflight++;
      encodeJPEG(img).then((b) => {
        if (this.dead) return;
        this.blob[t] = b; this.blobBytes += b.size;
        this._evict();
      }).catch(() => { /* keep raw */ }).finally(() => { this.inflight--; this._pump(); });
    }
    this.encoding = this.inflight > 0;
  }
  _evict() {
    if (this.raw <= this.budget) return;
    const [pa, pb] = this.protect;
    for (const t of this.lru.keys()) {
      if (this.raw <= this.budget * 0.85) break;
      if (!this.blob[t] || (t >= pa && t <= pb)) continue;
      const img = this.full[t];
      if (img) { this.raw -= img.data.length; this.full[t] = null; this.meta[t].ref = null; }
      this.lru.delete(t);
    }
  }
  async ensure(ta, tb) {
    this.protect = [ta, tb];
    const need = [];
    for (let t = ta; t <= tb; t++) {
      if (this.full[t]) { this.lru.delete(t); this.lru.set(t, 1); continue; }
      if (this.blob[t]) need.push(t);
    }
    let k = 0;
    const worker = async () => {
      while (k < need.length) {
        const t = need[k++];
        if (this.full[t]) continue;
        const img = await decodeJPEG(this.blob[t]);
        if (this.dead) return;
        const m = this.meta[t];
        m.ref = { data: img.data, w: img.width, h: img.height, cx: m.cx, M: m.M, sx: 1, sy: 1 };
        this.full[t] = img; this.raw += img.data.length;
        this.lru.set(t, 1);
      }
    };
    await Promise.all([worker(), worker(), worker(), worker()]);
    this._evict();
    this.protect = [-1, -1];
  }
}

/* ------------------------------------------------------------- capture
   Runs on every new source frame: motion analysis always (for the live
   meters), strip capture while recording. A frame's strip is cut once the
   next frame has told us how far the scene moved. */
class Capture {
  constructor(source, geom) {
    this.src = source;
    this.aCv = mk(8, 8);
    this.aCtx = this.aCv.getContext('2d', { willReadFrequently: true });
    this.bands = new Float32Array(NB * 3);
    this.lastBands = null;
    this.prior = new Float32Array(NB).fill(NaN);
    this.ok = false; this.rec = null; this.fps = 0; this.lastT = null;
    this.setGeom(geom);
  }
  setGeom(g) {
    if (!this.g || this.g.AW !== g.AW || this.g.AH !== g.AH) {
      this.an = new E.Analyzer(g.AW, g.AH);
      this.aCv.width = g.AW; this.aCv.height = g.AH;
      this.ok = false;
    }
    this.g = g;
  }
  resetMotion() { this.an.reset(); this.ok = false; this.prior.fill(NaN); this.lastT = null; }
  frame(t, gps, dedupe) {
    const g = this.g;
    drawSource(this.aCtx, this.src.el, g.srcW, g.srcH, g.level, 0, g.srcH, g.AW, g.AH);
    const img = this.aCtx.getImageData(0, 0, g.AW, g.AH);
    if (dedupe) {
      // same picture as last time: the camera hasn't delivered a new frame yet
      const d = img.data;
      let h = 2166136261;
      for (let i = 0; i < d.length; i += 4 * 37) h = Math.imul(h ^ (d[i] + 3 * d[i + 1] + 7 * d[i + 2]), 16777619);
      if (h === this.lastSig) return false;
      this.lastSig = h;
    }
    this.an.push(img.data);
    this.ok = this.an.estimate(g.cropTop, g.cropBot, this.prior, this.bands);
    if (this.ok) for (let b = 0; b < NB; b++) this.prior[b] = this.bands[b * 3 + 2] > 0.05 ? this.bands[b * 3] : NaN;
    if (this.lastT != null && t > this.lastT) {
      const f = 1 / (t - this.lastT);
      this.fps = this.fps ? this.fps * 0.92 + f * 0.08 : f;
    }
    this.lastT = t;
    if (this.rec) this._record(t, gps);
    return true;
  }
  start(sess) {
    const g = this.g;
    this.rec = sess;
    this.cap = [mk(g.capW, g.capH), mk(g.capW, g.capH)];
    this.capCtx = this.cap.map((c) => c.getContext('2d'));
    this.bi = 0; this.pending = null; this.lastMax = 0; this.lastBands = null; this.prevStrip = null;
    this.pCv = mk(8, 8);
    this.pCtx = this.pCv.getContext('2d', { willReadFrequently: true });
  }
  _record(t, gps) {
    const g = this.g, sess = this.rec;
    if (sess.t0 == null) sess.t0 = t;
    const ctx = this.capCtx[this.bi];
    this.bi ^= 1;
    drawSource(ctx, this.src.el, g.srcW, g.srcH, g.level, g.cropTop * g.srcH - g.M / g.sOut, g.cropBot * g.srcH + g.M / g.sOut, g.capW, g.capH);
    if (this.pending) this._finalize(this.pending, this.ok ? this.bands : this.lastBands);
    this.pending = { t: t - sess.t0, gps, ctx };
  }
  _finalize(p, bands) {
    const g = this.g, sess = this.rec;
    let umax = 0;
    if (bands) for (let b = 0; b < NB; b++) if (bands[b * 3 + 2] > 0.04) umax = Math.max(umax, Math.abs(bands[b * 3]));
    umax *= g.kOut;
    let half = Math.min(g.capW / 2, Math.ceil(Math.max(umax, this.lastMax) * 1.2 + 16));
    if (sess.store.pressure > 1.4 && bands) {
      // memory is tight: keep enough for mid depths, drop the extreme near range
      const v = [];
      for (let b = 0; b < NB; b++) if (bands[b * 3 + 2] > 0.04) v.push(Math.abs(bands[b * 3]));
      v.sort((a, b) => a - b);
      if (v.length) half = Math.min(half, Math.ceil(v[v.length >> 1] * g.kOut * 2.2 + 16));
    }
    this.lastMax = umax;
    const slitX = g.slit * g.capW;
    const x0 = clamp(Math.floor(slitX - half), 0, g.capW - 2);
    const x1 = clamp(Math.ceil(slitX + half), x0 + 2, g.capW);
    const w = x1 - x0;
    const img = p.ctx.getImageData(x0, 0, w, g.capH);
    const sy = PROXY_H / g.OH;
    const pw = Math.max(2, Math.round(w * sy)), ph = Math.max(2, Math.round(g.capH * sy));
    this.pCv.width = pw; this.pCv.height = ph;
    this.pCtx.imageSmoothingQuality = 'high';
    this.pCtx.drawImage(p.ctx.canvas, x0, 0, w, g.capH, 0, 0, pw, ph);
    const pimg = this.pCtx.getImageData(0, 0, pw, ph);
    const idx = sess.frames.length;
    const bcopy = bands ? Float32Array.from(bands) : null;
    const curRef = { data: img.data, w, h: g.capH, cx: slitX - x0 };
    const prevF = sess.frames[idx - 1];
    if (this.prevStrip && prevF && prevF.bands) {
      const m = E.refineMotion(this.prevStrip, curRef, prevF.bands, g.OH, g.M, g.kOut);
      prevF.dyF = m.dy; prevF.dxF = m.dx;
    }
    this.prevStrip = curRef;
    sess.frames.push({ t: p.t, gps: p.gps, bands: bcopy, dyF: NaN });
    sess.store.add(idx, img, { cx: slitX - x0, M: g.M }, { data: pimg.data, w: pw, h: ph, cx: (slitX - x0) * pw / w, M: g.M, sx: pw / w, sy: ph / g.capH });
    if (Number.isFinite(p.gps)) sess.gpsAny = true;
    if (bcopy) this.lastBands = bcopy;
  }
  stop() {
    if (this.pending && this.rec) this._finalize(this.pending, this.lastBands);
    this.pending = null; this.rec = null; this.cap = null; this.capCtx = null; this.prevStrip = null;
  }
}

/* --------------------------------------------------------------- tiles */
class Tiles {
  constructor(budget) { this.map = new Map(); this.bytes = 0; this.budget = budget; this.want = []; this.running = false; }
  clear() { this.map.clear(); this.bytes = 0; this.want = []; }
  entry(tier, i, h) {
    const key = tier.toFixed(5) + ':' + i;
    let e = this.map.get(key);
    if (e) { this.map.delete(key); this.map.set(key, e); return e; }
    const cv = mk(TILE, h);
    e = { key, tier, i, h, cv, ctx: cv.getContext('2d'), ver: -1, valid: 0, sess: S.sess ? S.sess.id : 0, busy: false };
    this.map.set(key, e);
    this.bytes += TILE * h * 4;
    this._evict();
    return e;
  }
  _evict() {
    for (const [k, e] of this.map) {
      if (this.bytes <= this.budget || this.map.size <= 6) break;
      if (e.busy || e.hold === S.frameNo) continue;
      this.map.delete(k);
      this.bytes -= TILE * e.h * 4;
    }
  }
  needs(e) {
    const tr = S.track;
    if (!tr || !S.sess || e.sess !== S.sess.id) return false;
    if (e.ver !== S.version) return true;
    const WT = Math.floor(tr.L * S.dev.stretch * e.tier);
    return e.valid < Math.min(TILE, WT - e.i * TILE);
  }
  request(list) { this.want = list; if (!this.running) this._run(); }
  async _run() {
    this.running = true;
    let t0 = performance.now();
    while (this.want.length) {
      const e = this.want.shift();
      if (!this.needs(e) || e.busy) continue;
      e.busy = true;
      try { await renderTile(e); } catch (err) { console.warn(err); } finally { e.busy = false; }
      S.dirty.stage = S.dirty.overview = true;
      if (performance.now() - t0 > 10) { await nextFrame(); t0 = performance.now(); }
    }
    this.running = false;
  }
}

async function renderTile(e) {
  const sess = S.sess, dev = S.dev;
  let tr = S.track;
  if (!sess || !tr || e.sess !== sess.id) return;
  const ver = S.version, tier = e.tier;
  if (e.ver !== ver) { e.ctx.clearRect(0, 0, TILE, e.h); e.valid = 0; e.ver = ver; }
  const WT = Math.floor(tr.L * dev.stretch * tier);
  const c0 = e.i * TILE, cEnd = Math.min(c0 + TILE, WT);
  const ca = c0 + e.valid;
  if (ca >= cEnd) return;
  const proxy = tier <= proxyTier() * 1.001;
  if (!proxy) {
    const [ta, tb] = E.framesForCols(tr, dev, ca, cEnd, tier);
    await sess.store.ensure(ta, tb);
    if (S.version !== ver || S.sess !== sess) { e.ver = -1; e.valid = 0; return; }
    tr = S.track;
  }
  const w = cEnd - ca;
  const img = new ImageData(w, e.h);
  const mirror = tr.sigma < 0;
  E.renderCols(tr, dev, proxy ? sess.store.getProxy : sess.store.getFull, {
    c0: ca, c1: cEnd, r0: 0, r1: e.h, sc: tier, buf: img.data, bw: w,
    xMap: mirror ? (cc) => cEnd - 1 - cc : (cc) => cc - ca,
  });
  e.ctx.putImageData(img, mirror ? c0 + TILE - cEnd : ca - c0, 0);
  e.valid = cEnd - c0;
}

const tiles = new Tiles((SMALL() ? 70 : 190) * 1e6);

/* ------------------------------------------------------------ sessions */
let sessSeq = 0;
function newSession(kind, source, geom) {
  if (S.sess) S.sess.store.dead = true;
  const budget = (SMALL() ? 110 : 240) * 1e6;
  const sess = {
    id: ++sessSeq, kind, label: source.label, geom, gk: geomKey(geom), frames: [], store: new StripStore(budget),
    sigma: 1, sigmaLocked: false, done: false, clip: null, gpsAny: false, t0: null,
  };
  S.sess = sess; S.track = null;
  S.dev.trimIn = 0; S.dev.trimOut = 1; S.dev.lockBand = -1;
  S.version++;
  tiles.clear();
  S.hoverFrame = -1;
  syncDevUI();
  return sess;
}

function retrack(anchor) {
  const sess = S.sess;
  if (!sess || sess.frames.length < 2) { S.track = null; markAll(); updateFacts(); return; }
  const live = !!(S.cap && S.cap.rec === sess);
  let keepFrame = -1;
  if (anchor && S.track && !live) keepFrame = frameAtScreen(stageMetrics().W / 2);
  const oldSigma = S.track ? S.track.sigma : 0;
  S.track = E.computeTrack(sess, S.dev, { causal: live });
  if (!live || S.track.sigma !== oldSigma) S.version++;
  if (S.view.mode === 'fit') S.view.z = fitZ();
  if (keepFrame >= 0) centerOnFrame(keepFrame);
  clampView();
  markAll();
  updateFacts();
}

/* ---------------------------------------------------------- recording */
function startRecording() {
  if (!S.source) return false;
  const g = makeGeom(S.source, S.src);
  if (!S.cap || S.cap.src !== S.source) S.cap = new Capture(S.source, g);
  else S.cap.setGeom(g);
  const sess = newSession(S.mode, S.source, g);
  S.cap.start(sess);
  S.view.follow = true;
  S.view.mode = 'fit';
  S.view.z = fitZ();
  $('btnFollow').hidden = true;
  return true;
}

const MEM_CAP = (SMALL() ? 320 : 900) * 1e6;
function onRecordedFrame() {
  const sess = S.sess;
  if (!sess || sess.frames.length < 2) return;
  if (sess.store.bytes > MEM_CAP) {
    const at = fmtTime(sess.frames[sess.frames.length - 1].t);
    stopScan();
    toast(`Stopped at ${at}: the strip has filled the memory this page can use. Lower the output height to scan longer.`, true);
    return;
  }
  if (!sess.sigmaLocked && S.dev.direction === 'auto') {
    const d = E.detectDirection(sess.frames);
    if (d.strength > 40 && d.agreement > 0.6) { sess.sigma = d.sigma; sess.sigmaLocked = true; }
  }
  retrack(false);
  if (S.view.follow) followHead();
  S.dirty.graph = S.dirty.stage = true;
  if (sess.frames.length % 6 === 0) S.dirty.overview = true;
}

function finishRecording(msg) {
  const sess = S.sess;
  if (S.cap) S.cap.stop();
  if (sess) sess.done = true;
  S.scanning = null;
  wake(false);
  setBusy(null);
  if (sess && sess.frames.length < 3) {
    toast(sess.kind === 'live' ? 'No camera frames arrived during the scan. Keep the app in front with the camera picture moving, then scan again.' : 'Too short to build a strip. Scan for a few seconds.', true);
  }
  retrack(false);
  S.view.follow = false;
  if (S.track) { S.view.mode = 'fit'; S.view.z = fitZ(); centerOnFrame(Math.round((S.track.fi + S.track.fo) / 2)); }
  $('btnFollow').hidden = true;
  syncDevUI();
  updateScanUI();
  updateExportAvail();
  if (msg && sess && sess.frames.length >= 3) toast(msg);
}

/* ------------------------------------------------------------- sources */
let ride = null;
function demoSource() {
  if (!ride) ride = SMALL() ? new FBDemo.DemoRide(1280, 720) : new FBDemo.DemoRide(1600, 900);
  return { kind: 'demo', el: ride.canvas, w: ride.w, h: ride.h, label: 'Demo ride' };
}

function setSource(src) {
  S.source = src;
  S.cap = src ? new Capture(src, makeGeom(src, S.src)) : null;
  $('srcName').textContent = src ? src.label : '—';
  $('srcRo').textContent = src ? `${src.w}×${src.h}` : '';
  updateOutH();
  updateScanUI();
}

function applySrcChange() {
  prefs.set('src', S.src);
  if (S.source && S.cap && !S.cap.rec) S.cap.setGeom(makeGeom(S.source, S.src));
  updateOutH();
  updateScanUI();
}

/* demo: real-time scan driven by the frame loop; fast scan at start-up */
async function fastDemoScan() {
  if (S.scanning) return;
  S.scanning = 'demo-fast';
  setSource(demoSource());
  S.cap.resetMotion();
  startRecording();
  updateScanUI();
  const N = Math.floor(ride.duration * ride.fps);
  setBusy('Developing the demo ride', 0, () => { S.scanning = 'demo-stop'; });
  for (let i = 0; i < N; i++) {
    if (S.scanning !== 'demo-fast') break;
    ride.render(i / ride.fps);
    S.cap.frame(i / ride.fps, NaN);
    onRecordedFrame();
    if (i % 3 === 2) { setBusy('Developing the demo ride', i / N); await nextFrame(); }
  }
  finishRecording('Demo ride developed');
  S.demoT0 = performance.now(); S.demoFi = -1;
  if (S.cap) S.cap.resetMotion();
  if (S.sess && S.track) {
    // open on the station stop, the most legible part of the ride
    const F = S.sess.frames;
    let j = 0;
    while (j < F.length - 1 && F[j].t < 8.6) j++;
    centerOnFrame(j);
  }
}

function demoTick(now) {
  if (S.mode !== 'demo' || !ride || !S.source || S.source.kind !== 'demo' || S.scanning === 'demo-fast') return;
  let t = (now - S.demoT0) / 1000;
  if (S.scanning === 'demo') {
    if (t >= ride.duration) { finishRecording('Scan developed'); S.demoT0 = now; return; }
  } else if (t >= ride.duration) {
    S.demoT0 = now; t = 0; S.cap.resetMotion();
  }
  const fi = Math.floor(t * ride.fps);
  if (fi === S.demoFi) return;
  S.demoFi = fi;
  ride.render(fi / ride.fps);
  S.cap.frame(fi / ride.fps, NaN);
  if (S.scanning === 'demo') { onRecordedFrame(); updateScanUI(); }
}

/* camera */
let camStream = null, camRecorder = null, camChunks = [], camLoopOn = false;
const vidCam = () => $('vidCam');
async function startCamera() {
  if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) return camError('unsupported');
  stopCamera();
  const id = $('cCam').value;
  const v = { width: { ideal: 1920 }, height: { ideal: 1080 }, frameRate: { ideal: 60 } };
  if (id) v.deviceId = { exact: id }; else v.facingMode = { ideal: 'environment' };
  monNote('<strong>Opening camera</strong>');
  try {
    camStream = await navigator.mediaDevices.getUserMedia({ video: v, audio: false });
  } catch (err) {
    return camError(err && err.name);
  }
  const vid = vidCam();
  vid.srcObject = camStream;
  try { await vid.play(); } catch (e) { /* autoplay with muted should work */ }
  await waitFor(() => vid.videoWidth > 0, 5000);
  if (!vid.videoWidth) return camError('nodata');
  const track = camStream.getVideoTracks()[0];
  setSource({ kind: 'camera', el: vid, w: vid.videoWidth, h: vid.videoHeight, label: (track && track.label) || 'Camera' });
  monNote(null);
  listCameras();
  camLoop();
}
function stopCamera() {
  camLoopOn = false;
  if (camStream) for (const t of camStream.getTracks()) t.stop();
  camStream = null;
  const vid = vidCam();
  vid.srcObject = null;
}
async function listCameras() {
  try {
    const devs = (await navigator.mediaDevices.enumerateDevices()).filter((d) => d.kind === 'videoinput');
    const sel = $('cCam'), cur = camStream && camStream.getVideoTracks()[0];
    const curId = cur && cur.getSettings ? cur.getSettings().deviceId : '';
    sel.innerHTML = '';
    devs.forEach((d, i) => {
      const o = document.createElement('option');
      o.value = d.deviceId; o.textContent = d.label || `Camera ${i + 1}`;
      if (d.deviceId === curId) o.selected = true;
      sel.appendChild(o);
    });
  } catch (e) { /* keep default option */ }
}
/* Camera frames. Safari doesn't give reliable frame timestamps for a live
   camera and may not fire requestVideoFrameCallback at all, so frames are
   timed by the wall clock, duplicates are dropped by content, and a polling
   loop takes over whenever the callback goes quiet. */
function camLoop() {
  const vid = vidCam();
  camLoopOn = true;
  const hasRVFC = 'requestVideoFrameCallback' in HTMLVideoElement.prototype;
  const started = performance.now();
  let lastCb = 0, lastPoll = 0, polling = !hasRVFC;
  S.lastCamFrame = 0;
  const process = () => {
    if (!S.source || S.source.el !== vid || !S.cap || vid.readyState < 2 || !vid.videoWidth) return;
    if (vid.videoWidth !== S.source.w || vid.videoHeight !== S.source.h) {
      if (S.scanning === 'live') { stopLive(); toast('Scan stopped: the camera changed orientation.', true); }
      setSource({ kind: 'camera', el: vid, w: vid.videoWidth, h: vid.videoHeight, label: S.source.label });
    }
    if (!S.cap.frame(performance.now() / 1000, gpsNow(), true)) return;
    S.lastCamFrame = performance.now();
    if (S.scanning === 'live') { onRecordedFrame(); updateScanUI(); }
    else if (S.monHidden) S.dirty.stage = true;
  };
  const onVF = () => {
    if (!camLoopOn || !S.source || S.source.el !== vid) return;
    lastCb = performance.now();
    if (!polling) process();
    vid.requestVideoFrameCallback(onVF);
  };
  if (hasRVFC) vid.requestVideoFrameCallback(onVF);
  const poll = (now) => {
    if (!camLoopOn || !S.source || S.source.el !== vid) return;
    if (!polling && now - Math.max(lastCb, started) > 400) polling = true;
    if (polling && now - lastPoll > 14) { lastPoll = now; process(); }
    if (vid.paused && camStream) vid.play().catch(() => {});
    requestAnimationFrame(poll);
  };
  requestAnimationFrame(poll);
}
function camError(name) {
  stopCamera();
  setSource(null);
  const rec = TOUCH ? '<button type="button" class="btn primary" data-act="record">Record a clip</button>' : '';
  if (IN_VIEWER && (name === 'NotAllowedError' || name === 'SecurityError' || name === 'unsupported')) {
    monNote(`<strong>No live camera in this view</strong><p>This page can't open the camera here. Film the window with your camera app and open the clip, or run the standalone file from your own site to scan live.</p><div class="row">${rec}<button type="button" class="btn${rec ? '' : ' primary'}" data-act="open">Open a clip</button></div>`);
  } else if (name === 'NotAllowedError') {
    monNote('<strong>Camera blocked</strong><p>Camera access was refused. Allow it for this site in the browser settings, then try again.</p><div class="row"><button type="button" class="btn primary" data-act="cam">Try again</button></div>');
  } else if (name === 'NotFoundError' || name === 'OverconstrainedError') {
    monNote(`<strong>No camera found</strong><p>This device has no camera that can be opened. Open a clip instead.</p><div class="row"><button type="button" class="btn primary" data-act="open">Open a clip</button></div>`);
  } else if (name === 'NotReadableError') {
    monNote('<strong>Camera busy</strong><p>Another app is using the camera. Close it, then try again.</p><div class="row"><button type="button" class="btn primary" data-act="cam">Try again</button></div>');
  } else {
    monNote(`<strong>Camera unavailable</strong><p>The camera could not be started here. Open a clip instead.</p><div class="row">${rec}<button type="button" class="btn" data-act="open">Open a clip</button></div>`);
  }
  updateScanUI();
}

function startLive() {
  if (!S.source || S.source.kind !== 'camera') return;
  S.cap.resetMotion();
  startRecording();
  S.scanning = 'live';
  wake(true);
  if (S.src.gps) startGPS();
  camChunks = [];
  camRecorder = null;
  if (S.src.keep && window.MediaRecorder && camStream) {
    const types = ['video/mp4;codecs=avc1', 'video/mp4', 'video/webm;codecs=vp9', 'video/webm'];
    const type = types.find((t) => MediaRecorder.isTypeSupported && MediaRecorder.isTypeSupported(t));
    try {
      camRecorder = new MediaRecorder(camStream, type ? { mimeType: type, videoBitsPerSecond: 10e6 } : undefined);
      camRecorder.ondataavailable = (ev) => { if (ev.data && ev.data.size) camChunks.push(ev.data); };
      camRecorder.start(1000);
    } catch (e) { camRecorder = null; }
  }
  updateScanUI();
}
function stopLive() {
  const sess = S.sess;
  const rec = camRecorder;
  camRecorder = null;
  if (rec && rec.state !== 'inactive') {
    rec.onstop = () => {
      const type = rec.mimeType || (camChunks[0] && camChunks[0].type) || 'video/webm';
      if (sess && camChunks.length) sess.clip = new Blob(camChunks, { type });
      camChunks = [];
      updateExportAvail();
      updateScanUI();
    };
    rec.stop();
  }
  finishRecording('Scan developed');
}

/* GPS */
const gps = { watch: null, speed: NaN, at: 0, last: null };
function startGPS() {
  if (gps.watch != null || !navigator.geolocation) return;
  try {
    gps.watch = navigator.geolocation.watchPosition((pos) => {
      let sp = pos.coords.speed;
      if ((sp == null || !Number.isFinite(sp)) && gps.last) {
        const a = gps.last.coords, b = pos.coords, R = 6371000, rad = Math.PI / 180;
        const dLat = (b.latitude - a.latitude) * rad, dLon = (b.longitude - a.longitude) * rad;
        const h = Math.sin(dLat / 2) ** 2 + Math.cos(a.latitude * rad) * Math.cos(b.latitude * rad) * Math.sin(dLon / 2) ** 2;
        const dt = (pos.timestamp - gps.last.timestamp) / 1000;
        if (dt > 0.2) sp = 2 * R * Math.asin(Math.sqrt(h)) / dt;
      }
      if (sp != null && Number.isFinite(sp)) { gps.speed = sp; gps.at = performance.now(); }
      gps.last = pos;
    }, (err) => {
      // tunnels and weak signal (codes 2, 3) are normal on a train: keep listening
      if (err && err.code !== 1) return;
      stopGPS();
      S.src.gps = false; $('cGps').checked = false; prefs.set('src', S.src);
      toast(IN_VIEWER ? 'Location isn\'t available in this view.' : 'Location was refused, so GPS speed is off.', true);
    }, { enableHighAccuracy: true, maximumAge: 1000, timeout: 20000 });
  } catch (e) { gps.watch = null; }
}
function stopGPS() { if (gps.watch != null && navigator.geolocation) navigator.geolocation.clearWatch(gps.watch); gps.watch = null; }
function gpsNow() { return gps.watch != null && performance.now() - gps.at < 4000 ? gps.speed : NaN; }

let wakeLock = null;
async function wake(on) {
  try {
    if (on && !wakeLock && navigator.wakeLock) wakeLock = await navigator.wakeLock.request('screen');
    if (!on && wakeLock) { await wakeLock.release(); wakeLock = null; }
  } catch (e) { wakeLock = null; }
}

/* clip */
const vidClip = () => $('vidClip');
async function loadClip(file) {
  if (!file) return;
  if (S.scanning) { toast('Stop the current scan first.', true); return; }
  if (S.mode !== 'clip') setMode('clip');
  const vid = vidClip();
  if (S.clip && S.clip.url) URL.revokeObjectURL(S.clip.url);
  const url = URL.createObjectURL(file);
  S.clip = { file, url, name: file.name || 'Recording', duration: 0, ready: false };
  $('clipName').textContent = S.clip.name;
  monNote('<strong>Opening clip</strong>');
  vid.src = url;
  vid.load();
  const ok = await Promise.race([once(vid, 'loadeddata', 15000), once(vid, 'error', 15000).then(() => false)]);
  if (!ok || !vid.videoWidth) {
    S.clip.ready = false;
    setSource(null);
    monNote(`<strong>Can't play this file</strong><p>This browser can't decode ${escapeHTML(S.clip.name)}. HEVC clips from iPhones play in Safari; elsewhere export the clip as H.264 MP4.</p><div class="row"><button type="button" class="btn primary" data-act="open">Open another clip</button></div>`);
    return;
  }
  S.clip.duration = vid.duration;
  S.clip.ready = true;
  vid.currentTime = Math.min(0.05, vid.duration / 2);
  await once(vid, 'seeked', 3000);
  $('cClipPos').value = 0; paintRange($('cClipPos'));
  $('oClipPos').textContent = fmtTime(0) + ' / ' + fmtTime(vid.duration);
  setSource({ kind: 'clip', el: vid, w: vid.videoWidth, h: vid.videoHeight, label: S.clip.name });
  monNote(null);
}
function escapeHTML(s) { return String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c])); }

async function scanClip() {
  const vid = vidClip();
  if (!S.clip || !S.clip.ready || !S.source) return;
  S.scanning = 'clip';
  vid.pause();
  vid.currentTime = 0;
  await once(vid, 'seeked', 4000);
  S.cap.resetMotion();
  startRecording();
  updateScanUI();
  const has = 'requestVideoFrameCallback' in HTMLVideoElement.prototype;
  let rate = 1, lastMT = -1, lastPF = -1, win = 0, winDrop = 0, procMs = 0;
  vid.playbackRate = rate;
  setBusy('Scanning clip', 0, () => stopClipScan(true));
  const done = new Promise((resolve) => {
    const finish = () => { vid.removeEventListener('ended', finish); resolve(); };
    vid.addEventListener('ended', finish);
    S.clipStop = finish;
    const cb = (now, meta) => {
      if (S.scanning !== 'clip') return;
      const mt = meta ? meta.mediaTime : vid.currentTime;
      if (mt !== lastMT) {
        if (meta && lastPF >= 0 && meta.presentedFrames - lastPF > 1) winDrop += meta.presentedFrames - lastPF - 1;
        lastPF = meta ? meta.presentedFrames : -1;
        lastMT = mt;
        const t0 = performance.now();
        S.cap.frame(mt, NaN);
        onRecordedFrame();
        if (S.scanning !== 'clip') return;
        procMs = procMs * 0.9 + (performance.now() - t0) * 0.1;
        win++;
        if (win >= 40) {
          const ratio = winDrop / (win + winDrop);
          if (ratio > 0.04) rate = Math.max(0.2, rate * 0.7);
          else if (winDrop === 0 && rate < 1) rate = Math.min(1, rate * 1.2);
          vid.playbackRate = rate;
          win = 0; winDrop = 0;
        }
        const pct = vid.duration ? mt / vid.duration : 0;
        setBusy(`Scanning clip · ${Math.round(pct * 100)} % · ${rate.toFixed(rate < 1 ? 2 : 0)}× speed`, pct);
        updateScanUI();
      }
      if (!vid.ended) schedule();
    };
    // if the frame callback goes quiet (some Safari builds), poll currentTime instead
    let lastCb = performance.now();
    const cbWrap = (n, meta) => { lastCb = performance.now(); cb(n, meta); };
    const schedule = () => (has && !S.clipPoll ? vid.requestVideoFrameCallback(cbWrap) : requestAnimationFrame((n) => cb(n, null)));
    S.clipPoll = false;
    const watch = () => {
      if (S.scanning !== 'clip' || vid.ended) return;
      if (has && !S.clipPoll && !vid.paused && performance.now() - lastCb > 700) { S.clipPoll = true; schedule(); }
      setTimeout(watch, 250);
    };
    schedule();
    setTimeout(watch, 1000);
  });
  try { await vid.play(); } catch (e) { toast('The clip could not be played.', true); }
  await done;
  if (S.scanning === 'clip') finishRecording('Clip developed');
  vid.pause();
}
function stopClipScan(keep) {
  if (S.scanning !== 'clip') return;
  vidClip().pause();
  finishRecording(keep ? 'Scan stopped, partial strip kept' : null);
  if (S.clipStop) S.clipStop();
}

/* ---------------------------------------------------------------- modes */
function setMode(m) {
  if (m === S.mode && S.source) return;
  if (S.scanning) stopScan();
  if (S.mode === 'live' && m !== 'live') { stopCamera(); stopGPS(); }
  if (S.mode === 'clip' && m !== 'clip') vidClip().pause();
  S.mode = m;
  for (const b of document.querySelectorAll('.modes button')) b.setAttribute('aria-checked', String(b.dataset.mode === m));
  for (const el of document.querySelectorAll('#sourceCtl [data-for]')) el.hidden = el.dataset.for !== m;
  monNote(null);
  if (m === 'demo') {
    setSource(demoSource());
    S.demoT0 = performance.now(); S.demoFi = -1;
  } else if (m === 'live') {
    setSource(null);
    monNote(`<strong>Live camera</strong><p>Hold the phone flat against the glass, rear camera facing out. Landscape gives the tallest strip. Lock exposure if your camera allows it.</p><div class="row"><button type="button" class="btn primary" data-act="cam">Start camera</button></div>`);
  } else if (m === 'clip') {
    if (S.clip && S.clip.ready) {
      setSource({ kind: 'clip', el: vidClip(), w: vidClip().videoWidth, h: vidClip().videoHeight, label: S.clip.name });
    } else {
      setSource(null);
      const rec = TOUCH ? '<button type="button" class="btn" data-act="record">Record</button>' : '';
      monNote(`<strong>Open a clip</strong><p>Any video filmed out of a moving window. Drop it here or choose a file. Steady footage at 60 fps works best.</p><div class="row"><button type="button" class="btn primary" data-act="open">Open clip…</button>${rec}</div>`);
    }
  }
  updateScanUI();
}

function toggleScan() {
  if (S.scanning) return stopScan();
  if (S.mode === 'demo') {
    if (!S.source) setSource(demoSource());
    S.cap.resetMotion();
    S.demoT0 = performance.now(); S.demoFi = -1;
    startRecording();
    S.scanning = 'demo';
    updateScanUI();
  } else if (S.mode === 'live') {
    if (!S.source) return startCamera();
    startLive();
  } else if (S.mode === 'clip') {
    if (!S.clip || !S.clip.ready) return $('fileIn').click();
    scanClip();
  }
}
function stopScan() {
  if (S.scanning === 'demo') { finishRecording('Scan developed'); S.demoT0 = performance.now(); }
  else if (S.scanning === 'demo-fast') S.scanning = 'demo-stop';
  else if (S.scanning === 'live') stopLive();
  else if (S.scanning === 'clip') stopClipScan(true);
}

function updateScanUI() {
  const btn = $('btnScan'), hint = $('scanHint');
  const on = !!S.scanning;
  btn.dataset.state = on ? 'on' : 'off';
  let label = 'Scan', h = '';
  const sess = S.sess, n = sess ? sess.frames.length : 0;
  const stale = sess && sess.done && S.source && sess.kind === S.mode && geomKey(makeGeom(S.source, S.src)) !== sess.gk;
  if (on) {
    label = 'Stop';
    const dur = n ? sess.frames[n - 1].t : 0;
    h = S.scanning === 'clip' ? `<b>Scanning</b> · ${fmtInt(n)} frames` : `<b>Scanning</b> · ${fmtTime(dur)} · ${fmtInt(n)} frames`;
  } else if (S.mode === 'demo') {
    h = stale ? '<b>Slit or crop changed.</b> Scan again to apply it.' : 'Rides the 16 s demo in real time and builds the strip as it goes.';
  } else if (S.mode === 'live') {
    if (!S.source) { label = 'Start'; h = 'Start the camera, then scan.'; }
    else h = stale ? '<b>Settings changed.</b> They apply to the next scan.' : 'Press scan as the train moves. Stop whenever you like.';
    if (sess && sess.done && sess.clip && sess.kind === 'live') h += ' <button type="button" class="link" data-act="rescan-rec">Re-scan the recording</button>';
  } else if (S.mode === 'clip') {
    if (!S.clip || !S.clip.ready) { label = 'Open'; h = 'Open a clip filmed from a moving window.'; }
    else { label = 'Scan clip'; h = stale ? '<b>Slit or crop changed.</b> Scan the clip again to apply it.' : 'Plays the clip through once and builds the strip.'; }
  }
  $('scanLabel').textContent = label;
  $('fabLabel').textContent = label === 'Scan clip' ? 'Scan' : label;
  $('btnFab').dataset.state = btn.dataset.state;
  $('btnFab').disabled = S.scanning === 'demo-fast';
  hint.innerHTML = h;
  btn.disabled = S.scanning === 'demo-fast';
  for (const el of document.querySelectorAll('#sourceCtl input, #sourceCtl select, #sourceCtl .seg button, #btnOpen')) el.disabled = on;
  for (const b of document.querySelectorAll('.modes button')) b.disabled = S.scanning === 'demo-fast';
  updateExportAvail();
}

/* ---------------------------------------------------------------- busy */
let busyCancel = null;
function setBusy(text, frac, cancel) {
  const el = $('busy');
  if (text == null) { el.hidden = true; busyCancel = null; return; }
  el.hidden = false;
  $('busyText').textContent = text;
  if (frac != null) $('busyBar').style.width = (clamp(frac, 0, 1) * 100).toFixed(1) + '%';
  if (cancel) busyCancel = cancel;
}

/* --------------------------------------------------------------- view */
let panoCv, panoCtx, ovCv, ovCtx, graphCv, graphCtx, monCv, monCtx;
function stageMetrics() {
  const dpr = DPR(), rulerH = Math.round(24 * dpr);
  return { W: panoCv.width, H: panoCv.height, ph: panoCv.height - rulerH, rulerH, dpr };
}
function outW() { return S.track ? Math.floor(S.track.L * S.dev.stretch) : 0; }
function fitZ() { if (!S.sess) return 0.5; return Math.max(1e-3, stageMetrics().ph / S.sess.geom.OH); }
function allZ() { const w = outW(); return w > 0 ? stageMetrics().W / w : fitZ(); }
function zoomTo(mode, anchorPx) {
  if (!S.track) return;
  const m = stageMetrics();
  const ax = anchorPx == null ? m.W / 2 : anchorPx;
  const D = S.view.x + ax / S.view.z;
  let z;
  if (mode === 'fit') { z = fitZ(); S.view.mode = 'fit'; }
  else if (mode === '1') { z = 1; S.view.mode = 'free'; }
  else if (mode === 'all') { z = Math.min(fitZ(), allZ()); S.view.mode = 'free'; }
  else { z = mode; S.view.mode = 'free'; }
  setZoom(z, ax, D);
}
function setZoom(z, ax, D) {
  const zmin = Math.min(fitZ(), allZ()) * 0.9, zmax = 8;
  S.view.z = clamp(z, Math.min(zmin, zmax), zmax);
  if (Math.abs(S.view.z - fitZ()) < 1e-4) S.view.mode = 'fit';
  S.view.x = D - ax / S.view.z;
  clampView();
  S.dirty.stage = S.dirty.overview = S.dirty.graph = true;
}
function clampView() {
  const w = outW();
  if (!w) return;
  const span = stageMetrics().W / S.view.z;
  if (w <= span) S.view.x = clamp(S.view.x, w - span, 0);
  else S.view.x = clamp(S.view.x, -span * 0.35, w - span * 0.65);
  const m = stageMetrics(), hpx = S.sess.geom.OH * S.view.z;
  S.view.y = hpx <= m.ph ? 0 : clamp(S.view.y, 0, hpx - m.ph);
}
function followHead() {
  const w = outW(), span = stageMetrics().W / S.view.z;
  if (!S.track) return;
  S.view.x = S.track.sigma < 0 ? -span * 0.12 : w - span * 0.88;
  if (w < span * 0.88 && S.track.sigma > 0) S.view.x = Math.min(0, S.view.x);
}
// display position (output px) of a frame's slit, and back
function frameToD(j) {
  const tr = S.track;
  const c = (tr.P[clamp(j, tr.fi, tr.fo)] - tr.P[tr.fi]) * S.dev.stretch;
  return tr.sigma < 0 ? outW() - c : c;
}
function DToFrame(D) {
  const tr = S.track, w = outW();
  const c = tr.sigma < 0 ? w - D : D;
  return E.findFrame(tr.P, tr.fi, tr.fo, tr.P[tr.fi] + c / S.dev.stretch);
}
function frameAtScreen(px) { if (!S.track) return -1; return DToFrame(S.view.x + px / S.view.z); }
function centerOnFrame(j) {
  if (!S.track) return;
  S.view.x = frameToD(j) - stageMetrics().W / S.view.z / 2;
  clampView();
  S.dirty.stage = S.dirty.overview = S.dirty.graph = true;
}

function drawStage() {
  const ctx = panoCtx, m = stageMetrics(), W = m.W, H = m.H;
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.fillStyle = C.stage;
  ctx.fillRect(0, 0, W, H);
  const tr = S.track, sess = S.sess;
  const empty = !sess || !tr || tr.L < 1;
  $('stageEmpty').hidden = !empty || !!S.scanning;
  if (empty && sess && sess.done && sess.frames.length > 2) {
    $('stageEmpty').firstElementChild.textContent = 'Nothing moved forward';
    $('stageEmpty').lastElementChild.textContent = S.dev.direction !== 'auto'
      ? 'The scenery seems to move the other way. Set Scenery moves to Auto.'
      : 'The camera saw no steady sideways motion in this take. Try Fixed speed, or scan while the train is moving.';
  } else if (empty) {
    $('stageEmpty').firstElementChild.textContent = 'Nothing scanned yet';
    $('stageEmpty').lastElementChild.textContent = 'Point the camera out of a train window and press Scan, or open a clip you filmed.';
  }
  if (empty) { $('zoomRo').textContent = '—'; return; }
  const OH = sess.geom.OH, z = S.view.z, k = S.dev.stretch;
  const pt = proxyTier();
  const tier = z / 1 > 0.5 * 1.02 ? 1 : z > pt * 1.08 ? 0.5 : pt;
  const WT = Math.floor(tr.L * k * tier);
  const mirror = tr.sigma < 0;
  const hpx = OH * z;
  const top = hpx <= m.ph ? Math.round((m.ph - hpx) / 2) : -Math.round(S.view.y);
  const span = W / z;
  const D0 = S.view.x, D1 = D0 + span;
  const WoutT = WT / tier;
  const cA = mirror ? WoutT - D1 : D0, cB = mirror ? WoutT - D0 : D1;
  const nT = Math.ceil(WT / TILE);
  const iA = Math.max(0, Math.floor(cA * tier / TILE)), iB = Math.min(nT - 1, Math.floor(cB * tier / TILE));
  const want = [];
  const center = (cA + cB) / 2 * tier / TILE;
  ctx.imageSmoothingEnabled = z / tier < 1.6;
  ctx.imageSmoothingQuality = 'high';
  const yA = top, yB = Math.round(top + hpx);
  for (let i = iA; i <= iB; i++) {
    const DtL = mirror ? WT - (i + 1) * TILE : i * TILE;
    const xa = Math.round((DtL / tier - D0) * z), xb = Math.round(((DtL + TILE) / tier - D0) * z);
    const e = tiles.entry(tier, i, Math.max(1, Math.round(OH * tier)));
    e.hold = S.frameNo;
    const ready = e.ver === S.version && e.valid > 0;
    if (!ready && tier !== pt) {
      // low-res stand-in while the full tile renders
      const pti = Math.floor(i * TILE / tier * pt / TILE);
      const pe = tiles.entry(pt, pti, PROXY_H);
      pe.hold = S.frameNo;
      if (pe.ver === S.version && pe.valid > 0) {
        const pWT = Math.floor(tr.L * k * pt);
        const pDtL = mirror ? pWT - (pti + 1) * TILE : pti * TILE;
        const pxa = Math.round((pDtL / pt - D0) * z), pxb = Math.round(((pDtL + TILE) / pt - D0) * z);
        ctx.save();
        ctx.beginPath(); ctx.rect(xa, yA, xb - xa, yB - yA); ctx.clip();
        ctx.imageSmoothingEnabled = true;
        ctx.drawImage(pe.cv, 0, 0, TILE, pe.h, pxa, yA, pxb - pxa, yB - yA);
        ctx.restore();
      }
      if (tiles.needs(pe)) want.unshift(pe);
    }
    if (ready) ctx.drawImage(e.cv, 0, 0, TILE, e.h, xa, yA, xb - xa, yB - yA);
    if (tiles.needs(e)) want.push(Object.assign(e, { prio: Math.abs(i + 0.5 - center) }));
  }
  want.sort((a, b) => (a.tier === pt ? -1 : 0) - (b.tier === pt ? -1 : 0) || (a.prio || 0) - (b.prio || 0));
  S.want = want;

  // scan head while recording
  if (S.scanning && S.cap && S.cap.rec) {
    const Dh = mirror ? 0 : outW();
    const x = Math.round((Dh - D0) * z);
    ctx.fillStyle = C.signal;
    ctx.shadowColor = C.signal; ctx.shadowBlur = 12 * m.dpr;
    ctx.fillRect(x - Math.round(m.dpr), yA, Math.max(2, Math.round(2 * m.dpr)), yB - yA);
    ctx.shadowBlur = 0;
  }
  // hover line
  if (S.hoverFrame >= 0 && S.hoverFrame <= tr.fo && S.hoverFrame >= tr.fi) {
    const x = Math.round((frameToD(S.hoverFrame) - D0) * z) + 0.5;
    ctx.strokeStyle = 'rgba(255,255,255,0.75)';
    ctx.lineWidth = m.dpr;
    ctx.setLineDash([4 * m.dpr, 4 * m.dpr]);
    ctx.beginPath(); ctx.moveTo(x, yA); ctx.lineTo(x, yB); ctx.stroke();
    ctx.setLineDash([]);
  }
  if (S.monHidden && S.source && (S.scanning || S.mode === 'live')) drawPip(ctx, m);
  drawRuler(ctx, m, D0, z);
  $('zoomRo').textContent = (S.view.mode === 'fit' ? 'fit · ' : '') + Math.round(z / m.dpr * 100) + ' %';
}

/* small source picture on the stage when the monitor is scrolled away */
function drawPip(ctx, m) {
  const src = S.source, d = m.dpr;
  const w = Math.min(220 * d, m.W * 0.34), h = w * src.h / src.w;
  const x = 10 * d, y = m.ph - h - 10 * d;
  ctx.save();
  ctx.fillStyle = '#000';
  ctx.fillRect(x - d, y - d, w + 2 * d, h + 2 * d);
  try { ctx.drawImage(src.el, x, y, w, h); } catch (e) { /* frame not ready */ }
  ctx.fillStyle = C.signal;
  ctx.fillRect(Math.round(x + S.src.slit * w - d), y + S.src.cropTop * h, Math.max(2, Math.round(2 * d)), (S.src.cropBot - S.src.cropTop) * h);
  ctx.restore();
}

/* edge print: seconds along the bottom, spaced by the train's real progress */
function drawRuler(ctx, m, D0, z) {
  const tr = S.track, F = S.sess.frames, dpr = m.dpr;
  const y0 = m.ph;
  ctx.fillStyle = C.sunk;
  ctx.fillRect(0, y0, m.W, m.rulerH);
  ctx.fillStyle = C.line;
  ctx.fillRect(0, y0, m.W, Math.max(1, Math.round(dpr)));
  const t0 = F[tr.fi].t, t1 = F[tr.fo].t;
  if (!(t1 > t0)) return;
  // choose minor step so ticks are not denser than 5 px on average
  const avgPx = (outW() * z) / (t1 - t0);
  const steps = [0.1, 0.2, 0.5, 1, 2, 5, 10, 30, 60];
  let minor = steps.find((s) => s * avgPx > 7 * dpr) || 60;
  let major = steps.find((s) => s >= minor * 5 && s * avgPx > 64 * dpr) || Math.max(60, minor * 5);
  if (major < 1 && avgPx * 1 > 64 * dpr) major = 1;
  ctx.font = `400 ${Math.round(10 * dpr)}px ${C.mono}`;
  ctx.textBaseline = 'top';
  let j = tr.fi, lastLabel = -1e9;
  const first = Math.ceil(t0 / minor) * minor;
  for (let s = first; s <= t1 + 1e-9; s += minor) {
    while (j < tr.fo - 1 && F[j + 1].t <= s) j++;
    const a = F[j + 1] ? clamp((s - F[j].t) / ((F[j + 1].t - F[j].t) || 1), 0, 1) : 0;
    const p = tr.P[j] + (tr.P[Math.min(j + 1, tr.fo)] - tr.P[j]) * a;
    let D = (p - tr.P[tr.fi]) * S.dev.stretch;
    if (tr.sigma < 0) D = outW() - D;
    const x = Math.round((D - D0) * z) + 0.5;
    if (x < -40 || x > m.W + 40) continue;
    const isMajor = Math.abs(s / major - Math.round(s / major)) < 1e-6;
    ctx.fillStyle = isMajor ? C['ink-2'] : C['line-strong'];
    ctx.fillRect(Math.floor(x), y0, Math.max(1, Math.round(dpr)), Math.round((isMajor ? 9 : 5) * dpr));
    if (isMajor && Math.abs(x - lastLabel) > 46 * dpr) {
      ctx.fillStyle = C['ink-2'];
      ctx.fillText(fmtTime(s, major < 1 ? 1 : 0), x + 4 * dpr, y0 + 8 * dpr);
      lastLabel = x;
    }
  }
}

function drawOverview() {
  const ctx = ovCtx, W = ovCv.width, H = ovCv.height, dpr = DPR();
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.fillStyle = C.sunk;
  ctx.fillRect(0, 0, W, H);
  const tr = S.track;
  if (!tr || !S.sess || tr.L < 1) return;
  const pt = proxyTier(), k = S.dev.stretch;
  const WT = Math.floor(tr.L * k * pt);
  if (WT < 1) return;
  const mirror = tr.sigma < 0;
  const sx = W / WT;
  const want = S.want || [];
  for (let i = 0, n = Math.ceil(WT / TILE); i < n; i++) {
    const e = tiles.entry(pt, i, PROXY_H);
    e.hold = S.frameNo;
    if (e.ver === S.version && e.valid > 0) {
      const DtL = mirror ? WT - (i + 1) * TILE : i * TILE;
      ctx.drawImage(e.cv, 0, 0, TILE, e.h, DtL * sx, 0, TILE * sx + 0.5, H);
    }
    if (tiles.needs(e) && !want.includes(e)) want.push(e);
  }
  S.want = want;
  // viewport
  const span = stageMetrics().W / S.view.z;
  const xa = clamp(S.view.x * pt * sx, -2, W), xb = clamp((S.view.x + span) * pt * sx, 0, W + 2);
  ctx.fillStyle = 'rgba(0,0,0,0.42)';
  ctx.fillRect(0, 0, Math.max(0, xa), H);
  ctx.fillRect(xb, 0, W - xb, H);
  ctx.strokeStyle = C.signal;
  ctx.lineWidth = Math.max(1, Math.round(1.5 * dpr));
  ctx.strokeRect(Math.round(xa) + 0.5, 0.5 * dpr, Math.max(2, Math.round(xb - xa)) - 1, H - dpr);
}

/* ------------------------------------------------------------- graph */
const G = { padL: 34, padR: 10, padT: 10, padB: 20 };
function graphX(j, W, n) { const d = DPR(); return G.padL * d + (n > 1 ? j / (n - 1) : 0) * (W - (G.padL + G.padR) * d); }
function graphJ(x, W, n) { const d = DPR(); return clamp(Math.round((x - G.padL * d) / (W - (G.padL + G.padR) * d) * (n - 1)), 0, n - 1); }
function drawGraph() {
  const ctx = graphCtx, W = graphCv.width, H = graphCv.height, d = DPR();
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.fillStyle = C.panel;
  ctx.fillRect(0, 0, W, H);
  const sess = S.sess, tr = S.track;
  const x0 = G.padL * d, x1 = W - G.padR * d, y0 = G.padT * d, y1 = H - G.padB * d;
  const mono = `${Math.round(10 * d)}px ${C.mono}`;
  ctx.font = mono;
  if (!sess || !tr || sess.frames.length < 2) {
    ctx.strokeStyle = C.line; ctx.lineWidth = d;
    ctx.strokeRect(x0 + 0.5, y0 + 0.5, x1 - x0, y1 - y0);
    ctx.fillStyle = C.muted; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    ctx.fillText('Motion appears here while you scan', (x0 + x1) / 2, (y0 + y1) / 2);
    ctx.textAlign = 'left';
    return;
  }
  const F = sess.frames, n = F.length, kOut = sess.geom.kOut, sg = tr.sigma;
  // scale
  let ymax = 4;
  const vals = [];
  for (let j = 0; j < n; j += Math.max(1, Math.floor(n / 600))) {
    const b = F[j].bands;
    if (b) for (let i = 0; i < NB; i++) if (b[i * 3 + 2] > 0.12) vals.push(-sg * b[i * 3] * kOut);
    vals.push(tr.u[j]);
  }
  vals.sort((a, b) => a - b);
  if (vals.length) ymax = Math.max(8, vals[Math.floor(vals.length * 0.99)] * 1.3);
  const ylo = 0.5, L0 = Math.log(ylo), L1 = Math.log(ymax);
  const Y = (v) => y1 - clamp((Math.log(Math.max(v, ylo)) - L0) / (L1 - L0), 0, 1) * (y1 - y0);
  // grid
  ctx.textBaseline = 'middle'; ctx.textAlign = 'right';
  for (const v of [1, 2, 5, 10, 20, 50, 100, 200, 500, 1000]) {
    if (v > ymax) break;
    const y = Math.round(Y(v)) + 0.5;
    ctx.fillStyle = C.line; ctx.fillRect(x0, Math.floor(y), x1 - x0, Math.max(1, Math.round(d * 0.75)));
    ctx.fillStyle = C.muted; ctx.fillText(String(v), x0 - 6 * d, y);
  }
  ctx.textAlign = 'left';
  // trim shade
  const xi = graphX(tr.fi, W, n), xo = graphX(tr.fo, W, n);
  ctx.fillStyle = C.sunk;
  ctx.fillRect(x0, y0, xi - x0, y1 - y0);
  ctx.fillRect(xo, y0, x1 - xo, y1 - y0);
  // visible range
  if (S.track) {
    const m = stageMetrics();
    let ja = frameAtScreen(0), jb = frameAtScreen(m.W);
    if (ja > jb) [ja, jb] = [jb, ja];
    const xa = graphX(ja, W, n), xb = graphX(jb, W, n);
    ctx.fillStyle = C.signal;
    ctx.globalAlpha = 0.12;
    ctx.fillRect(xa, y0, Math.max(2 * d, xb - xa), y1 - y0);
    ctx.globalAlpha = 1;
    ctx.fillRect(xa, y1 + 2 * d, Math.max(2 * d, xb - xa), 2 * d);
  }
  // band points (bucketed per pixel column)
  const cols = Math.max(1, Math.floor(x1 - x0));
  const per = n / cols;
  const lock = S.dev.lockBand;
  for (let b = 0; b < NB; b++) {
    ctx.fillStyle = b === lock ? C.signal : C.data;
    for (let c = 0; c < cols; c += per < 1 ? Math.ceil(1 / per) : 1) {
      const ja = Math.floor(c * per), jb = Math.max(ja + 1, Math.floor((c + 1) * per));
      let s = 0, w = 0;
      for (let j = ja; j < jb && j < n; j++) {
        const bd = F[j].bands;
        if (!bd) continue;
        const cf = bd[b * 3 + 2];
        if (cf < 0.12) continue;
        s += -sg * bd[b * 3] * kOut * cf; w += cf;
      }
      if (w <= 0) continue;
      ctx.globalAlpha = clamp(w / (jb - ja), 0.15, 1) * (b === lock ? 1 : 0.55);
      const y = Y(s / w);
      ctx.fillRect(x0 + c, y - d, Math.max(1.5 * d, 1), 2 * d);
    }
  }
  ctx.globalAlpha = 1;
  // no-measurement marks
  ctx.fillStyle = C.rec;
  for (let c = 0; c < cols; c++) {
    const ja = Math.floor(c * per), jb = Math.max(ja + 1, Math.floor((c + 1) * per));
    let any = false;
    for (let j = ja; j < jb && j < n; j++) if (tr.valid[j]) { any = true; break; }
    if (!any && ja < n - 1 && S.dev.source === 'motion') ctx.fillRect(x0 + c, y1 - 3 * d, 1, 3 * d);
  }
  // chosen speed
  ctx.strokeStyle = C.ink;
  ctx.lineWidth = 1.6 * d;
  ctx.lineJoin = 'round';
  ctx.beginPath();
  for (let c = 0; c < cols; c++) {
    const ja = Math.floor(c * per), jb = Math.min(n - 1, Math.max(ja + 1, Math.floor((c + 1) * per)));
    let s = 0, cnt = 0;
    for (let j = ja; j < jb; j++) { s += tr.u[j]; cnt++; }
    if (!cnt) continue;
    const y = Y(s / cnt);
    if (c === 0) ctx.moveTo(x0 + c, y); else ctx.lineTo(x0 + c, y);
  }
  ctx.stroke();
  // trim handles
  for (const x of [xi, xo]) {
    ctx.fillStyle = C.ink;
    ctx.fillRect(Math.round(x) - d, y0, 2 * d, y1 - y0);
    ctx.fillRect(Math.round(x) - 4 * d, y0, 8 * d, 10 * d);
  }
  // time axis
  ctx.fillStyle = C.muted; ctx.textBaseline = 'top';
  const T = F[n - 1].t;
  const ts = [1, 2, 5, 10, 15, 30, 60, 120, 300].find((s) => T / s <= 7) || 600;
  for (let s = 0; s <= T; s += ts) {
    let j = 0;
    while (j < n - 1 && F[j].t < s) j++;
    const x = graphX(j, W, n);
    ctx.fillText(fmtTime(s, 0), x + 2 * d, y1 + 6 * d);
  }
  // hover
  if (S.hoverFrame >= 0 && S.hoverFrame < n) {
    const x = Math.round(graphX(S.hoverFrame, W, n)) + 0.5;
    ctx.strokeStyle = C['ink-2']; ctx.lineWidth = d;
    ctx.beginPath(); ctx.moveTo(x, y0); ctx.lineTo(x, y1); ctx.stroke();
    $('motionRo').textContent = `${fmtTime(F[S.hoverFrame].t)} · ${tr.u[S.hoverFrame].toFixed(1)} px/f`;
  } else {
    const j = Math.max(0, n - 2);
    $('motionRo').textContent = S.scanning ? `${tr.u[j].toFixed(1)} px/f` : `${fmtTime(F[tr.fo].t - F[tr.fi].t)} kept`;
  }
}

/* ------------------------------------------------------------ monitor */
function monRect() {
  const W = monCv.width, H = monCv.height, src = S.source;
  if (!src) return null;
  const ar = src.w / src.h;
  let w = W, h = W / ar;
  if (h > H) { h = H; w = H * ar; }
  return { x: (W - w) / 2, y: (H - h) / 2, w, h };
}
function chosenBand() {
  if (!S.cap || !S.cap.ok) return -1;
  if (S.dev.lockBand >= 0) return S.dev.lockBand;
  const b = S.cap.bands, sg = S.track ? S.track.sigma : 1;
  const vs = [], ws = [];
  for (let i = 0; i < NB; i++) if (b[i * 3 + 2] >= 0.12) { vs.push(-sg * b[i * 3]); ws.push(b[i * 3 + 2]); }
  if (!vs.length) return -1;
  const target = E.layerPick(Float32Array.from(vs), Float32Array.from(ws), vs.length, S.dev.depth);
  let best = -1, bd = Infinity;
  for (let i = 0; i < NB; i++) if (b[i * 3 + 2] >= 0.12) { const dd = Math.abs(-sg * b[i * 3] - target); if (dd < bd) { bd = dd; best = i; } }
  return best;
}
function drawMonitor() {
  const ctx = monCtx, W = monCv.width, H = monCv.height, d = DPR();
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.fillStyle = C.sunk;
  ctx.fillRect(0, 0, W, H);
  const r = monRect(), src = S.source;
  if (!r) return;
  try {
    ctx.save();
    ctx.beginPath(); ctx.rect(r.x, r.y, r.w, r.h); ctx.clip();
    ctx.fillStyle = '#000'; ctx.fillRect(r.x, r.y, r.w, r.h);
    const s = r.w / src.w;
    ctx.setTransform(s, 0, 0, s, r.x, r.y);
    const lv = S.src.level * Math.PI / 180;
    if (lv) { ctx.translate(src.w / 2, src.h / 2); ctx.rotate(lv); ctx.translate(-src.w / 2, -src.h / 2); }
    ctx.drawImage(src.el, 0, 0, src.w, src.h);
    ctx.restore();
  } catch (e) { ctx.restore(); }
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  const ct = r.y + S.src.cropTop * r.h, cb = r.y + S.src.cropBot * r.h;
  // crop
  ctx.fillStyle = 'rgba(8,10,12,0.58)';
  ctx.fillRect(r.x, r.y, r.w, ct - r.y);
  ctx.fillRect(r.x, cb, r.w, r.y + r.h - cb);
  ctx.fillStyle = 'rgba(255,255,255,0.85)';
  for (const y of [ct, cb]) {
    ctx.fillRect(r.x, Math.round(y), r.w, Math.max(1, Math.round(d * 0.75)));
    ctx.fillRect(r.x + r.w * 0.06 - 12 * d, Math.round(y) - 2 * d, 24 * d, 4 * d);
  }
  // slit
  const sx = Math.round(r.x + S.src.slit * r.w);
  ctx.fillStyle = C.signal;
  ctx.shadowColor = C.signal; ctx.shadowBlur = 8 * d;
  ctx.fillRect(sx - Math.round(d), ct, Math.max(2, Math.round(2 * d)), cb - ct);
  ctx.shadowBlur = 0;
  ctx.beginPath(); ctx.moveTo(sx - 6 * d, ct); ctx.lineTo(sx + 6 * d, ct); ctx.lineTo(sx, ct + 7 * d); ctx.closePath(); ctx.fill();
  ctx.beginPath(); ctx.moveTo(sx - 6 * d, cb); ctx.lineTo(sx + 6 * d, cb); ctx.lineTo(sx, cb - 7 * d); ctx.closePath(); ctx.fill();
  // depth ladder
  const cap = S.cap;
  const mono = C.mono, disp = C.display;
  if (cap && cap.ok && cap.g) {
    const kOut = cap.g.kOut, sg = S.track ? S.track.sigma : 1;
    const lw = Math.min(110 * d, r.w * 0.28), lx = r.x + r.w - lw - 8 * d;
    const bh = (cb - ct) / NB;
    let vmax = 8;
    for (let b = 0; b < NB; b++) vmax = Math.max(vmax, Math.abs(cap.bands[b * 3]) * kOut);
    const pick = chosenBand();
    ctx.font = `${Math.round(10 * d)}px ${mono}`;
    ctx.textBaseline = 'middle'; ctx.textAlign = 'right';
    for (let b = 0; b < NB; b++) {
      const v = -sg * cap.bands[b * 3] * kOut, cf = cap.bands[b * 3 + 2];
      const yc = ct + (b + 0.5) * bh;
      const len = clamp(Math.abs(v) / vmax, 0.02, 1) * (lw - 40 * d);
      const on = b === pick, locked = b === S.dev.lockBand;
      ctx.globalAlpha = 0.28 + 0.72 * clamp(cf / 0.5, 0, 1);
      ctx.fillStyle = on || locked ? C.signal : 'rgba(255,255,255,0.9)';
      ctx.fillRect(lx + lw - len, yc - 2 * d, len, 4 * d);
      ctx.globalAlpha = 1;
      ctx.fillStyle = 'rgba(0,0,0,0.5)';
      ctx.fillRect(lx + lw - len - 38 * d, yc - 7 * d, 34 * d, 14 * d);
      ctx.fillStyle = on || locked ? C.signal : '#fff';
      ctx.fillText(cf < 0.12 ? '··' : Math.abs(v).toFixed(1), lx + lw - len - 7 * d, yc + 0.5 * d);
      if (locked) { ctx.strokeStyle = C.signal; ctx.lineWidth = d; ctx.strokeRect(lx - 4 * d, yc - bh / 2 + 2 * d, lw + 6 * d, bh - 4 * d); }
    }
    ctx.textAlign = 'left';
  }
  // HUD
  ctx.shadowColor = 'rgba(0,0,0,0.7)'; ctx.shadowBlur = 4 * d;
  if (src.kind === 'camera' && performance.now() - (S.lastCamFrame || 0) > 1500) {
    ctx.font = `600 ${Math.round(12 * d)}px ${C.mono}`;
    ctx.textAlign = 'center'; ctx.textBaseline = 'middle'; ctx.fillStyle = '#fff';
    ctx.fillText('Waiting for camera frames…', r.x + r.w / 2, r.y + r.h / 2);
    ctx.textAlign = 'left';
  }
  ctx.font = `${Math.round(10 * d)}px ${mono}`;
  ctx.textBaseline = 'top';
  ctx.fillStyle = 'rgba(255,255,255,0.9)';
  const fps = cap && cap.fps ? `${Math.round(cap.fps)} fps` : '';
  if (fps && !S.scanning) ctx.fillText(fps, r.x + 8 * d, r.y + 8 * d);
  if (S.scanning && S.sess) {
    const n = S.sess.frames.length, tm = n ? S.sess.frames[n - 1].t : 0;
    ctx.fillStyle = C.rec;
    ctx.beginPath(); ctx.arc(r.x + 14 * d, r.y + 13 * d, 4.5 * d, 0, Math.PI * 2); ctx.fill();
    ctx.fillStyle = '#fff';
    ctx.fillText(`REC ${fmtTime(tm)}`, r.x + 24 * d, r.y + 8 * d);
  }
  if (cap && cap.ok && S.track) {
    const n = S.sess ? S.sess.frames.length : 0;
    const live = S.scanning && n > 1 ? S.track.u[n - 2] : null;
    let v = live;
    if (v == null) {
      const pick = chosenBand();
      v = pick >= 0 ? Math.abs(cap.bands[pick * 3]) * cap.g.kOut : 0;
    }
    ctx.font = `800 ${Math.round(26 * d)}px ${disp}`;
    ctx.textBaseline = 'alphabetic';
    ctx.fillStyle = '#fff';
    const txt = v.toFixed(1);
    ctx.fillText(txt, r.x + 10 * d, r.y + r.h - 10 * d);
    const tw = ctx.measureText(txt).width;
    ctx.font = `${Math.round(10 * d)}px ${mono}`;
    let extra = 'px/f';
    const g = gpsNow();
    if (Number.isFinite(g)) extra += `  ·  ${(g * 3.6).toFixed(0)} km/h`;
    ctx.fillText(extra, r.x + 16 * d + tw, r.y + r.h - 12 * d);
  }
  ctx.shadowBlur = 0;
}

/* monitor gestures: slit, crop edges, depth band lock */
function monHit(px, py) {
  const r = monRect();
  if (!r) return null;
  const d = DPR();
  const ct = r.y + S.src.cropTop * r.h, cb = r.y + S.src.cropBot * r.h;
  const lw = Math.min(110 * d, r.w * 0.28), lx = r.x + r.w - lw - 12 * d;
  if (px > lx && py > ct && py < cb && S.cap && S.cap.ok) return { kind: 'band', b: clamp(Math.floor((py - ct) / ((cb - ct) / NB)), 0, NB - 1) };
  const tol = (TOUCH ? 18 : 9) * d;
  if (Math.abs(py - ct) < tol) return { kind: 'top' };
  if (Math.abs(py - cb) < tol) return { kind: 'bot' };
  if (Math.abs(px - (r.x + S.src.slit * r.w)) < tol * 1.4) return { kind: 'slit' };
  return null;
}
function bindMonitor() {
  let drag = null;
  monCv.addEventListener('pointerdown', (ev) => {
    const d = DPR(), px = ev.offsetX * d, py = ev.offsetY * d;
    const h = monHit(px, py);
    if (!h) return;
    if (h.kind === 'band') {
      S.dev.lockBand = S.dev.lockBand === h.b ? -1 : h.b;
      syncDevUI(); devChanged();
      return;
    }
    if (S.cap && S.cap.rec) { toast('Slit and crop are fixed while scanning.'); return; }
    drag = h;
    monCv.setPointerCapture(ev.pointerId);
  });
  monCv.addEventListener('pointermove', (ev) => {
    const d = DPR(), px = ev.offsetX * d, py = ev.offsetY * d, r = monRect();
    if (!drag) {
      const h = monHit(px, py);
      monCv.style.cursor = !h ? 'default' : h.kind === 'slit' ? 'ew-resize' : h.kind === 'band' ? 'pointer' : 'ns-resize';
      return;
    }
    if (!r) return;
    if (drag.kind === 'slit') S.src.slit = clamp((px - r.x) / r.w, 0.08, 0.92);
    else if (drag.kind === 'top') S.src.cropTop = clamp((py - r.y) / r.h, 0, S.src.cropBot - 0.15);
    else if (drag.kind === 'bot') S.src.cropBot = clamp((py - r.y) / r.h, S.src.cropTop + 0.15, 1);
    applySrcChange();
  });
  const end = () => { drag = null; };
  monCv.addEventListener('pointerup', end);
  monCv.addEventListener('pointercancel', end);
}

/* --------------------------------------------------------- stage input */
function bindStage() {
  const pts = new Map();
  let drag = null, pinch = null;
  const pos = (ev) => { const d = DPR(); const rc = panoCv.getBoundingClientRect(); return [(ev.clientX - rc.left) * d, (ev.clientY - rc.top) * d]; };
  panoCv.addEventListener('pointerdown', (ev) => {
    if (!S.track) return;
    panoCv.setPointerCapture(ev.pointerId);
    pts.set(ev.pointerId, pos(ev));
    if (pts.size === 1) { const [x, y] = pos(ev); drag = { x, y, vx: S.view.x, vy: S.view.y, moved: false }; panoCv.classList.add('grabbing'); }
    if (pts.size === 2) {
      const [a, b] = [...pts.values()];
      pinch = { dist: Math.hypot(a[0] - b[0], a[1] - b[1]), z: S.view.z, cx: (a[0] + b[0]) / 2, D: S.view.x + (a[0] + b[0]) / 2 / S.view.z };
      drag = null;
    }
  });
  panoCv.addEventListener('pointermove', (ev) => {
    if (!S.track) return;
    const [x, y] = pos(ev);
    if (pts.has(ev.pointerId)) pts.set(ev.pointerId, [x, y]);
    if (pinch && pts.size === 2) {
      const [a, b] = [...pts.values()];
      const dist = Math.hypot(a[0] - b[0], a[1] - b[1]);
      const cx = (a[0] + b[0]) / 2;
      S.view.mode = 'free';
      setZoom(pinch.z * dist / pinch.dist, cx, pinch.D);
      unfollow();
      return;
    }
    if (drag) {
      const dx = x - drag.x, dy = y - drag.y;
      if (Math.abs(dx) + Math.abs(dy) > 3) drag.moved = true;
      S.view.x = drag.vx - dx / S.view.z;
      S.view.y = drag.vy - dy;
      clampView();
      unfollow();
      S.dirty.stage = S.dirty.overview = S.dirty.graph = true;
      return;
    }
    hoverAt(x, ev.clientX, ev.clientY);
  });
  const up = (ev) => {
    pts.delete(ev.pointerId);
    if (pts.size < 2) pinch = null;
    if (pts.size === 0) { drag = null; panoCv.classList.remove('grabbing'); }
  };
  panoCv.addEventListener('pointerup', up);
  panoCv.addEventListener('pointercancel', up);
  panoCv.addEventListener('pointerleave', () => { if (!drag) { S.hoverFrame = -1; $('tip').hidden = true; S.dirty.stage = S.dirty.graph = true; } });
  panoCv.addEventListener('wheel', (ev) => {
    if (!S.track) return;
    ev.preventDefault();
    const d = DPR(), rc = panoCv.getBoundingClientRect(), ax = (ev.clientX - rc.left) * d;
    const unit = ev.deltaMode === 1 ? 16 : ev.deltaMode === 2 ? 400 : 1;
    if (ev.ctrlKey || ev.metaKey) {
      const D = S.view.x + ax / S.view.z;
      setZoom(S.view.z * Math.exp(-ev.deltaY * unit * 0.0022), ax, D);
      S.view.mode = Math.abs(S.view.z - fitZ()) < 1e-4 ? 'fit' : 'free';
    } else {
      const delta = (Math.abs(ev.deltaX) > Math.abs(ev.deltaY) ? ev.deltaX : ev.deltaY) * unit * d;
      S.view.x += delta / S.view.z;
      clampView();
    }
    unfollow();
    S.dirty.stage = S.dirty.overview = S.dirty.graph = true;
  }, { passive: false });
  panoCv.addEventListener('dblclick', (ev) => {
    const d = DPR(), rc = panoCv.getBoundingClientRect();
    zoomTo(S.view.mode === 'fit' ? '1' : 'fit', (ev.clientX - rc.left) * d);
  });
}
function unfollow() {
  if (S.view.follow && S.scanning) { S.view.follow = false; $('btnFollow').hidden = false; }
}
function hoverAt(x, cx, cy) {
  const tr = S.track;
  if (!tr) return;
  const j = frameAtScreen(x);
  const D = S.view.x + x / S.view.z;
  if (D < 0 || D > outW()) { S.hoverFrame = -1; $('tip').hidden = true; S.dirty.stage = S.dirty.graph = true; return; }
  S.hoverFrame = j;
  const F = S.sess.frames, tip = $('tip');
  tip.hidden = false;
  tip.textContent = `${fmtTime(F[j].t)} · frame ${j} · ${tr.u[j].toFixed(1)} px/f`;
  const rc = $('stage').getBoundingClientRect();
  tip.style.left = clamp(cx - rc.left, 80, rc.width - 80) + 'px';
  tip.style.top = Math.max(8, cy - rc.top - 34) + 'px';
  S.dirty.stage = S.dirty.graph = true;
}

function bindOverview() {
  let down = false;
  const go = (ev) => {
    if (!S.track) return;
    const rc = ovCv.getBoundingClientRect();
    const f = clamp((ev.clientX - rc.left) / rc.width, 0, 1);
    const span = stageMetrics().W / S.view.z;
    S.view.x = f * outW() - span / 2;
    clampView();
    unfollow();
    S.dirty.stage = S.dirty.overview = S.dirty.graph = true;
  };
  ovCv.addEventListener('pointerdown', (ev) => { down = true; ovCv.setPointerCapture(ev.pointerId); go(ev); });
  ovCv.addEventListener('pointermove', (ev) => { if (down) go(ev); });
  ovCv.addEventListener('pointerup', () => { down = false; });
  ovCv.addEventListener('pointercancel', () => { down = false; });
}

function bindGraph() {
  let drag = null;
  const loc = (ev) => { const d = DPR(), rc = graphCv.getBoundingClientRect(); return [(ev.clientX - rc.left) * d, (ev.clientY - rc.top) * d]; };
  graphCv.addEventListener('pointerdown', (ev) => {
    const sess = S.sess, tr = S.track;
    if (!sess || !tr || sess.frames.length < 3) return;
    const [x] = loc(ev), W = graphCv.width, n = sess.frames.length, d = DPR();
    const xi = graphX(tr.fi, W, n), xo = graphX(tr.fo, W, n);
    graphCv.setPointerCapture(ev.pointerId);
    if (!S.scanning && Math.abs(x - xi) < 10 * d) drag = 'in';
    else if (!S.scanning && Math.abs(x - xo) < 10 * d) drag = 'out';
    else { drag = 'seek'; const j = graphJ(x, W, n); if (j >= tr.fi && j <= tr.fo) { centerOnFrame(j); unfollow(); } }
  });
  graphCv.addEventListener('pointermove', (ev) => {
    const sess = S.sess, tr = S.track;
    if (!sess || !tr || sess.frames.length < 2) return;
    const [x] = loc(ev), W = graphCv.width, n = sess.frames.length, d = DPR();
    const j = graphJ(x, W, n);
    if (!drag) {
      const xi = graphX(tr.fi, W, n), xo = graphX(tr.fo, W, n);
      graphCv.style.cursor = !S.scanning && (Math.abs(x - xi) < 10 * d || Math.abs(x - xo) < 10 * d) ? 'ew-resize' : 'pointer';
      S.hoverFrame = j; S.dirty.graph = S.dirty.stage = true;
      return;
    }
    if (drag === 'in') { S.dev.trimIn = clamp(j / (n - 1), 0, S.dev.trimOut - 2 / (n - 1)); devChanged(false); }
    else if (drag === 'out') { S.dev.trimOut = clamp(j / (n - 1), S.dev.trimIn + 2 / (n - 1), 1); devChanged(false); }
    else if (j >= tr.fi && j <= tr.fo) { centerOnFrame(j); S.hoverFrame = j; }
  });
  const up = () => { drag = null; };
  graphCv.addEventListener('pointerup', up);
  graphCv.addEventListener('pointercancel', up);
  graphCv.addEventListener('pointerleave', () => { if (!drag) { S.hoverFrame = -1; S.dirty.graph = S.dirty.stage = true; } });
}

/* ---------------------------------------------------------- develop UI */
function paintRange(el) { const p = (el.value - el.min) / (el.max - el.min) * 100; el.style.setProperty('--p', p + '%'); }
const DEV_PERSIST = ['depth', 'smooth', 'stabilize', 'seams', 'stretch', 'source', 'fixed', 'direction', 'layers'];
let devQueued = false;
function devChanged(persist = true) {
  if (persist) { const o = {}; for (const k of DEV_PERSIST) o[k] = S.dev[k]; prefs.set('dev', o); }
  if (devQueued) return;
  devQueued = true;
  requestAnimationFrame(() => { devQueued = false; retrack(true); });
}
function depthWord(v) { return v < 0.2 ? 'far' : v > 0.8 ? 'near' : v < 0.4 ? 'far-mid' : v > 0.6 ? 'mid-near' : 'mid'; }
const ranges = [];
function bindRange(id, outId, get, set, fmt) {
  const el = $(id);
  const upd = () => { $(outId).textContent = fmt(get()); paintRange(el); };
  el.addEventListener('input', () => { set(parseFloat(el.value)); upd(); devChanged(); });
  ranges.push(() => { el.value = String(toSlider(id, get())); upd(); });
}
function toSlider(id, v) { return id === 'cStretch' ? Math.log2(v) : v; }
function bindSeg(id, get, set) {
  const el = $(id);
  el.addEventListener('click', (ev) => {
    const b = ev.target.closest('button[data-v]');
    if (!b || b.disabled) return;
    set(b.dataset.v);
    syncSeg(id, get());
  });
  syncSeg(id, get());
}
function syncSeg(id, v) { for (const b of $(id).querySelectorAll('button[data-v]')) b.setAttribute('aria-checked', String(b.dataset.v === String(v))); }
function syncDevUI() {
  for (const f of ranges) f();
  syncSeg('segSource', S.dev.source);
  syncSeg('segDir', S.dev.direction);
  syncSeg('segLayers', S.dev.layers);
  $('ctlFixed').hidden = S.dev.source !== 'fixed';
  const locked = S.dev.lockBand >= 0;
  $('lockChip').hidden = !locked;
  $('ctlDepth').classList.toggle('off', locked || S.dev.source !== 'motion');
  $('cDepth').disabled = locked;
  if (locked) $('lockText').textContent = `Locked to band ${S.dev.lockBand + 1} of ${NB}`;
  const gpsBtn = $('segSource').querySelector('[data-v="gps"]');
  gpsBtn.disabled = !(S.sess && S.sess.gpsAny);
}
function bindDevelop() {
  bindRange('cDepth', 'oDepth', () => S.dev.depth, (v) => { S.dev.depth = v; }, (v) => `${depthWord(v)} · ${v.toFixed(2)}`);
  bindRange('cFixed', 'oFixed', () => S.dev.fixed, (v) => { S.dev.fixed = v; }, (v) => `${v} px/f`);
  bindRange('cStretch', 'oStretch', () => S.dev.stretch, (v) => { S.dev.stretch = Math.pow(2, v); }, (v) => `${v.toFixed(2)}×`);
  bindRange('cSmooth', 'oSmooth', () => S.dev.smooth, (v) => { S.dev.smooth = v; }, (v) => (v ? `${v} f` : 'off'));
  bindRange('cStab', 'oStab', () => S.dev.stabilize, (v) => { S.dev.stabilize = v; }, (v) => `${Math.round(v * 100)} %`);
  bindRange('cSeams', 'oSeams', () => S.dev.seams, (v) => { S.dev.seams = v; }, (v) => `${Math.round(v * 100)} %`);
  bindSeg('segSource', () => S.dev.source, (v) => { S.dev.source = v; syncDevUI(); devChanged(); });
  bindSeg('segDir', () => S.dev.direction, (v) => {
    S.dev.direction = v;
    if (v !== 'auto' && S.sess) { S.sess.sigma = v === 'left' ? 1 : -1; S.sess.sigmaLocked = true; }
    if (v === 'auto' && S.sess && S.sess.done) S.sess.sigmaLocked = false;
    devChanged();
  });
  bindSeg('segLayers', () => S.dev.layers, (v) => { S.dev.layers = v; devChanged(); });
  $('btnUnlock').addEventListener('click', () => { S.dev.lockBand = -1; syncDevUI(); devChanged(); });
  $('btnReset').addEventListener('click', () => {
    const keep = { trimIn: S.dev.trimIn, trimOut: S.dev.trimOut };
    S.dev = Object.assign({}, DEV0, keep);
    syncDevUI(); devChanged();
  });
  syncDevUI();
}
function updateOutH() {
  const cropH = S.source ? (S.src.cropBot - S.src.cropTop) * S.source.h : 1e9;
  for (const b of $('segOutH').querySelectorAll('button')) b.disabled = (S.cap && S.cap.rec) || Number(b.dataset.v) > Math.max(720, cropH * 1.02);
  syncSeg('segOutH', S.src.outH);
  const eff = S.source ? makeGeom(S.source, S.src).OH : S.src.outH;
  $('oOutH').textContent = eff < S.src.outH ? `${eff} px max` : `${eff} px`;
  $('oLevel').textContent = `${S.src.level.toFixed(1)}°`;
}
function bindSource() {
  const lv = $('cLevel');
  lv.value = S.src.level; paintRange(lv);
  lv.addEventListener('input', () => { S.src.level = parseFloat(lv.value); paintRange(lv); applySrcChange(); });
  lv.addEventListener('dblclick', () => { S.src.level = 0; lv.value = 0; paintRange(lv); applySrcChange(); });
  bindSeg('segOutH', () => S.src.outH, (v) => { S.src.outH = Number(v); applySrcChange(); });
  $('cGps').checked = !!S.src.gps;
  $('cKeep').checked = !!S.src.keep;
  $('cGps').addEventListener('change', (e) => { S.src.gps = e.target.checked; prefs.set('src', S.src); if (S.src.gps && S.mode === 'live') startGPS(); if (!S.src.gps) stopGPS(); });
  $('cKeep').addEventListener('change', (e) => { S.src.keep = e.target.checked; prefs.set('src', S.src); });
  $('cCam').addEventListener('change', () => { if (S.mode === 'live' && !S.scanning) startCamera(); });
  $('btnOpen').addEventListener('click', () => $('fileIn').click());
  $('btnRecord').hidden = !TOUCH;
  $('btnRecord').addEventListener('click', () => $('camIn').click());
  $('fileIn').addEventListener('change', (e) => { const f = e.target.files[0]; e.target.value = ''; if (f) loadClip(f); });
  $('camIn').addEventListener('change', (e) => { const f = e.target.files[0]; e.target.value = ''; if (f) loadClip(f); });
  const pos = $('cClipPos');
  pos.addEventListener('input', () => {
    paintRange(pos);
    const vid = vidClip();
    if (!S.clip || !S.clip.ready || S.scanning) return;
    const t = parseFloat(pos.value) * vid.duration;
    vid.currentTime = t;
    $('oClipPos').textContent = fmtTime(t) + ' / ' + fmtTime(vid.duration);
  });
}

/* ------------------------------------------------------------ export */
function updateExportAvail() {
  const ok = !!(S.sess && S.track && S.track.L > 2 && !S.scanning);
  $('btnExport').disabled = !ok;
  updateFacts();
}
function updateFacts() {
  const sess = S.sess, tr = S.track;
  if (!sess || !tr) { $('fLen').textContent = '0'; $('fDur').textContent = fmtTime(0); $('fFrames').textContent = '0'; return; }
  const F = sess.frames;
  $('fLen').textContent = fmtInt(outW()) + ' × ' + sess.geom.OH;
  $('fDur').textContent = fmtTime(F[tr.fo].t - F[tr.fi].t);
  $('fFrames').textContent = fmtInt(tr.fo - tr.fi + 1);
}

let exJob = null;
function openExport() {
  if ($('btnExport').disabled) return;
  $('sheet').hidden = false; $('scrim').hidden = false; $('btnFab').hidden = true;
  syncSeg('exScale', S.ex.scale); syncSeg('exStyle', S.ex.style); syncSeg('exFrame', S.ex.frame); syncSeg('exPace', S.ex.pace); syncSeg('exFps', S.ex.fps);
  $('exLen').value = S.ex.len; $('exLine').checked = S.ex.line;
  $('btnClip').hidden = !(S.sess && S.sess.clip);
  updateExportInfo();
  S.previewT0 = performance.now();
  setTimeout(() => { const b = $('sheet').querySelector('[aria-checked="true"]'); if (b) b.focus(); }, 30);
}
function closeExport() {
  if (exJob) return;
  $('sheet').hidden = true; $('scrim').hidden = true;
  const r = $('btnScan').getBoundingClientRect();
  $('btnFab').hidden = r.bottom > 0 && r.top < window.innerHeight;
}
function updateExportInfo() {
  if (!S.track) return;
  const sc = S.ex.scale, H = Math.round(S.sess.geom.OH * sc), W = Math.floor(S.track.L * S.dev.stretch * sc);
  const mp = W * H / 1e6;
  $('exImgInfo').textContent = `${fmtInt(W)} × ${fmtInt(H)} px · ${mp < 10 ? mp.toFixed(1) : Math.round(mp)} MP · PNG`;
  const plan = videoPlan();
  $('exVidInfo').textContent = `${plan.FW} × ${plan.FH} · ${plan.fps} fps · ${fmtTime(plan.dur + plan.hold, 0)} · ${'VideoEncoder' in window ? 'MP4' : 'WebM'}`;
  $('exLen').disabled = S.ex.pace === 'real';
  $('exLen').style.opacity = S.ex.pace === 'real' ? 0.4 : 1;
}
function bindExport() {
  $('btnExport').addEventListener('click', openExport);
  $('sheetClose').addEventListener('click', closeExport);
  $('scrim').addEventListener('click', closeExport);
  const saveEx = () => { prefs.set('export', S.ex); updateExportInfo(); };
  bindSeg('exScale', () => S.ex.scale, (v) => { S.ex.scale = Number(v); saveEx(); });
  bindSeg('exStyle', () => S.ex.style, (v) => { S.ex.style = v; saveEx(); S.previewT0 = performance.now(); });
  bindSeg('exFrame', () => S.ex.frame, (v) => { S.ex.frame = v; saveEx(); });
  bindSeg('exPace', () => S.ex.pace, (v) => { S.ex.pace = v; saveEx(); S.previewT0 = performance.now(); });
  bindSeg('exFps', () => S.ex.fps, (v) => { S.ex.fps = Number(v); saveEx(); });
  $('exLen').addEventListener('input', () => { const v = parseFloat($('exLen').value); if (v > 0) { S.ex.len = clamp(v, 2, 600); saveEx(); } });
  $('exLine').addEventListener('change', () => { S.ex.line = $('exLine').checked; saveEx(); });
  $('btnPng').addEventListener('click', exportPNG);
  $('btnVid').addEventListener('click', exportVideo);
  $('btnCsv').addEventListener('click', exportCSV);
  $('btnClip').addEventListener('click', () => {
    const b = S.sess && S.sess.clip;
    if (b) saveBlob(b, `fensterband-recording-${stamp()}.${/mp4/.test(b.type) ? 'mp4' : 'webm'}`);
  });
  $('exCancel').addEventListener('click', () => { if (exJob) exJob.cancelled = true; });
}
function startJob(text) {
  exJob = { cancelled: false };
  $('exProg').hidden = false;
  $('exProgText').textContent = text;
  $('exProgBar').style.width = '0%';
  for (const b of document.querySelectorAll('#sheet .btn, #sheet .seg button, #sheet input')) b.disabled = true;
  $('sheetClose').disabled = true;
  $('exReady').hidden = true;
  const job = exJob;
  job.progress = (f, label) => { $('exProgBar').style.width = (clamp(f, 0, 1) * 100).toFixed(1) + '%'; if (label) $('exProgText').textContent = label; };
  return job;
}
function endJob() {
  exJob = null;
  $('exProg').hidden = true;
  for (const b of document.querySelectorAll('#sheet .btn, #sheet .seg button, #sheet input')) b.disabled = false;
  $('sheetClose').disabled = false;
  updateExportInfo();
}

let dlCap = null;
async function saveBlob(blob, filename) {
  if (window.__fbTestSave) return window.__fbTestSave(blob, filename);
  if (IN_VIEWER) {
    try {
      dlCap = dlCap || window.claude.use('downloads');
      const dl = await dlCap;
      if (!dl) { toast('Saving files isn\'t available in this view.', true); return false; }
      await dl.save({ filename, data: blob });
      toast('Saved ' + filename);
      return true;
    } catch (e) {
      const code = e && e.code;
      if (code === 'declined') toast('Save cancelled.');
      else if (code === 'rate_limited') toast('Another save is still waiting for an answer.', true);
      else if (code === 'too_large') toast('That file is too large to save here. Choose a smaller size.', true);
      else toast('Saving files isn\'t available in this view.', true);
      return false;
    }
  }
  // phones: the share sheet saves to Photos or Files; it needs a fresh tap
  // after a long render, so a ready-to-save button takes over then
  if (TOUCH && navigator.canShare && typeof File !== 'undefined') {
    const file = new File([blob], filename, { type: blob.type || 'application/octet-stream' });
    if (navigator.canShare({ files: [file] })) {
      try { await navigator.share({ files: [file] }); toast('Saved ' + filename); return true; }
      catch (e) {
        if (e && e.name === 'AbortError') { toast('Save cancelled.'); return false; }
        offerSave(file);
        return false;
      }
    }
  }
  downloadFile(blob, filename);
  return true;
}
function downloadFile(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = filename;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 60000);
  toast('Saved ' + filename);
}
function offerSave(file) {
  if ($('sheet').hidden) openExport();
  $('exReady').hidden = false;
  $('exReadyName').textContent = file.name;
  $('exReadyBtn').onclick = async () => {
    try { await navigator.share({ files: [file] }); $('exReady').hidden = true; toast('Saved ' + file.name); }
    catch (e) { if (!e || e.name !== 'AbortError') { downloadFile(file, file.name); $('exReady').hidden = true; } }
  };
  $('exReadyBtn').focus();
}

async function exportPNG() {
  const tr = S.track, dev = S.dev, sess = S.sess;
  if (!tr || !sess) return;
  const sc = S.ex.scale;
  const H = Math.max(2, Math.round(sess.geom.OH * sc));
  const WT = Math.floor(tr.L * dev.stretch * sc);
  if (WT < 2) return;
  const mirror = tr.sigma < 0;
  const job = startJob('Rendering image');
  const CH = 2048;
  const band = clamp(Math.floor(40e6 / (WT * 4)), 8, H);
  const rows = async (y0, y1) => {
    const n = y1 - y0, buf = new Uint8ClampedArray(WT * n * 4);
    for (let ca = 0; ca < WT; ca += CH) {
      if (job.cancelled) throw new Error('cancelled');
      const cb = Math.min(WT, ca + CH);
      const [ta, tb] = E.framesForCols(tr, dev, ca, cb, sc);
      await sess.store.ensure(ta, tb);
      E.renderCols(tr, dev, sess.store.getFull, { c0: ca, c1: cb, r0: y0, r1: y1, sc, buf, bw: WT, xMap: mirror ? (c) => WT - 1 - c : (c) => c });
      job.progress((y0 + n * cb / WT) / H, `Rendering image · ${Math.round((y0 + n * cb / WT) / H * 100)} %`);
      await sleep(0);
    }
    return buf;
  };
  try {
    let blob;
    if (typeof CompressionStream !== 'undefined') {
      blob = await E.writePNG(WT, H, band, rows, null, () => job.cancelled);
    } else {
      if (WT > 16384 || WT * H > 16e6) throw new Error('too-wide');
      const cv = mk(WT, H), cx = cv.getContext('2d');
      for (let y0 = 0; y0 < H; y0 += band) {
        const y1 = Math.min(H, y0 + band);
        cx.putImageData(new ImageData(await rows(y0, y1), WT, y1 - y0), 0, y0);
      }
      blob = await new Promise((r) => cv.toBlob(r, 'image/png'));
    }
    job.progress(1, 'Saving');
    await saveBlob(blob, `fensterband-${stamp()}.png`);
  } catch (e) {
    if (e.message === 'cancelled') toast('Export cancelled.');
    else if (e.message === 'too-wide') toast('This browser can\'t write an image this wide. Choose 50 % or 25 %.', true);
    else { console.error(e); toast('The image could not be written: ' + (e.message || e), true); }
  } finally { endJob(); }
}

function exportCSV() {
  const sess = S.sess, tr = S.track;
  if (!sess || !tr) return;
  const F = sess.frames, kOut = sess.geom.kOut, sg = tr.sigma;
  const head = ['frame', 'time_s', 'strip_px', 'kept'];
  for (let b = 1; b <= NB; b++) head.push(`band${b}_px`, `band${b}_conf`);
  head.push('gps_kmh');
  const lines = [head.join(',')];
  for (let j = 0; j < F.length; j++) {
    const row = [j, F[j].t.toFixed(4), tr.u[j].toFixed(3), j >= tr.fi && j <= tr.fo ? 1 : 0];
    const b = F[j].bands;
    for (let i = 0; i < NB; i++) row.push(b ? (-sg * b[i * 3] * kOut).toFixed(2) : '', b ? b[i * 3 + 2].toFixed(3) : '');
    row.push(Number.isFinite(F[j].gps) ? (F[j].gps * 3.6).toFixed(1) : '');
    lines.push(row.join(','));
  }
  saveBlob(new Blob([lines.join('\n') + '\n'], { type: 'text/csv' }), `fensterband-motion-${stamp()}.csv`);
}

/* video: plan, composition, encoding */
function videoPlan() {
  const [FW, FH] = S.ex.frame.split('x').map(Number);
  const tr = S.track, F = S.sess.frames;
  const real = Math.max(0.5, F[tr.fo].t - F[tr.fi].t);
  const dur = S.ex.pace === 'real' ? real : clamp(S.ex.len, 2, 600);
  const hold = S.ex.style === 'pan' ? 0.5 : 1.5;
  return { FW, FH, fps: S.ex.fps, dur, hold, style: S.ex.style, pace: S.ex.pace, line: S.ex.line && S.ex.style !== 'pan', N: Math.ceil((dur + hold) * S.ex.fps) };
}
function headC(plan, tau) {
  const tr = S.track, F = S.sess.frames, k = S.dev.stretch, w = outW();
  if (plan.pace === 'real') {
    const tm = F[tr.fi].t + Math.min(tau, plan.dur);
    let lo = tr.fi, hi = tr.fo;
    while (hi - lo > 1) { const mid = (lo + hi) >> 1; if (F[mid].t <= tm) lo = mid; else hi = mid; }
    const a = hi > lo ? clamp((tm - F[lo].t) / ((F[hi].t - F[lo].t) || 1), 0, 1) : 0;
    return Math.min(w, ((tr.P[lo] + (tr.P[hi] - tr.P[lo]) * a) - tr.P[tr.fi]) * k);
  }
  return Math.min(1, tau / plan.dur) * w;
}
function frameWindow(plan, cH, w, span, mirror) {
  const Dh = mirror ? w - cH : cH;
  let x0;
  if (plan.style === 'pan') {
    if (w <= span) x0 = (w - span) / 2;
    else {
      const f = w > 0 ? cH / w : 0;
      x0 = plan.pace === 'real' ? clamp(Dh - span / 2, 0, w - span) : (mirror ? (1 - f) : f) * (w - span);
    }
  } else if (plan.style === 'sweep') {
    x0 = mirror ? Math.min(w - span, Dh - 0.08 * span) : Math.max(0, Dh - 0.92 * span);
  } else {
    x0 = mirror ? Dh - 0.08 * span : Dh - 0.92 * span;
  }
  return { x0, Dh };
}
/* draws one video frame; returns tile indices it still needs */
function compose(ctx, W, H, plan, tau, tier, getTile) {
  const tr = S.track, OH = S.sess.geom.OH, k = S.dev.stretch;
  const WT = Math.floor(tr.L * k * tier), w = WT / tier;
  const z = H / OH, span = W / z, mirror = tr.sigma < 0;
  const cH = headC(plan, tau);
  const { x0, Dh } = frameWindow(plan, cH, w, span, mirror);
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.fillStyle = '#0d0f10';
  ctx.fillRect(0, 0, W, H);
  const cA = mirror ? w - (x0 + span) : x0, cB = mirror ? w - x0 : x0 + span;
  const nT = Math.ceil(WT / TILE);
  const iA = Math.max(0, Math.floor(cA * tier / TILE)), iB = Math.min(nT - 1, Math.floor(cB * tier / TILE));
  const miss = [];
  ctx.imageSmoothingEnabled = true; ctx.imageSmoothingQuality = 'high';
  for (let i = iA; i <= iB; i++) {
    const cv = getTile(i);
    if (!cv) { miss.push(i); continue; }
    const DtL = mirror ? WT - (i + 1) * TILE : i * TILE;
    const xa = Math.round((DtL / tier - x0) * z), xb = Math.round(((DtL + TILE) / tier - x0) * z);
    ctx.drawImage(cv, 0, 0, TILE, cv.height, xa, 0, xb - xa, H);
  }
  if (plan.style !== 'pan') {
    const hx = (Dh - x0) * z;
    ctx.fillStyle = '#0d0f10';
    if (!mirror) ctx.fillRect(hx, 0, W - hx, H); else ctx.fillRect(0, 0, Math.max(0, hx), H);
    if (plan.line && tau < plan.dur + 0.04) {
      const lw = Math.max(2, Math.round(H / 360));
      ctx.fillStyle = '#f0bf27';
      ctx.shadowColor = 'rgba(240,191,39,0.85)'; ctx.shadowBlur = lw * 5;
      ctx.fillRect(Math.round(hx - lw / 2), 0, lw, H);
      ctx.shadowBlur = 0;
    }
  }
  return miss;
}
function drawPreview(now) {
  const cv = $('exPreview');
  if ($('sheet').hidden || !S.track || !cv.width) return;
  const ctx = cv.getContext('2d');
  const plan = videoPlan();
  const W = cv.width, H = cv.height;
  // fit the chosen frame shape inside the preview box
  const ar = plan.FW / plan.FH;
  let fw = W, fh = W / ar;
  if (fh > H) { fh = H; fw = H * ar; }
  const loop = plan.dur + plan.hold;
  const speed = Math.max(1, loop / 6);
  const tau = (((now - (S.previewT0 || 0)) / 1000) * speed) % loop;
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.fillStyle = C.sunk; ctx.fillRect(0, 0, W, H);
  const pt = proxyTier();
  const sub = previewCanvas(Math.round(fw), Math.round(fh));
  const sctx = sub.getContext('2d');
  const want = S.want || (S.want = []);
  compose(sctx, sub.width, sub.height, plan, tau, pt, (i) => {
    const e = tiles.entry(pt, i, PROXY_H);
    e.hold = S.frameNo;
    if (tiles.needs(e) && !want.includes(e)) want.push(e);
    return e.ver === S.version && e.valid > 0 ? e.cv : null;
  });
  ctx.drawImage(sub, Math.round((W - fw) / 2), Math.round((H - fh) / 2));
}
let pvCanvas = null;
function previewCanvas(w, h) {
  if (!pvCanvas) pvCanvas = mk(w, h);
  if (pvCanvas.width !== w || pvCanvas.height !== h) { pvCanvas.width = w; pvCanvas.height = h; }
  return pvCanvas;
}

let muxerP = null;
function loadMuxer() {
  if (window.Mp4Muxer) return Promise.resolve(window.Mp4Muxer);
  if (muxerP) return muxerP;
  muxerP = new Promise((res, rej) => {
    const s = document.createElement('script');
    s.src = MUXER_URL; s.async = true;
    const to = setTimeout(() => rej(new Error('muxer timeout')), 15000);
    s.onload = () => { clearTimeout(to); window.Mp4Muxer ? res(window.Mp4Muxer) : rej(new Error('muxer missing')); };
    s.onerror = () => { clearTimeout(to); muxerP = null; rej(new Error('muxer blocked')); };
    document.head.appendChild(s);
  });
  return muxerP;
}
async function pickCodec(W, H, fps, bitrate) {
  const list = ['avc1.640033', 'avc1.64002a', 'avc1.640028', 'avc1.4d0033', 'avc1.4d002a', 'avc1.4d0028', 'avc1.42e033', 'avc1.42002a', 'avc1.42001f'];
  for (const codec of list) {
    try {
      const r = await VideoEncoder.isConfigSupported({ codec, width: W, height: H, bitrate, framerate: fps, avc: { format: 'avc' } });
      if (r && r.supported) return codec;
    } catch (e) { /* try next */ }
  }
  return null;
}
async function makeEncoder(canvas, W, H, fps) {
  const bitrate = Math.round(clamp(W * H * fps * 0.16, 4e6, 40e6));
  if (typeof VideoEncoder !== 'undefined' && typeof VideoFrame !== 'undefined') {
    try {
      const [Mux, codec] = await Promise.all([loadMuxer(), pickCodec(W, H, fps, bitrate)]);
      if (codec) {
        const target = new Mux.ArrayBufferTarget();
        const muxer = new Mux.Muxer({ target, video: { codec: 'avc', width: W, height: H, frameRate: fps }, fastStart: 'in-memory', firstTimestampBehavior: 'offset' });
        let failure = null;
        const enc = new VideoEncoder({ output: (chunk, meta) => muxer.addVideoChunk(chunk, meta), error: (e) => { failure = e; } });
        enc.configure({ codec, width: W, height: H, bitrate, framerate: fps, avc: { format: 'avc' }, latencyMode: 'quality' });
        return {
          ext: 'mp4',
          async add(k) {
            if (failure) throw failure;
            const vf = new VideoFrame(canvas, { timestamp: Math.round(k * 1e6 / fps), duration: Math.round(1e6 / fps) });
            enc.encode(vf, { keyFrame: k % (fps * 2) === 0 });
            vf.close();
            while (enc.encodeQueueSize > 5) await sleep(4);
          },
          async finish() {
            await enc.flush();
            if (failure) throw failure;
            enc.close();
            muxer.finalize();
            return new Blob([target.buffer], { type: 'video/mp4' });
          },
          abort() { try { enc.close(); } catch (e) { /* closed */ } },
        };
      }
    } catch (e) { console.warn('WebCodecs path unavailable', e); }
  }
  if (!canvas.captureStream || !window.MediaRecorder) throw new Error('This browser can\'t encode video.');
  const types = ['video/mp4;codecs=avc1', 'video/webm;codecs=vp9', 'video/webm;codecs=vp8', 'video/webm'];
  const type = types.find((t) => MediaRecorder.isTypeSupported(t)) || '';
  const stream = canvas.captureStream(0);
  const track = stream.getVideoTracks()[0];
  const rec = new MediaRecorder(stream, type ? { mimeType: type, videoBitsPerSecond: bitrate } : undefined);
  const chunks = [];
  rec.ondataavailable = (e) => { if (e.data && e.data.size) chunks.push(e.data); };
  rec.start(500);
  const t0 = performance.now();
  return {
    ext: /mp4/.test(type) ? 'mp4' : 'webm',
    async add(k) {
      if (track.requestFrame) track.requestFrame();
      const due = t0 + (k + 1) * 1000 / fps;
      const wait = due - performance.now();
      if (wait > 0) await sleep(wait);
    },
    finish() { return new Promise((res) => { rec.onstop = () => res(new Blob(chunks, { type: type || 'video/webm' })); rec.stop(); }); },
    abort() { try { rec.stop(); } catch (e) { /* stopped */ } },
  };
}
async function exportVideo() {
  if (!S.track) return;
  const plan = videoPlan();
  const job = startJob('Preparing video');
  const canvas = mk(plan.FW, plan.FH), ctx = canvas.getContext('2d');
  const z = plan.FH / S.sess.geom.OH;
  const tier = z > 0.55 ? 1 : 0.5;
  const vt = new Tiles((SMALL() ? 60 : 160) * 1e6);
  const h = Math.max(1, Math.round(S.sess.geom.OH * tier));
  let enc = null;
  try {
    enc = await makeEncoder(canvas, plan.FW, plan.FH, plan.fps);
    for (let k = 0; k < plan.N; k++) {
      if (job.cancelled) throw new Error('cancelled');
      const tau = k / plan.fps;
      const get = (i) => { const e = vt.entry(tier, i, h); return vt.needs(e) ? null : e.cv; };
      let miss = compose(ctx, plan.FW, plan.FH, plan, tau, tier, get);
      if (miss.length) {
        for (const i of miss) { const e = vt.entry(tier, i, h); e.busy = true; try { await renderTile(e); } finally { e.busy = false; } }
        compose(ctx, plan.FW, plan.FH, plan, tau, tier, get);
      }
      await enc.add(k);
      if (k % 4 === 0) { job.progress(k / plan.N, `Rendering video · ${Math.round(k / plan.N * 100)} %`); await sleep(0); }
    }
    job.progress(1, 'Finishing');
    const blob = await enc.finish();
    await saveBlob(blob, `fensterband-${plan.style}-${stamp()}.${enc.ext}`);
  } catch (e) {
    if (enc && enc.abort) enc.abort();
    if (e.message === 'cancelled') toast('Export cancelled.');
    else { console.error(e); toast('The video could not be written: ' + (e.message || e), true); }
  } finally {
    vt.clear();
    endJob();
  }
}

/* ---------------------------------------------------------- monitor UI */
function monNote(html) {
  const n = $('monNote');
  if (!html) { n.hidden = true; n.innerHTML = ''; return; }
  n.innerHTML = html;
  n.hidden = false;
}

/* --------------------------------------------------------------- loop */
function sizeCanvas(cv) {
  const d = DPR(), r = cv.getBoundingClientRect();
  const w = Math.max(1, Math.round(r.width * d)), h = Math.max(1, Math.round(r.height * d));
  if (cv.width !== w || cv.height !== h) { cv.width = w; cv.height = h; return true; }
  return false;
}
function onResize() {
  const a = sizeCanvas(panoCv), b = sizeCanvas(ovCv), c = sizeCanvas(graphCv);
  sizeCanvas(monCv);
  sizeCanvas($('exPreview'));
  if (a && S.track) {
    if (S.view.mode === 'fit') S.view.z = fitZ();
    clampView();
  }
  if (a || b || c) markAll();
}
S.frameNo = 0;
function tick(now) {
  S.frameNo++;
  demoTick(now);
  if (S.dirty.stage) { S.dirty.stage = false; drawStage(); }
  if (S.dirty.overview && (!S.scanning || S.frameNo % 8 === 0)) { S.dirty.overview = false; drawOverview(); }
  if (S.dirty.graph && (!S.scanning || S.frameNo % 3 === 0)) { S.dirty.graph = false; drawGraph(); }
  if (S.source) drawMonitor(); else if (S.frameNo % 30 === 1) drawMonitor();
  drawPreview(now);
  if (S.want && S.want.length) tiles.request(S.want);
  S.want = null;
  requestAnimationFrame(tick);
}

/* ------------------------------------------------------------- init */
function bindGlobal() {
  for (const b of document.querySelectorAll('.modes button')) b.addEventListener('click', () => { if (!b.disabled) setMode(b.dataset.mode); });
  $('btnScan').addEventListener('click', toggleScan);
  $('btnFab').addEventListener('click', toggleScan);
  if ('IntersectionObserver' in window) {
    const io = new IntersectionObserver((ents) => {
      for (const en of ents) {
        if (en.target.id === 'btnScan') $('btnFab').hidden = en.isIntersecting || !$('sheet').hidden;
        if (en.target.id === 'monitor') { S.monHidden = !en.isIntersecting; S.dirty.stage = true; }
      }
    }, { threshold: 0.4 });
    io.observe($('btnScan')); io.observe($('monitor'));
  }
  $('busyCancel').addEventListener('click', () => { if (busyCancel) busyCancel(); });
  $('btnFollow').addEventListener('click', () => { S.view.follow = true; $('btnFollow').hidden = true; followHead(); markAll(); });
  for (const b of document.querySelectorAll('[data-zoom]')) b.addEventListener('click', () => zoomTo(b.dataset.zoom));
  document.addEventListener('click', (ev) => {
    const a = ev.target.closest('[data-act]');
    if (!a) return;
    const act = a.dataset.act;
    if (act === 'cam') startCamera();
    else if (act === 'open') $('fileIn').click();
    else if (act === 'record') $('camIn').click();
    else if (act === 'rescan-rec' && S.sess && S.sess.clip) {
      const f = new File([S.sess.clip], `recording.${/mp4/.test(S.sess.clip.type) ? 'mp4' : 'webm'}`, { type: S.sess.clip.type });
      loadClip(f);
    }
  });
  window.addEventListener('keydown', (ev) => {
    if (ev.target.closest('input:not([type="range"]), select, textarea')) return;
    if (!$('sheet').hidden) { if (ev.key === 'Escape') closeExport(); return; }
    if (ev.metaKey || ev.ctrlKey || ev.altKey) return;
    if (ev.key === ' ' && !ev.target.closest('button')) { ev.preventDefault(); toggleScan(); }
    else if (ev.key === 'f' || ev.key === 'F') zoomTo('fit');
    else if (ev.key === '1') zoomTo('1');
    else if (ev.key === 'a' || ev.key === 'A') zoomTo('all');
    else if (ev.key === 'e' || ev.key === 'E') openExport();
    else if (ev.key === 'ArrowLeft' || ev.key === 'ArrowRight') {
      if (!S.track || ev.target.closest('input, .seg')) return;
      S.view.x += (ev.key === 'ArrowLeft' ? -1 : 1) * stageMetrics().W / S.view.z * 0.25;
      clampView(); unfollow(); markAll();
    }
  });
  // drag and drop a clip anywhere
  const mon = $('monitor');
  window.addEventListener('dragover', (ev) => { if (ev.dataTransfer && [...ev.dataTransfer.types].includes('Files')) { ev.preventDefault(); mon.classList.add('drop'); } });
  window.addEventListener('dragleave', (ev) => { if (!ev.relatedTarget) mon.classList.remove('drop'); });
  window.addEventListener('drop', (ev) => {
    mon.classList.remove('drop');
    const f = ev.dataTransfer && ev.dataTransfer.files && ev.dataTransfer.files[0];
    if (!f) return;
    ev.preventDefault();
    if (!/^video\//.test(f.type) && !/\.(mp4|mov|m4v|webm|mkv)$/i.test(f.name)) { toast('That isn\'t a video file.', true); return; }
    loadClip(f);
  });
  document.addEventListener('visibilitychange', () => {
    if (document.hidden && S.scanning === 'demo') { finishRecording('Scan stopped when the page was hidden'); }
  });
  const mq = matchMedia('(prefers-color-scheme: dark)');
  if (mq.addEventListener) mq.addEventListener('change', readColors);
  new MutationObserver(readColors).observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme', 'class', 'style'] });
}

async function init() {
  panoCv = $('pano'); panoCtx = panoCv.getContext('2d');
  ovCv = $('overview'); ovCtx = ovCv.getContext('2d');
  graphCv = $('graph'); graphCtx = graphCv.getContext('2d');
  monCv = $('mon'); monCtx = monCv.getContext('2d');
  readColors();
  bindGlobal(); bindStage(); bindOverview(); bindGraph(); bindMonitor(); bindDevelop(); bindSource(); bindExport();
  const ro = new ResizeObserver(onResize);
  for (const el of [panoCv, ovCv, graphCv, monCv, $('exPreview')]) ro.observe(el);
  onResize();
  setMode('demo');
  requestAnimationFrame(tick);
  if (document.fonts && document.fonts.ready) await Promise.race([document.fonts.ready, sleep(1500)]);
  readColors();
  if (!window.__fbNoAutoDemo) fastDemoScan();
}

window.__fb = { S, E, gps, toggleScan, setMode, loadClip, exportPNG, exportVideo, exportCSV, zoomTo, centerOnFrame, retrack, fastDemoScan, openExport, closeExport };
if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init); else init();
})();
