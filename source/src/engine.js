/* Fensterband engine: motion analysis, track building, strip storage, rendering, PNG writing.
   Pure logic where possible so it can be tested outside the browser. */
(function (root) {
'use strict';

const NB = 6;            // depth bands across the captured rows
const CONF_MIN = 0.12;   // band confidence needed to count
const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);

/* ---------------------------------------------------------------- filters */

function boxBlur(src, dst, tmp, w, h, r) {
  const n = 2 * r + 1;
  for (let y = 0; y < h; y++) {
    const row = y * w;
    let acc = 0;
    for (let k = -r; k <= r; k++) acc += src[row + clamp(k, 0, w - 1)];
    for (let x = 0; x < w; x++) {
      tmp[row + x] = acc / n;
      const xa = x - r, xb = x + r + 1;
      acc += src[row + (xb < w ? xb : w - 1)] - src[row + (xa > 0 ? xa : 0)];
    }
  }
  for (let x = 0; x < w; x++) {
    let acc = 0;
    for (let k = -r; k <= r; k++) acc += tmp[clamp(k, 0, h - 1) * w + x];
    for (let y = 0; y < h; y++) {
      dst[y * w + x] = acc / n;
      const ya = y - r, yb = y + r + 1;
      acc += tmp[(yb < h ? yb : h - 1) * w + x] - tmp[(ya > 0 ? ya : 0) * w + x];
    }
  }
}

/* sub-pixel offset of a SAD minimum: equiangular (V) fit, unbiased for SAD */
function vfit(a, c, e) {
  const m = Math.max(a, e) - c;
  if (!(m > 1e-9)) return 0;
  return clamp(0.5 * (a - e) / m, -0.5, 0.5);
}

function sad(cur, prv, w, h, x0, x1, y0, y1, dx, dy) {
  let s = 0;
  for (let y = y0; y < y1; y++) {
    let py = y - dy;
    if (py < 0) py = 0; else if (py >= h) py = h - 1;
    const ci = y * w, pi = py * w - dx;
    for (let x = x0; x < x1; x++) {
      const d = cur[ci + x] - prv[pi + x];
      s += d < 0 ? -d : d;
    }
  }
  return s / ((x1 - x0) * (y1 - y0));
}

/* --------------------------------------------------------------- analyzer
   Estimates horizontal (and vertical) image motion between consecutive
   frames in NB horizontal bands. Each band sees a different depth: sky and
   far hills move slowly, the ground near the track moves fast. */

class Analyzer {
  constructor(w, h) {
    this.w = w; this.h = h;
    this.dims = [];
    let lw = w, lh = h;
    for (let l = 0; l < 3; l++) { this.dims.push([lw, lh]); lw >>= 1; lh >>= 1; }
    this.radii = [4, 3, 2];
    this.buf = [0, 1].map(() => this.dims.map(([a, b]) => ({ g: new Float32Array(a * b), hp: new Float32Array(a * b) })));
    this.tmp = new Float32Array(w * h);
    this.tmp2 = new Float32Array(w * h);
    this.curve = new Float32Array(2 * w + 1);
    this.curveDy = new Int8Array(2 * w + 1);
    this.grid = new Float32Array(15);
    this.cur = 0;
    this.count = 0;
  }

  reset() { this.count = 0; }

  push(rgba) {
    this.cur ^= 1;
    const L = this.buf[this.cur];
    const [w0, h0] = this.dims[0];
    const g0 = L[0].g;
    for (let i = 0, j = 0, n = w0 * h0; i < n; i++, j += 4) {
      g0[i] = 0.299 * rgba[j] + 0.587 * rgba[j + 1] + 0.114 * rgba[j + 2];
    }
    for (let l = 1; l < 3; l++) {
      const [pw] = this.dims[l - 1];
      const [cw, chh] = this.dims[l];
      const src = L[l - 1].g, dst = L[l].g;
      for (let y = 0; y < chh; y++) {
        const r0 = 2 * y * pw, r1 = r0 + pw;
        for (let x = 0; x < cw; x++) {
          const x2 = 2 * x;
          dst[y * cw + x] = 0.25 * (src[r0 + x2] + src[r0 + x2 + 1] + src[r1 + x2] + src[r1 + x2 + 1]);
        }
      }
    }
    for (let l = 0; l < 3; l++) {
      const [lw, lh] = this.dims[l];
      const g = L[l].g, hp = L[l].hp, bl = this.tmp2;
      boxBlur(g, bl, this.tmp, lw, lh, this.radii[l]);
      for (let i = 0, n = lw * lh; i < n; i++) hp[i] = g[i] - bl[i];
    }
    this.count++;
  }

  /* cy0, cy1: captured rows as fractions of frame height.
     prior: previous dx per band (analysis px) or null.
     out: Float32Array(NB*3) -> [dx, dy, conf] per band. dx > 0: content moved right. */
  estimate(cy0, cy1, prior, out) {
    if (this.count < 2) return false;
    const C = this.buf[this.cur], Pv = this.buf[this.cur ^ 1];
    const h0 = this.dims[0][1];
    const r0 = clamp(Math.round(cy0 * h0), 0, h0 - 8);
    const r1 = clamp(Math.round(cy1 * h0), r0 + 8, h0);
    const bh = (r1 - r0) / NB;
    for (let b = 0; b < NB; b++) {
      const by0 = Math.round(r0 + b * bh), by1 = Math.round(r0 + (b + 1) * bh);
      this._band(C, Pv, by0, by1, prior ? prior[b] : NaN, out, b);
    }
    return true;
  }

  _patch(l, by0, by1) {
    const [w, h] = this.dims[l];
    const cx = w >> 1;
    const half = Math.max(3, Math.round(w * 0.2));
    const S = Math.max(1, Math.min(Math.round(w * 0.25), cx - half - 1));
    const sh = 1 << l;
    let y0 = Math.floor(by0 / sh), y1 = Math.floor(by1 / sh);
    if (y1 - y0 < 2) y1 = y0 + 2;
    if (y1 > h) { y1 = h; y0 = Math.max(0, h - 2); }
    return { w, h, x0: cx - half, x1: cx + half, y0, y1, S };
  }

  _band(C, Pv, by0, by1, prior, out, b) {
    // coarse: level 2, full range
    let p = this._patch(2, by0, by1);
    let cur = C[2].hp, prv = Pv[2].hp;
    const curve = this.curve, cdy = this.curveDy;
    let best = Infinity, bdx = 0, bdy = 0;
    for (let dx = -p.S; dx <= p.S; dx++) {
      let m = Infinity, mdy = 0;
      for (let dy = -2; dy <= 2; dy++) {
        const c = sad(cur, prv, p.w, p.h, p.x0, p.x1, p.y0, p.y1, dx, dy);
        if (c < m) { m = c; mdy = dy; }
      }
      curve[dx + p.S] = m; cdy[dx + p.S] = mdy;
      if (m < best) { best = m; bdx = dx; bdy = mdy; }
    }
    // temporal prior: stay with last motion if it is nearly as good (beats aliasing on fences, poles)
    if (Number.isFinite(prior)) {
      const pd = Math.round(prior / 4);
      let pb = Infinity, pdx = 0;
      for (let dx = Math.max(-p.S, pd - 1); dx <= Math.min(p.S, pd + 1); dx++) {
        if (curve[dx + p.S] < pb) { pb = curve[dx + p.S]; pdx = dx; }
      }
      if (pb <= best * 1.15) { best = pb; bdx = pdx; bdy = cdy[pdx + p.S]; }
    }
    // distinctness of the match: compare against the next separate valley
    let second = -Infinity;
    let other = Infinity;
    const N = 2 * p.S + 1, bi = bdx + p.S;
    for (let i = 0; i < N; i++) {
      if (curve[i] > second) second = curve[i];
      if (Math.abs(i - bi) <= 2) continue;
      const l = i > 0 ? curve[i - 1] : Infinity, r = i < N - 1 ? curve[i + 1] : Infinity;
      if (curve[i] <= l && curve[i] <= r && curve[i] < other) other = curve[i];
    }
    if (other < Infinity) second = other;
    const sharp = (second - best) / (second + 1e-3);

    // refine level 1 then level 0
    let dx = bdx * 2, dy = bdy * 2;
    for (let l = 1; l >= 0; l--) {
      p = this._patch(l, by0, by1);
      cur = C[l].hp; prv = Pv[l].hp;
      let lb = Infinity, ldx = dx, ldy = dy;
      const grid = this.grid;
      for (let ddx = -2; ddx <= 2; ddx++) {
        const tx = clamp(dx + ddx, -p.S, p.S);
        for (let ddy = -1; ddy <= 1; ddy++) {
          const c = sad(cur, prv, p.w, p.h, p.x0, p.x1, p.y0, p.y1, tx, dy + ddy);
          if (l === 0) grid[(ddx + 2) * 3 + ddy + 1] = c;
          if (c < lb) { lb = c; ldx = tx; ldy = dy + ddy; }
        }
      }
      if (l === 0) {
        // sub-pixel by parabola fit around the best cell
        const gx = ldx - dx + 2, gy = ldy - dy + 1;
        let sx = 0, sy = 0;
        if (gx > 0 && gx < 4) sx = vfit(grid[(gx - 1) * 3 + gy], grid[gx * 3 + gy], grid[(gx + 1) * 3 + gy]);
        if (gy > 0 && gy < 2) sy = vfit(grid[gx * 3 + gy - 1], grid[gx * 3 + gy], grid[gx * 3 + gy + 1]);
        // texture of the patch
        let tex = 0;
        for (let y = p.y0; y < p.y1; y++) {
          const ri = y * p.w;
          for (let x = p.x0; x < p.x1; x++) { const v = cur[ri + x]; tex += v < 0 ? -v : v; }
        }
        tex /= (p.x1 - p.x0) * (p.y1 - p.y0);
        const qTex = clamp((tex - 0.5) / 2.5, 0, 1);
        const qSharp = clamp((sharp - 0.03) / 0.22, 0, 1);
        const qFit = clamp(1.3 - lb / (tex + 0.5), 0, 1);
        out[b * 3] = ldx + sx;
        out[b * 3 + 1] = ldy + sy;
        out[b * 3 + 2] = qTex * qSharp * qFit;
      }
      dx = ldx * 2; dy = ldy * 2;
    }
  }
}

/* Motion at full output resolution: compares the new strip with the
   previous one, band by band, starting from the coarse estimate. Gives each
   band's horizontal motion to about a tenth of a pixel (what keeps letters
   and poles from stuttering near a stop) and the vertical shake.
   Returns { dx: Float32Array(NB) in output px (NaN where not refined),
             dy: median vertical shift in output px or NaN }. */
function stripSad(pd, pw, cd, cw, H, r0, r1, xs0, xs1, xstep, shift, dy) {
  const sh0 = Math.floor(shift), fsh = shift - sh0;
  let s = 0, n = 0;
  for (let y = r0; y < r1; y += 2) {
    const py = y - dy;
    if (py < 0 || py >= H) continue;
    const ci = y * cw * 4, pi = py * pw * 4;
    for (let x = xs0; x < xs1; x += xstep) {
      const c4 = ci + x * 4, p4 = pi + (x + sh0) * 4;
      const a = cd[c4] + 2 * cd[c4 + 1] + cd[c4 + 2];
      const v0 = pd[p4] + 2 * pd[p4 + 1] + pd[p4 + 2], v1 = pd[p4 + 4] + 2 * pd[p4 + 5] + pd[p4 + 6];
      const d = a - (v0 + (v1 - v0) * fsh);
      s += d < 0 ? -d : d; n++;
    }
  }
  return n ? s / n : Infinity;
}

function refineMotion(prev, cur, bands, OH, M, kOut) {
  const pw = prev.w, cw = cur.w, H = Math.min(prev.h, cur.h);
  const pd = prev.data, cd = cur.data;
  const dxOut = new Float32Array(NB).fill(NaN);
  const dys = [];
  const cx5 = new Float64Array(5), cy9 = new Float64Array(9);
  const base = prev.cx - cur.cx;
  for (let b = 0; b < NB; b++) {
    if (bands[b * 3 + 2] < CONF_MIN) continue;
    const dxc = bands[b * 3] * kOut, dyc = Math.round(bands[b * 3 + 1] * kOut);
    const r0 = M + Math.round(b * OH / NB) + 6, r1 = M + Math.round((b + 1) * OH / NB) - 6;
    const dxi = Math.round(dxc);
    const ccx = Math.round(cur.cx);
    // prev columns used: x + base - dx for dx in [dxi-2, dxi+2], plus one for interpolation
    const lo = Math.floor(base - dxi - 2), hi = Math.floor(base - dxi + 2) + 1;
    const hw = Math.min(24, ccx - 1, cw - ccx - 1, ccx + lo - 1, pw - (ccx + hi) - 2);
    if (hw < 4) continue;
    const xs0 = ccx - hw, xs1 = ccx + hw;
    // horizontal
    let best = Infinity, bi = 0, mean = 0;
    for (let k = 0; k < 5; k++) {
      cx5[k] = stripSad(pd, pw, cd, cw, H, r0, r1, xs0, xs1, 1, base - (dxi - 2 + k), dyc);
      mean += cx5[k];
      if (cx5[k] < best) { best = cx5[k]; bi = k; }
    }
    mean /= 5;
    let dx = dxc;
    if (best < 0.75 * mean && bi > 0 && bi < 4) {
      dx = dxi - 2 + bi + vfit(cx5[bi - 1], best, cx5[bi + 1]);
      dxOut[b] = dx;
    }
    // vertical, at the refined horizontal motion
    best = Infinity; bi = 0; mean = 0;
    for (let k = 0; k < 9; k++) {
      cy9[k] = stripSad(pd, pw, cd, cw, H, r0, r1, xs0, xs1, 2, base - dx, dyc - 4 + k);
      mean += cy9[k];
      if (cy9[k] < best) { best = cy9[k]; bi = k; }
    }
    mean /= 9;
    if (best < 0.7 * mean && bi > 0 && bi < 8) dys.push(dyc - 4 + bi + vfit(cy9[bi - 1], best, cy9[bi + 1]));
  }
  let dy = NaN;
  if (dys.length) {
    dys.sort((a, c) => a - c);
    dy = dys.length & 1 ? dys[dys.length >> 1] : 0.5 * (dys[dys.length / 2 - 1] + dys[dys.length / 2]);
  }
  return { dx: dxOut, dy };
}

/* ------------------------------------------------------------ statistics */

const wpIdx = new Int32Array(64);
function weightedPercentile(vals, ws, m, q) {
  if (m === 0) return NaN;
  if (m === 1) return vals[0];
  const idx = wpIdx;
  for (let i = 0; i < m; i++) {
    let j = i;
    while (j > 0 && vals[idx[j - 1]] > vals[i]) { idx[j] = idx[j - 1]; j--; }
    idx[j] = i;
  }
  let total = 0;
  for (let i = 0; i < m; i++) total += ws[i];
  if (total <= 0) return NaN;
  let cum = 0, prevPos = -1, prevVal = vals[idx[0]];
  for (let k = 0; k < m; k++) {
    const i = idx[k];
    const pos = (cum + ws[i] / 2) / total;
    cum += ws[i];
    if (q <= pos) {
      if (prevPos < 0) return vals[i];
      const a = (q - prevPos) / (pos - prevPos || 1);
      return prevVal + (vals[i] - prevVal) * a;
    }
    prevPos = pos; prevVal = vals[i];
  }
  return prevVal;
}

/* Picks a depth layer: like a weighted percentile, but snaps to the nearest
   band unless q sits close to the boundary between two, where it blends in
   log space. Interpolating straight across a depth gap (a facade at 27 m in
   front of a platform at 4 m) would match neither and double both. */
function layerPick(vals, ws, m, q) {
  if (m === 0) return NaN;
  if (m === 1) return vals[0];
  const idx = wpIdx;
  for (let i = 0; i < m; i++) {
    let j = i;
    while (j > 0 && vals[idx[j - 1]] > vals[i]) { idx[j] = idx[j - 1]; j--; }
    idx[j] = i;
  }
  let total = 0;
  for (let i = 0; i < m; i++) total += ws[i];
  if (total <= 0) return NaN;
  let cum = 0, prevPos = -1, prevVal = vals[idx[0]];
  for (let k = 0; k < m; k++) {
    const i = idx[k];
    const pos = (cum + ws[i] / 2) / total;
    cum += ws[i];
    if (q <= pos) {
      if (prevPos < 0) return vals[i];
      let s = (q - prevPos) / (pos - prevPos || 1);
      s = clamp((s - 0.5) / 0.3 + 0.5, 0, 1);
      s = s * s * (3 - 2 * s);
      const a = prevVal, b = vals[i];
      if (a > 0.5 && b > 0.5) return Math.exp(Math.log(a) * (1 - s) + Math.log(b) * s);
      return a + (b - a) * s;
    }
    prevPos = pos; prevVal = vals[i];
  }
  return prevVal;
}

function gaussSmooth(src, n, sigma, dst) {
  if (!(sigma >= 0.3)) { for (let i = 0; i < n; i++) dst[i] = src[i]; return dst; }
  const r = Math.ceil(sigma * 3);
  const k = new Float32Array(2 * r + 1);
  for (let j = -r; j <= r; j++) k[j + r] = Math.exp(-(j * j) / (2 * sigma * sigma));
  for (let i = 0; i < n; i++) {
    let acc = 0, ws = 0;
    const a = Math.max(0, i - r), b = Math.min(n - 1, i + r);
    for (let j = a; j <= b; j++) { const w = k[j - i + r]; acc += w * src[j]; ws += w; }
    dst[i] = acc / ws;
  }
  return dst;
}

function median5(src, n, dst) {
  const w = [0, 0, 0, 0, 0];
  for (let i = 0; i < n; i++) {
    for (let j = -2; j <= 2; j++) w[j + 2] = src[clamp(i + j, 0, n - 1)];
    w.sort((a, b) => a - b);
    dst[i] = w[2];
  }
  return dst;
}

function fillGaps(f, n, causal) {
  let last = NaN;
  if (causal) {
    for (let i = 0; i < n; i++) { if (Number.isFinite(f[i])) last = f[i]; else f[i] = Number.isFinite(last) ? last : 0; }
    return;
  }
  let prevI = -1;
  for (let i = 0; i <= n; i++) {
    if (i < n && !Number.isFinite(f[i])) continue;
    const a = prevI >= 0 ? f[prevI] : (i < n ? f[i] : 0);
    const b = i < n ? f[i] : a;
    for (let j = prevI + 1; j < i; j++) {
      const t = (j - prevI) / (i - prevI);
      f[j] = prevI < 0 ? b : i >= n ? a : a + (b - a) * t;
    }
    prevI = i;
  }
}

/* direction: sigma = +1 when the scenery moves left in the frame (panorama
   grows to the right), -1 when it moves right (shown mirrored back). */
function detectDirection(frames, upto) {
  let s = 0, mag = 0;
  const n = Math.min(frames.length, upto ?? frames.length);
  for (let t = 0; t < n; t++) {
    const b = frames[t].bands;
    if (!b) continue;
    for (let i = 0; i < NB; i++) {
      const c = b[i * 3 + 2];
      if (c < CONF_MIN) continue;
      const v = clamp(b[i * 3], -20, 20) * c;
      s += v; mag += Math.abs(v);
    }
  }
  return { sigma: s > 0 ? -1 : 1, strength: Math.abs(s), agreement: mag > 0 ? Math.abs(s) / mag : 0 };
}

/* ---------------------------------------------------------------- track
   Turns per-band motion into the strip width for every frame (u, output px),
   cumulative slit positions (P) and vertical stabilisation offsets (corr). */

function computeTrack(sess, dev, opts) {
  const causal = !!(opts && opts.causal);
  const F = sess.frames, n = F.length, g = sess.geom, kOut = g.kOut;
  const T = {
    n, kOut, M: g.M,
    u: new Float32Array(n), P: new Float64Array(n), corr: new Float32Array(n),
    f: new Float32Array(n), raw: new Float32Array(n), valid: new Uint8Array(n),
    sigma: 1, fi: 0, fo: Math.max(0, n - 1), L: 0, gpsRatio: NaN,
    bandU: new Float32Array(n * NB), OH: g.OH,
  };
  if (n === 0) return T;

  if (dev.direction === 'left') T.sigma = 1;
  else if (dev.direction === 'right') T.sigma = -1;
  else if (sess.sigmaLocked) T.sigma = sess.sigma;
  else T.sigma = detectDirection(F).sigma;
  const sg = T.sigma;

  /* Per-band speed, smoothed over a few frames with confidence weights and
     gap-filled. Each band then votes with its reliability over the whole take
     (running reliability when live), so the depth pick doesn't hop when one
     band briefly loses lock on a pole or a patch of empty sky. */
  const lock = dev.lockBand;
  const bs = [], cover = new Float32Array(n);
  const Rk = [];
  const cf = new Float32Array(n), num = new Float32Array(n);
  const val = new Float32Array(n), win = [];
  for (let i = 0; i < NB; i++) {
    const rel = new Float32Array(n);
    let rs = 0;
    for (let t = 0; t < n; t++) {
      const b = F[t].bands;
      const c = b ? b[i * 3 + 2] : 0;
      const rx = F[t].dxF ? F[t].dxF[i] : NaN;
      cf[t] = c >= CONF_MIN ? c : 0;
      val[t] = cf[t] ? -sg * (Number.isFinite(rx) ? rx / kOut : b[i * 3]) : NaN;
    }
    // drop single-frame outliers (a pole flashing through the band)
    for (let t = 0; t < n; t++) {
      if (!cf[t]) { num[t] = 0; continue; }
      win.length = 0;
      for (let j = Math.max(0, t - 3), e = causal ? t : Math.min(n - 1, t + 3); j <= e; j++) if (cf[j]) win.push(val[j]);
      win.sort((a, c) => a - c);
      const med = win[win.length >> 1];
      if (win.length >= 3 && Math.abs(val[t] - med) > 0.35 * Math.abs(med) + 0.4) cf[t] = 0;
      num[t] = cf[t] * val[t];
      rs += cf[t];
      rel[t] = rs / (t + 1);
    }
    if (!causal) rel.fill(rs / n);
    const s = new Float32Array(n);
    if (causal) {
      let a = 0, d = 0;
      for (let t = 0; t < n; t++) { a = a * 0.6 + num[t]; d = d * 0.6 + cf[t]; s[t] = d > 0.05 ? a / d : NaN; cover[t] += Math.min(1, d); }
    } else {
      const A = gaussSmooth(num, n, 2.5, new Float32Array(n)), D = gaussSmooth(cf, n, 2.5, new Float32Array(n));
      for (let t = 0; t < n; t++) {
        cover[t] += D[t];
        const s1 = D[t] > 0.02 ? A[t] / D[t] : NaN;
        // narrow the window when the band is slow, so starts and stops stay sharp
        const sig = Number.isFinite(s1) ? 2.5 * clamp(Math.abs(s1) * kOut / 8, 0.12, 1) : 2.5;
        const r = Math.ceil(sig * 3);
        let a = 0, d = 0, kw = 0;
        for (let j = Math.max(0, t - r), e = Math.min(n - 1, t + r); j <= e; j++) {
          const w = Math.exp(-((j - t) * (j - t)) / (2 * sig * sig));
          a += w * num[j]; d += w * cf[j]; kw += w;
        }
        s[t] = d / kw > 0.02 ? a / d : NaN;
      }
    }
    fillGaps(s, n, causal);
    bs.push(s); Rk.push(rel);
  }
  const vb = new Float32Array(NB), wb = new Float32Array(NB);
  const dyv = new Float32Array(NB), dw = new Float32Array(NB);
  const dyF = new Float32Array(n);
  const q = clamp(dev.depth, 0, 1);
  for (let t = 0; t < n; t++) {
    let f = NaN;
    if (cover[t] > 0.04) {
      if (lock >= 0 && lock < NB) f = bs[lock][t];
      else {
        let rmax = 0;
        for (let i = 0; i < NB; i++) rmax = Math.max(rmax, Rk[i][t]);
        let m = 0;
        for (let i = 0; i < NB; i++) {
          const r = Rk[i][t];
          if (r > 0 && r >= 0.2 * rmax) { vb[m] = bs[i][t]; wb[m] = r; m++; }
        }
        f = layerPick(vb, wb, m, q);
      }
    }
    const b = F[t].bands;
    let dyy = 0;
    if (b) {
      let m = 0;
      for (let i = 0; i < NB; i++) { const c = b[i * 3 + 2]; if (c >= CONF_MIN) { dyv[m] = b[i * 3 + 1]; dw[m] = c; m++; } }
      if (m) { const dm = weightedPercentile(dyv, dw, m, 0.5); if (Number.isFinite(dm)) dyy = dm; }
    }
    for (let i = 0; i < NB; i++) T.bandU[t * NB + i] = Math.max(0, bs[i][t]) * kOut;
    T.raw[t] = f;
    T.valid[t] = Number.isFinite(f) ? 1 : 0;
    dyF[t] = Number.isFinite(F[t].dyF) ? F[t].dyF : dyy * kOut;
  }

  // gps calibration: analysis px per (m/s)
  const ratios = [];
  for (let t = 0; t < n; t++) {
    const gps = F[t].gps;
    if (T.valid[t] && gps > 2 && T.raw[t] > 0.3) ratios.push(T.raw[t] / gps);
  }
  if (ratios.length > 8) { ratios.sort((a, b) => a - b); T.gpsRatio = ratios[ratios.length >> 1]; }

  const f = T.f;
  const src = dev.source;
  for (let t = 0; t < n; t++) {
    if (src === 'fixed') f[t] = dev.fixed / kOut;
    else if (src === 'gps' && Number.isFinite(T.gpsRatio)) f[t] = Number.isFinite(F[t].gps) ? F[t].gps * T.gpsRatio : NaN;
    else {
      f[t] = T.raw[t];
      if (!Number.isFinite(f[t]) && Number.isFinite(T.gpsRatio) && Number.isFinite(F[t].gps)) f[t] = F[t].gps * T.gpsRatio;
    }
  }
  fillGaps(f, n, causal);

  const sm = Math.max(0, dev.smooth || 0);
  if (src !== 'fixed') {
    if (causal) {
      const a = 1 / (1 + sm);
      let e = f[0];
      for (let t = 0; t < n; t++) { e += a * (f[t] - e); f[t] = e; }
    } else {
      // less smoothing when slow: near a stop a wide window would keep the
      // strips too wide and repeat what the camera sees standing still
      const tmp = new Float32Array(n);
      median5(f, n, tmp);
      if (sm >= 0.3) {
        for (let t = 0; t < n; t++) {
          const sig = sm * clamp(Math.abs(tmp[t]) * kOut / 12, 0.12, 1);
          const r = Math.ceil(sig * 3);
          let acc = 0, ws = 0;
          for (let j = Math.max(0, t - r), b = Math.min(n - 1, t + r); j <= b; j++) {
            const w = Math.exp(-((j - t) * (j - t)) / (2 * sig * sig));
            acc += w * tmp[j]; ws += w;
          }
          f[t] = acc / ws;
        }
      } else f.set(tmp);
    }
  }

  // when the train creeps or stands, don't let smoothing keep the strips
  // open: a few px of a standing view would smear into a visible seam
  if (src === 'motion') {
    for (let t = 0; t < n; t++) {
      const r = T.raw[t];
      if (!Number.isFinite(r)) continue;
      const rOut = Math.max(0, r) * kOut;
      if (rOut < 3) f[t] = Math.min(f[t], (rOut * 1.25 + 0.03) / kOut);
    }
  }
  const u = T.u, P = T.P;
  for (let t = 0; t < n; t++) u[t] = t < n - 1 ? Math.max(0, f[t]) * kOut : 0;
  P[0] = 0;
  for (let t = 1; t < n; t++) P[t] = P[t - 1] + u[t - 1];

  // vertical stabilisation
  // Smooth the vertical path along the strip, not along time: frames shot
  // while the train stands still land on the same few columns and must agree.
  const Y = new Float32Array(n), Ys = new Float32Array(n);
  for (let t = 1; t < n; t++) Y[t] = Y[t - 1] + dyF[t - 1];
  if (causal) {
    let e = 0;
    for (let t = 0; t < n; t++) { const a = clamp(0.02 + u[Math.max(0, t - 1)] / 400, 0.02, 0.25); e += a * (Y[t] - e); Ys[t] = e; }
  } else {
    const sp = 140, st = 90, R = 240;
    for (let t = 0; t < n; t++) {
      let acc = 0, ws = 0;
      const a = Math.max(0, t - R), b = Math.min(n - 1, t + R);
      for (let j = a; j <= b; j++) {
        const dp = (P[j] - P[t]) / sp, dt = (j - t) / st;
        const w = Math.exp(-0.5 * (dp * dp + dt * dt));
        acc += w * Y[j]; ws += w;
      }
      Ys[t] = acc / ws;
    }
  }
  const st = clamp(dev.stabilize, 0, 1), M = g.M;
  for (let t = 0; t < n; t++) T.corr[t] = clamp((Y[t] - Ys[t]) * st, -M, M);

  if (!causal) {
    T.fi = clamp(Math.round(dev.trimIn * (n - 1)), 0, n - 1);
    T.fo = clamp(Math.round(dev.trimOut * (n - 1)), T.fi, n - 1);
  }
  T.L = P[T.fo] - P[T.fi];
  return T;
}

function findFrame(P, lo, hi, p) {
  if (p <= P[lo]) return lo;
  if (p >= P[hi]) return hi;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (P[mid] <= p) lo = mid; else hi = mid;
  }
  return lo;
}

/* frame index range [ta, tb] needed to render output columns [c0, c1) at scale sc */
function framesForCols(track, dev, c0, c1, sc) {
  const g = sc * dev.stretch, P0 = track.P[track.fi];
  const ta = findFrame(track.P, track.fi, track.fo, P0 + c0 / g);
  const tb = Math.min(track.fo, findFrame(track.P, track.fi, track.fo, P0 + c1 / g) + 1);
  return [ta, tb];
}

/* --------------------------------------------------------------- render
   Renders panorama columns [c0, c1) (in target px at scale sc of output px,
   time order) and target rows [r0, r1) into an RGBA buffer.
   getStrip(t) -> {data, w, h, cx, M, sx, sy} or null. Each output column
   blends the two frames whose slit positions bracket it. */

let accBuf = new Float32Array(4096 * 3);
let rowB = new Int8Array(4096), rowF = new Float32Array(4096);

/* Two ways to sample the frames around each output column:
   'smooth': every row moves with its own band's measured speed, as if the
   slit were one pixel wide and the camera ran at an infinite frame rate.
   Far layers stretch, near layers compress, nothing repeats.
   'strips': classic slit-scan. The whole column uses the chosen depth's
   speed, so layers at other depths repeat or break up. */
function renderCols(track, dev, getStrip, o) {
  const { c0, c1, r0, r1, sc, buf, bw, xMap } = o;
  const by = o.by || 0;
  const fi = track.fi, fo = track.fo;
  if (fo <= fi || c1 <= c0) return 0;
  const g = sc * dev.stretch;
  const P = track.P, u = track.u, corr = track.corr;
  const P0 = P[fi], Pend = P[fo];
  const sigma = track.sigma;
  const soft = clamp(dev.seams, 0, 1);
  const nsub = g < 1 ? Math.min(8, Math.ceil(1 / g - 1e-6)) : 1;
  const rows = r1 - r0;
  if (accBuf.length < rows * 3) accBuf = new Float32Array(rows * 3);
  if (rowB.length < rows) { rowB = new Int8Array(rows); rowF = new Float32Array(rows); }
  const acc = accBuf;
  const bu = dev.layers !== 'strips' && track.bandU ? track.bandU : null;
  if (bu) {
    // row -> pair of band centres to interpolate between
    const OH = track.OH, bh = OH / NB;
    for (let i = 0; i < rows; i++) {
      const y = (r0 + i + 0.5) / sc;
      const f = clamp(y / bh - 0.5, 0, NB - 1);
      const lo = Math.min(NB - 2, Math.floor(f));
      rowB[i] = lo; rowF[i] = f - lo;
    }
  }
  let t = findFrame(P, fi, fo, P0 + c0 / g);
  let written = 0;
  for (let cc = c0; cc < c1; cc++) {
    for (let i = 0, n3 = rows * 3; i < n3; i++) acc[i] = 0;
    let wsum = 0;
    for (let j = 0; j < nsub; j++) {
      const p = P0 + (cc + (j + 0.5) / nsub) / g;
      if (p >= Pend) break;
      while (t < fo - 1 && P[t + 1] <= p) t++;
      const ut = u[t];
      if (!(ut > 0)) continue;
      const a = (p - P[t]) / ut;
      const wB = soft < 0.01 ? (a < 0.5 ? 0 : 1) : clamp((a - 0.5) / soft + 0.5, 0, 1);
      const wA = 1 - wB;
      const bo = t * NB;
      if (wA > 0 && sampleInto(acc, getStrip(t), sigma * a, bu, bo, ut, corr[t], wA, rows, r0, sc)) wsum += wA;
      if (wB > 0 && sampleInto(acc, getStrip(t + 1), -sigma * (1 - a), bu, bo, ut, corr[t + 1], wB, rows, r0, sc)) wsum += wB;
    }
    const x = xMap(cc);
    if (wsum <= 0) continue;
    const inv = 1 / wsum;
    for (let i = 0; i < rows; i++) {
      const di = ((by + i) * bw + x) * 4;
      buf[di] = acc[i * 3] * inv;
      buf[di + 1] = acc[i * 3 + 1] * inv;
      buf[di + 2] = acc[i * 3 + 2] * inv;
      buf[di + 3] = 255;
    }
    written++;
  }
  return written;
}

/* adds one frame's contribution for a column: horizontal offset from the
   slit is k * speed(row), speed from the bands (bu) or constant ut */
function sampleInto(acc, s, k, bu, bo, ut, corrT, w, rows, r0, sc) {
  if (!s || !s.data) return false;
  const data = s.data, sw = s.w, sh = s.h, sx = s.sx, sy = s.sy;
  const xstep = sw > 1 ? 4 : 0;
  const rowStride = sw * 4;
  const step = sy / sc;
  const taps = step > 1.5 ? Math.min(4, Math.round(step)) : 1;
  const wt = w / taps;
  const base = (s.M + corrT) * sy;
  const kx = k * sx, cx = s.cx - 0.5;
  let x0 = 0, fx = 0, lastV = NaN;
  for (let i = 0; i < rows; i++) {
    const v = bu ? bu[bo + rowB[i]] * (1 - rowF[i]) + bu[bo + rowB[i] + 1] * rowF[i] : ut;
    if (v !== lastV) {
      lastV = v;
      const xs = cx + kx * v;
      if (sw < 2 || xs <= 0) { x0 = 0; fx = 0; }
      else if (xs >= sw - 1) { x0 = sw - 2; fx = 1; }
      else { x0 = Math.floor(xs); fx = xs - x0; }
    }
    const yc = ((r0 + i + 0.5) / sc) * sy + base - 0.5;
    let r = 0, g = 0, b = 0;
    for (let q = 0; q < taps; q++) {
      const ys = taps === 1 ? yc : yc + ((q + 0.5) / taps - 0.5) * step;
      let y0, fy;
      if (sh < 2 || ys <= 0) { y0 = 0; fy = 0; }
      else if (ys >= sh - 1) { y0 = sh - 2; fy = 1; }
      else { y0 = Math.floor(ys); fy = ys - y0; }
      const i00 = y0 * rowStride + x0 * 4;
      const i10 = sh > 1 ? i00 + rowStride : i00;
      const w00 = (1 - fx) * (1 - fy), w01 = fx * (1 - fy), w10 = (1 - fx) * fy, w11 = fx * fy;
      r += data[i00] * w00 + data[i00 + xstep] * w01 + data[i10] * w10 + data[i10 + xstep] * w11;
      g += data[i00 + 1] * w00 + data[i00 + 1 + xstep] * w01 + data[i10 + 1] * w10 + data[i10 + 1 + xstep] * w11;
      b += data[i00 + 2] * w00 + data[i00 + 2 + xstep] * w01 + data[i10 + 2] * w10 + data[i10 + 2 + xstep] * w11;
    }
    acc[i * 3] += r * wt;
    acc[i * 3 + 1] += g * wt;
    acc[i * 3 + 2] += b * wt;
  }
  return true;
}

/* ------------------------------------------------------------------ PNG
   Streaming PNG writer: any width, rows supplied in bands, deflate via
   CompressionStream. Produces one continuous image even at 100 000 px. */

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(bytes, crc = 0xffffffff) {
  for (let i = 0; i < bytes.length; i++) crc = CRC_TABLE[(crc ^ bytes[i]) & 0xff] ^ (crc >>> 8);
  return crc;
}

function pngChunk(type, data) {
  const out = new Uint8Array(12 + data.length);
  const dv = new DataView(out.buffer);
  dv.setUint32(0, data.length);
  for (let i = 0; i < 4; i++) out[4 + i] = type.charCodeAt(i);
  out.set(data, 8);
  const crc = crc32(out.subarray(4, 8 + data.length)) ^ 0xffffffff;
  dv.setUint32(8 + data.length, crc >>> 0);
  return out;
}

/* rowsProvider(y0, y1) -> Promise<Uint8ClampedArray RGBA of width*(y1-y0)> */
async function writePNG(width, height, bandRows, rowsProvider, onProgress, isCancelled) {
  if (typeof CompressionStream === 'undefined') throw new Error('no-compression');
  const parts = [new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10])];
  const ihdr = new Uint8Array(13);
  const dv = new DataView(ihdr.buffer);
  dv.setUint32(0, width); dv.setUint32(4, height);
  ihdr[8] = 8; ihdr[9] = 2; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  parts.push(pngChunk('IHDR', ihdr));

  const cs = new CompressionStream('deflate');
  const writer = cs.writable.getWriter();
  const reader = cs.readable.getReader();
  const IDAT_MAX = 1 << 20;
  let pend = [], pendLen = 0;
  const flush = () => {
    if (!pendLen) return;
    const data = new Uint8Array(pendLen);
    let o = 0;
    for (const p of pend) { data.set(p, o); o += p.length; }
    parts.push(pngChunk('IDAT', data));
    pend = []; pendLen = 0;
  };
  const readAll = (async () => {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      pend.push(value); pendLen += value.length;
      if (pendLen >= IDAT_MAX) flush();
    }
    flush();
  })();

  const rowLen = width * 3 + 1;
  for (let y0 = 0; y0 < height; y0 += bandRows) {
    if (isCancelled && isCancelled()) { try { await writer.abort(); } catch (e) {} throw new Error('cancelled'); }
    const y1 = Math.min(height, y0 + bandRows);
    const rgba = await rowsProvider(y0, y1);
    const n = y1 - y0;
    const out = new Uint8Array(rowLen * n);
    for (let r = 0; r < n; r++) {
      const o = r * rowLen, s = r * width * 4;
      out[o] = 1; // Sub filter
      let pr = 0, pg = 0, pb = 0;
      for (let x = 0; x < width; x++) {
        const si = s + x * 4, oi = o + 1 + x * 3;
        const R = rgba[si], G = rgba[si + 1], B = rgba[si + 2];
        out[oi] = (R - pr) & 255; out[oi + 1] = (G - pg) & 255; out[oi + 2] = (B - pb) & 255;
        pr = R; pg = G; pb = B;
      }
    }
    await writer.write(out);
    if (onProgress) onProgress(y1 / height);
  }
  await writer.close();
  await readAll;
  parts.push(pngChunk('IEND', new Uint8Array(0)));
  return new Blob(parts, { type: 'image/png' });
}

const api = {
  NB, CONF_MIN, clamp, Analyzer, computeTrack, detectDirection, findFrame, framesForCols,
  renderCols, refineMotion, weightedPercentile, layerPick, gaussSmooth, writePNG, crc32,
};
root.FBEngine = api;
if (typeof module !== 'undefined') module.exports = api;
})(typeof window !== 'undefined' ? window : globalThis);
