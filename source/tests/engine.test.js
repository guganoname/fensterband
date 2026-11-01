// Node tests for the Fensterband engine.
const E = require('../src/engine.js');
const assert = (c, m) => { if (!c) { console.error('FAIL', m); process.exitCode = 1; } else console.log('ok  ', m); };

// deterministic noise texture, smoothed
function rng(seed) { let s = seed >>> 0; return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 4294967296); }
function makeTexture(w, h, seed) {
  const r = rng(seed), a = new Float32Array(w * h);
  for (let i = 0; i < a.length; i++) a[i] = r();
  const b = new Float32Array(w * h), tmp = new Float32Array(w * h);
  // blur twice for structure ~4px
  for (let pass = 0; pass < 2; pass++) {
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      let s = 0; for (let k = -2; k <= 2; k++) s += a[y * w + ((x + k + w) % w)]; tmp[y * w + x] = s / 5;
    }
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      let s = 0; for (let k = -2; k <= 2; k++) s += tmp[Math.min(h - 1, Math.max(0, y + k)) * w + x]; b[y * w + x] = s / 5;
    }
    a.set(b);
  }
  let mn = Infinity, mx = -Infinity; for (const v of a) { mn = Math.min(mn, v); mx = Math.max(mx, v); }
  for (let i = 0; i < a.length; i++) a[i] = (a[i] - mn) / (mx - mn) * 255;
  return a;
}
function sampleTex(tex, tw, th, x, y) {
  x = ((x % tw) + tw) % tw; y = Math.max(0, Math.min(th - 1.001, y));
  const x0 = Math.floor(x), y0 = Math.floor(y), fx = x - x0, fy = y - y0, x1 = (x0 + 1) % tw;
  const a = tex[y0 * tw + x0], b = tex[y0 * tw + x1], c = tex[(y0 + 1) * tw + x0], d = tex[(y0 + 1) * tw + x1];
  return a * (1 - fx) * (1 - fy) + b * fx * (1 - fy) + c * (1 - fx) * fy + d * fx * fy;
}

// ---------- analyzer: six bands with different speeds + vertical jitter
{
  const W = 384, H = 216, TW = 4096, TH = 256;
  const tex = makeTexture(TW, TH, 7);
  const speeds = [-1.5, -3.2, -6.1, -9.7, -14.3, -22.6]; // content moves left
  const cy0 = 0.1, cy1 = 0.9;
  const an = new E.Analyzer(W, H);
  const out = new Float32Array(E.NB * 3);
  const errs = speeds.map(() => []);
  const dyErr = [];
  let prevJ = 0, prior = null;
  for (let t = 0; t < 40; t++) {
    const jit = 2.3 * Math.sin(t * 1.7);
    const rgba = new Uint8ClampedArray(W * H * 4);
    for (let y = 0; y < H; y++) {
      const fy = (y / H - cy0) / (cy1 - cy0);
      const b = Math.max(0, Math.min(5, Math.floor(fy * 6)));
      for (let x = 0; x < W; x++) {
        const v = sampleTex(tex, TW, TH, x - speeds[b] * t + b * 600, y - jit + 20) + (Math.random() - 0.5) * 6;
        const i = (y * W + x) * 4; rgba[i] = rgba[i + 1] = rgba[i + 2] = v; rgba[i + 3] = 255;
      }
    }
    an.push(rgba);
    if (an.estimate(cy0, cy1, prior, out)) {
      prior = new Float32Array(E.NB);
      for (let b = 0; b < 6; b++) {
        prior[b] = out[b * 3];
        errs[b].push(Math.abs(out[b * 3] - speeds[b]));
      }
      const dyTrue = jit - prevJ;
      const dys = [0, 1, 2, 3, 4, 5].map(b => out[b * 3 + 1]).sort((a, b) => a - b);
      dyErr.push(Math.abs((dys[2] + dys[3]) / 2 - dyTrue));
      if (t === 20) console.log('     sample bands', Array.from(out).map(v => v.toFixed(2)).join(' '));
    }
    prevJ = jit;
  }
  speeds.forEach((s, b) => {
    const e = errs[b].reduce((a, c) => a + c, 0) / errs[b].length;
    assert(e < 0.25, `band ${b} speed ${s}: mean abs err ${e.toFixed(3)} px`);
  });
  const de = dyErr.reduce((a, c) => a + c, 0) / dyErr.length;
  assert(de < 0.3, `vertical jitter mean abs err ${de.toFixed(3)} px`);
}

// ---------- flat image -> low confidence
{
  const W = 384, H = 216, an = new E.Analyzer(W, H), out = new Float32Array(18);
  for (let t = 0; t < 3; t++) {
    const rgba = new Uint8ClampedArray(W * H * 4).fill(128);
    for (let i = 0; i < rgba.length; i += 4) { const n = (Math.random() - 0.5) * 3; rgba[i] += n; rgba[i + 1] += n; rgba[i + 2] += n; }
    an.push(rgba); an.estimate(0.1, 0.9, null, out);
  }
  const maxc = Math.max(...[0, 1, 2, 3, 4, 5].map(b => out[b * 3 + 2]));
  assert(maxc < 0.12, `flat sky gives low confidence (max ${maxc.toFixed(3)})`);
}

// ---------- weighted percentile
{
  const v = new Float32Array([5, 1, 9]), w = new Float32Array([1, 1, 1]);
  assert(E.weightedPercentile(v, w, 3, 0) === 1 && E.weightedPercentile(v, w, 3, 1) === 9 && Math.abs(E.weightedPercentile(v, w, 3, 0.5) - 5) < 1e-6, 'weighted percentile endpoints + median');
}

// ---------- track + render reconstructs a uniformly moving texture
{
  const OH = 64, TW = 3000, TH = OH + 20;
  const tex = makeTexture(TW, TH, 3);
  const n = 60, v = 7.3, capW = 300, slit = 150, M = 4;
  const frames = [];
  const strips = [];
  for (let t = 0; t < n; t++) {
    // content moves left by v per frame: image x shows world X = x + v t
    const data = new Uint8ClampedArray(capW * (OH + 2 * M) * 4);
    for (let y = 0; y < OH + 2 * M; y++) for (let x = 0; x < capW; x++) {
      const val = sampleTex(tex, TW, TH, x + 0.5 + v * t - 0.5, y + 4);
      const i = (y * capW + x) * 4; data[i] = data[i + 1] = data[i + 2] = val; data[i + 3] = 255;
    }
    strips.push({ data, w: capW, h: OH + 2 * M, cx: slit, M, sx: 1, sy: 1 });
    const bands = new Float32Array(18);
    for (let b = 0; b < 6; b++) { bands[b * 3] = -v / 2; bands[b * 3 + 1] = 0; bands[b * 3 + 2] = 1; }
    frames.push({ t: t / 30, bands, gps: NaN });
  }
  const sess = { frames, geom: { kOut: 2, M, OH } };
  const dev = { depth: 0.5, lockBand: -1, smooth: 0, stabilize: 0, seams: 0.5, stretch: 1, source: 'motion', fixed: 10, trimIn: 0, trimOut: 1, direction: 'auto' };
  const tr = E.computeTrack(sess, dev);
  assert(tr.sigma === 1, 'direction detected: scenery moving left');
  assert(Math.abs(tr.u[10] - v) < 1e-4, `strip width equals motion (${tr.u[10].toFixed(3)})`);
  const Wt = Math.floor(tr.L);
  const buf = new Uint8ClampedArray(Wt * OH * 4);
  E.renderCols(tr, dev, i => strips[i], { c0: 0, c1: Wt, r0: 0, r1: OH, sc: 1, buf, bw: Wt, xMap: c => c });
  let err = 0, cnt = 0;
  for (let c = 0; c < Wt; c += 3) for (let y = 0; y < OH; y += 2) {
    const want = sampleTex(tex, TW, TH, slit + c + 0.5 - 0.5, y + 4 + M);
    err += Math.abs(buf[(y * Wt + c) * 4] - want); cnt++;
  }
  assert(err / cnt < 1.2, `rendered panorama matches world texture (mean err ${(err / cnt).toFixed(2)} of 255)`);

  // mirrored direction reconstructs too
  const dev2 = Object.assign({}, dev, { direction: 'right' });
  const tr2 = E.computeTrack(sess, dev2);
  assert(tr2.sigma === -1 && tr2.u[5] === 0, 'forced wrong direction yields no forward motion');

  // stretch 0.5 halves width
  const dev3 = Object.assign({}, dev, { stretch: 0.5 });
  const W3 = Math.floor(tr.L * 0.5), buf3 = new Uint8ClampedArray(W3 * OH * 4);
  const wr = E.renderCols(tr, dev3, i => strips[i], { c0: 0, c1: W3, r0: 0, r1: OH, sc: 1, buf: buf3, bw: W3, xMap: c => c });
  assert(wr === W3, `stretch 0.5 renders ${wr}/${W3} columns`);
}

// ---------- PNG writer round trip (checked by python afterwards)
(async () => {
  const w = 40000, h = 12;
  const blob = await E.writePNG(w, h, 5, async (y0, y1) => {
    const a = new Uint8ClampedArray(w * (y1 - y0) * 4);
    for (let y = y0; y < y1; y++) for (let x = 0; x < w; x++) { const i = ((y - y0) * w + x) * 4; a[i] = x & 255; a[i + 1] = y * 20; a[i + 2] = (x >> 8) & 255; a[i + 3] = 255; }
    return a;
  });
  const fs = require('fs');
  fs.writeFileSync(__dirname + '/out_wide.png', Buffer.from(await blob.arrayBuffer()));
  console.log('ok   wrote out_wide.png', blob.size, 'bytes');
})();

// ---------- full-resolution motion refinement on strips
{
  const OH = 300, M = 18, H = OH + 2 * M, TW = 2000, TH = 600;
  const tex = makeTexture(TW, TH, 11);
  const mkStrip = (offX, offY, w, cx) => {
    const data = new Uint8ClampedArray(w * H * 4);
    for (let y = 0; y < H; y++) for (let x = 0; x < w; x++) {
      const v = sampleTex(tex, TW, TH, x - cx + 700 - offX, y + 100 - offY);
      const i = (y * w + x) * 4; data[i] = data[i + 1] = data[i + 2] = v; data[i + 3] = 255;
    }
    return { data, w, h: H, cx };
  };
  const trueDx = [-3.37, -5.81, -9.12, -12.4, -18.66, -27.3], dy = -1.6;
  const prev = mkStrip(0, 0, 140, 70.4);
  const errsX = [], kOut = 4;
  // build cur per band with its own dx: rows of band b shifted by trueDx[b]
  const cur = { data: new Uint8ClampedArray(120 * H * 4), w: 120, h: H, cx: 60.2 };
  for (let y = 0; y < H; y++) {
    const b = Math.max(0, Math.min(5, Math.floor((y - M) / (OH / 6))));
    for (let x = 0; x < 120; x++) {
      const v = sampleTex(tex, TW, TH, x - cur.cx + 700 - trueDx[b], y + 100 - dy);
      const i = (y * 120 + x) * 4; cur.data[i] = cur.data[i + 1] = cur.data[i + 2] = v; cur.data[i + 3] = 255;
    }
  }
  const bands = new Float32Array(18);
  for (let b = 0; b < 6; b++) { bands[b * 3] = (trueDx[b] + 0.6) / kOut; bands[b * 3 + 1] = (dy + 0.4) / kOut; bands[b * 3 + 2] = 1; }
  const r = E.refineMotion(prev, cur, bands, OH, M, kOut);
  for (let b = 0; b < 6; b++) errsX.push(Math.abs(r.dx[b] - trueDx[b]));
  console.log("     refined", Array.from(r.dx).map(v => v.toFixed(2)).join(" "));
  assert(Math.max(...errsX) < 0.15, `refined band motion within 0.15 px (max err ${Math.max(...errsX).toFixed(3)})`);
  assert(Math.abs(r.dy - dy) < 0.15, `refined vertical shift ${r.dy.toFixed(3)} vs ${dy}`);
}
