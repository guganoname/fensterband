/* Demo ride: a procedurally drawn view from a train window with true
   perspective (sky, mountains, hills, fields, trees, a station stop).
   Every object sits at a real distance, so the parallax is physical. */
(function (root) {
'use strict';

function hash(i, s) {
  let h = (i | 0) * 374761393 + (s | 0) * 668265263;
  h = (h ^ (h >>> 13)) * 1274126177;
  h = h ^ (h >>> 16);
  return (h >>> 0) / 4294967296;
}
function vnoise(x, s) {
  const i = Math.floor(x), f = x - i, u = f * f * (3 - 2 * f);
  return hash(i, s) * (1 - u) + hash(i + 1, s) * u;
}
function fbm(x, s) { return 0.55 * vnoise(x, s) + 0.3 * vnoise(x * 2.1, s + 7) + 0.15 * vnoise(x * 4.3, s + 13); }

const FIELD = ['#7f9a4f', '#9aab5a', '#c5b46a', '#b9a15c', '#8a7450', '#6f8d48', '#a7b26a', '#d3c27a'];

class DemoRide {
  constructor(w, h) {
    this.w = w || 1600; this.h = h || 900;
    this.canvas = makeCanvas(this.w, this.h);
    this.ctx = this.canvas.getContext('2d');
    this.f = this.w / (2 * Math.tan(32 * Math.PI / 180));
    this.cx = this.w / 2; this.cy0 = this.h * 0.4;
    this.camY = 2.4;
    this.duration = 16;
    this.fps = 30;
    this.name = 'Demo ride';
    // motion profile: cruise, brake into a station, wait, pull away
    const dt = 1 / 240, n = Math.ceil(this.duration / dt) + 2;
    this.xs = new Float64Array(n);
    let x = 0;
    for (let i = 0; i < n; i++) { this.xs[i] = x; x += this.speed(i * dt) * dt; }
    this.dt = dt;
    this.stopX = this.pos(9.6);
    this.X0 = 0;
    // textures
    this.grass = noiseTexture(256, 64, [70, 90, 40], 26, 3);
    this.gravel = noiseTexture(256, 64, [120, 112, 100], 40, 11);
    this.slab = noiseTexture(256, 64, [168, 166, 158], 14, 5);
    this.patGrass = this.ctx.createPattern(this.grass, 'repeat');
    this.patGravel = this.ctx.createPattern(this.gravel, 'repeat');
    this.patSlab = this.ctx.createPattern(this.slab, 'repeat');
    this.field = fieldTexture(256, 128, 17);
    this.patField = this.ctx.createPattern(this.field, 'repeat');
    this.objects = this._objects();
  }

  speed(t) {
    if (t < 4.5) return 30;
    if (t < 9.3) return 30 * 0.5 * (1 + Math.cos(Math.PI * (t - 4.5) / 4.8));
    if (t < 10.6) return 0;
    const a = Math.min(1, (t - 10.6) / 5);
    return 27 * 0.5 * (1 - Math.cos(Math.PI * a));
  }
  pos(t) {
    const i = Math.max(0, Math.min(this.xs.length - 2, Math.floor(t / this.dt)));
    const f = t / this.dt - i;
    return this.xs[i] * (1 - f) + this.xs[i + 1] * f;
  }

  _objects() {
    const objs = [];
    const X1 = this.pos(this.duration) + 400, X0 = -400;
    const sx = this.stopX;
    for (let c = Math.floor(X0 / 18); c < X1 / 18; c++) {
      const r = hash(c, 1);
      const X = c * 18 + hash(c, 2) * 14;
      const nearStation = Math.abs(X - sx) < 90;
      if (r < 0.55) {
        const Z = 60 + hash(c, 3) * 260;
        objs.push({ k: hash(c, 4) < 0.25 ? 'poplar' : 'tree', X, Z, s: 0.7 + hash(c, 5) * 0.7, tone: hash(c, 6) });
      }
      if (r > 0.3 && r < 0.62) {
        const Z = 26 + hash(c, 14) * 70;
        objs.push({ k: 'tree', X: X + 9, Z, s: 0.45 + hash(c, 15) * 0.5, tone: hash(c, 16) });
      }
      if (!nearStation && r > 0.8) {
        const Z = 16 + hash(c, 7) * 30;
        objs.push({ k: 'tree', X: X + 6, Z, s: 0.6 + hash(c, 8) * 0.6, tone: hash(c, 9) });
      }
      if (hash(c, 10) > 0.9) {
        const Z = 90 + hash(c, 11) * 160;
        objs.push({ k: 'house', X: X + 4, Z, s: 0.9 + hash(c, 12) * 0.5, tone: hash(c, 13) });
      }
    }
    objs.push({ k: 'steeple', X: sx + 160, Z: 210, s: 1, tone: 0.3 });
    objs.push({ k: 'station', X: sx + 2, Z: 27, s: 1, tone: 0 });
    for (let i = -4; i <= 4; i++) objs.push({ k: 'lamp', X: sx + i * 19 + 5, Z: 10.5, s: 1, tone: 0 });
    objs.push({ k: 'sign', X: sx - 2.5, Z: 9, s: 1, tone: 0 });
    objs.push({ k: 'sign', X: sx + 34, Z: 9, s: 1, tone: 0 });
    objs.push({ k: 'sign', X: sx - 40, Z: 9, s: 1, tone: 0 });
    for (let X = X0; X < X1; X += 63) objs.push({ k: 'pole', X: X + 11, Z: 5.4, s: 1, tone: 0 });
    objs.sort((a, b) => b.Z - a.Z);
    return objs;
  }

  // world -> screen
  sx(X, Z) { return this.cx + this.f * (X - this.xc) / Z; }
  sy(Y, Z) { return this.cy + this.f * (this.camY - Y) / Z; }

  render(t) {
    const c = this.ctx, W = this.w, H = this.h, f = this.f;
    this.xc = this.pos(t);
    const v = this.speed(t);
    // the carriage shakes more at speed
    const shake = 0.6 + v / 30 * 2.4;
    this.cy = this.cy0 + shake * (Math.sin(t * 8.2) * 0.8 + Math.sin(t * 21.7 + 1) * 0.45) + Math.sin(t * 1.3) * 3;
    const cy = this.cy;
    c.setTransform(1, 0, 0, 1, 0, 0);
    c.globalAlpha = 1;

    // sky
    const sky = c.createLinearGradient(0, 0, 0, cy + 30);
    sky.addColorStop(0, '#6f93bd'); sky.addColorStop(0.55, '#a9c0d4'); sky.addColorStop(1, '#ead9bd');
    c.fillStyle = sky; c.fillRect(0, 0, W, cy + 40);
    // clouds, very far
    c.fillStyle = 'rgba(255,255,255,0.55)';
    for (let i = Math.floor((this.xc - 4000) / 700); i < (this.xc + 4000) / 700; i++) {
      const X = i * 700 + hash(i, 40) * 500, Z = 5200, Yc = 900 + hash(i, 41) * 900;
      const x = this.sx(X, Z), y = this.sy(Yc, Z);
      if (x < -400 || x > W + 400) continue;
      const s = 0.6 + hash(i, 42);
      for (let k = 0; k < 5; k++) {
        c.beginPath();
        c.ellipse(x + (k - 2) * 46 * s, y + Math.sin(k * 2.3) * 9 * s, 70 * s, 20 * s, 0, 0, Math.PI * 2);
        c.fill();
      }
    }

    // mountains, hills
    this._ridge(3200, 180, 760, 1500, 21, '#8e9fbc', '#b7c1cf');
    this._ridge(1100, 40, 70, 260, 22, '#6f8580', '#8a9a90', 0.25);
    this._ridge(480, 12, 30, 90, 23, '#56705a', '#6c8466', 0.6);

    // ground: textured perspective rows
    const yStart = Math.max(0, Math.ceil(cy + f * this.camY / 470));
    for (let y = yStart; y < H; y++) {
      const Z = f * this.camY / (y + 0.5 - cy);
      if (Z < 0) continue;
      const xL = this.xc + (0 - this.cx) * Z / f, xR = this.xc + (W - this.cx) * Z / f;
      let pat, base;
      if (Z < 7.6) { pat = this.patGravel; base = '#857b6d'; }
      else if (Z < 13) { pat = this.patGrass; base = '#6c7d43'; }
      else {
        // fields: rows of plots with hedges between
        const iz = Math.floor(Math.log(Z / 13) / Math.log(1.55));
        const len = 70 + hash(iz, 30) * 90;
        let a = Math.floor(xL / len);
        for (; a * len < xR; a++) {
          const X0 = a * len, X1 = X0 + len;
          const x0 = this.sx(X0, Z), x1 = this.sx(X1, Z);
          c.fillStyle = FIELD[Math.floor(hash(a, iz * 31 + 5) * FIELD.length)];
          c.fillRect(Math.floor(x0), y, Math.ceil(x1 - x0) + 1, 1);
          const hw = Math.max(1, f * 1.6 / Z);
          c.fillStyle = '#3e5232';
          c.fillRect(x1 - hw / 2, y, hw, 1);
        }
        pat = this.patField; base = null;
      }
      if (base) { c.fillStyle = base; c.fillRect(0, y, W, 1); }
      const tpm = base ? 22 : 5; // texture px per metre
      const sxs = f / (Z * tpm);
      pat.setTransform(new DOMMatrix([sxs, 0, 0, 1, this.cx - f * this.xc / Z, y - (Math.floor(Z * (base ? 9 : 2)) % (base ? 64 : 128))]));
      c.globalAlpha = base ? 0.9 : 0.5;
      if (!base) c.globalCompositeOperation = 'overlay';
      c.fillStyle = pat;
      c.fillRect(0, y, W, 1);
      c.globalCompositeOperation = 'source-over';
      c.globalAlpha = 1;
    }

    // platform at the station
    const pa = this.stopX - 120, pb = this.stopX + 120;
    if (this.sx(pb, 4.3) > 0 && this.sx(pa, 14) < W) {
      for (let y = Math.max(0, Math.floor(this.sy(0.9, 15))); y < H; y++) {
        const Z = f * (this.camY - 0.9) / (y + 0.5 - cy);
        if (Z < 4.3 || Z > 15) continue;
        const x0 = this.sx(pa, Z), x1 = this.sx(pb, Z);
        if (x1 < 0 || x0 > W) continue;
        const near = Z < 4.75;
        if (near) c.fillStyle = Z < 4.5 ? '#e8e3d6' : '#f0c419';
        else {
          this.patSlab.setTransform(new DOMMatrix([f / (Z * 22), 0, 0, 1, this.cx - f * this.xc / Z, y - (Math.floor(Z * 13) % 64)]));
          c.fillStyle = this.patSlab;
        }
        c.fillRect(Math.max(0, x0), y, Math.min(W, x1) - Math.max(0, x0), 1);
      }
    }

    // objects, far to near
    for (const o of this.objects) {
      const s = this.f / o.Z;
      const x = this.sx(o.X, o.Z);
      if (x < -60 * s - 50 || x > W + 60 * s + 50) continue;
      this['_' + o.k](o, x, s);
    }
    return this.canvas;
  }

  _ridge(Z, hMin, hMax, scale, seed, col, haze, tex) {
    const c = this.ctx, W = this.w;
    c.beginPath();
    c.moveTo(-4, this.h);
    for (let x = -4; x <= W + 8; x += 6) {
      const X = this.xc + (x - this.cx) * Z / this.f;
      let hgt = hMin + (hMax - hMin) * fbm(X / scale, seed);
      if (tex) hgt += tex * 9 * (vnoise(X / 9, seed + 50) - 0.5) * (hMax / 70);
      c.lineTo(x, this.sy(hgt, Z));
    }
    c.lineTo(W + 8, this.h);
    c.closePath();
    const yTop = this.sy(hMax, Z), yBot = this.sy(0, Z);
    const g = c.createLinearGradient(0, yTop, 0, yBot);
    g.addColorStop(0, col); g.addColorStop(1, haze);
    c.fillStyle = g;
    c.fill();
  }

  _tree(o, x, s) {
    const c = this.ctx;
    const hgt = 11 * o.s, rad = 3.6 * o.s;
    const yb = this.sy(0, o.Z), yc = this.sy(hgt - rad, o.Z);
    c.fillStyle = '#4a3b2c';
    c.fillRect(x - 0.25 * s, yc, 0.5 * s, yb - yc);
    const light = o.Z > 150 ? 0.25 : 0;
    const tones = ['#3f5f33', '#4d6b39', '#5b7741', '#36522f'];
    c.fillStyle = mix(tones[Math.floor(o.tone * tones.length)], '#a9b8b0', light);
    c.beginPath();
    c.ellipse(x, yc, rad * s * 1.05, rad * s, 0, 0, Math.PI * 2);
    c.ellipse(x - rad * s * 0.55, yc + rad * s * 0.35, rad * s * 0.7, rad * s * 0.6, 0, 0, Math.PI * 2);
    c.ellipse(x + rad * s * 0.6, yc + rad * s * 0.3, rad * s * 0.7, rad * s * 0.62, 0, 0, Math.PI * 2);
    c.fill();
    c.fillStyle = 'rgba(255,240,200,0.12)';
    c.beginPath();
    c.ellipse(x - rad * s * 0.3, yc - rad * s * 0.35, rad * s * 0.55, rad * s * 0.45, 0, 0, Math.PI * 2);
    c.fill();
  }
  _poplar(o, x, s) {
    const c = this.ctx;
    const hgt = 18 * o.s, yb = this.sy(0, o.Z), yt = this.sy(hgt, o.Z);
    c.fillStyle = mix('#3d5a34', '#a9b8b0', o.Z > 150 ? 0.25 : 0);
    c.beginPath();
    c.ellipse(x, (yb + yt) / 2 - 0.1 * (yb - yt), 1.7 * o.s * s, (yb - yt) / 2, 0, 0, Math.PI * 2);
    c.fill();
  }
  _house(o, x, s) {
    const c = this.ctx;
    const w = 9 * o.s, hw = 5 * o.s, rh = 3.5 * o.s;
    const x0 = x - w / 2 * s, x1 = x + w / 2 * s;
    const yb = this.sy(0, o.Z), yw = this.sy(hw, o.Z), yr = this.sy(hw + rh, o.Z);
    c.fillStyle = mix(o.tone > 0.5 ? '#e7dfcf' : '#d9c6a6', '#b8c0c6', o.Z > 160 ? 0.3 : 0.1);
    c.fillRect(x0, yw, x1 - x0, yb - yw);
    c.fillStyle = o.tone > 0.35 ? '#9b4a32' : '#5b5f66';
    c.beginPath();
    c.moveTo(x0 - 0.6 * s, yw); c.lineTo(x, yr); c.lineTo(x1 + 0.6 * s, yw); c.closePath(); c.fill();
    c.fillStyle = '#3d4249';
    for (let i = 0; i < 3; i++) c.fillRect(x0 + (1.3 + i * 2.6) * o.s * s, this.sy(hw * 0.62, o.Z), 1.1 * s, 1.2 * s);
  }
  _steeple(o, x, s) {
    const c = this.ctx;
    const yb = this.sy(0, o.Z), yt = this.sy(24, o.Z), yp = this.sy(36, o.Z);
    c.fillStyle = '#d9d2c3';
    c.fillRect(x - 2.6 * s, yt, 5.2 * s, yb - yt);
    c.fillStyle = '#55606a';
    c.beginPath(); c.moveTo(x - 3 * s, yt); c.lineTo(x, yp); c.lineTo(x + 3 * s, yt); c.closePath(); c.fill();
    c.fillStyle = '#2e3338';
    c.beginPath(); c.arc(x, this.sy(19, o.Z), 1.2 * s, 0, Math.PI * 2); c.fill();
  }
  _station(o, x, s) {
    const c = this.ctx;
    const w = 34, h = 8.5;
    const x0 = x - w / 2 * s, x1 = x + w / 2 * s, yb = this.sy(0.9, o.Z), yt = this.sy(h, o.Z), yr = this.sy(h + 2.4, o.Z);
    c.fillStyle = '#c99a5b';
    c.fillRect(x0, yt, x1 - x0, yb - yt);
    c.fillStyle = '#4b3f37';
    c.beginPath(); c.moveTo(x0 - s, yt); c.lineTo(x0 + 2 * s, yr); c.lineTo(x1 - 2 * s, yr); c.lineTo(x1 + s, yt); c.closePath(); c.fill();
    c.fillStyle = '#efe7d7';
    c.fillRect(x0, this.sy(h - 0.6, o.Z), x1 - x0, 0.25 * s);
    for (let i = 0; i < 9; i++) {
      const wx = x0 + (1.6 + i * 3.6) * s;
      c.fillStyle = '#2f3a42';
      c.fillRect(wx, this.sy(4.2, o.Z), 1.9 * s, 2.4 * s);
      if (i !== 4) c.fillRect(wx, this.sy(7.4, o.Z), 1.9 * s, 1.7 * s);
    }
    c.fillStyle = '#6b4a2e';
    c.fillRect(x - 1.2 * s, this.sy(3.3, o.Z), 2.4 * s, yb - this.sy(3.3, o.Z));
    c.fillStyle = '#1f2c3a';
    c.font = `600 ${Math.round(1.45 * s)}px Overpass, "Helvetica Neue", Arial, sans-serif`;
    c.textAlign = 'center'; c.textBaseline = 'middle';
    c.fillText('FENSTERHAUSEN', x, this.sy(5.6, o.Z));
  }
  _lamp(o, x, s) {
    const c = this.ctx;
    const yb = this.sy(0.9, o.Z), yt = this.sy(5.2, o.Z);
    c.fillStyle = '#3a4046';
    c.fillRect(x - 0.07 * s, yt, 0.14 * s, yb - yt);
    c.fillRect(x - 0.07 * s, yt, 0.9 * s, 0.12 * s);
    c.fillStyle = '#f4ead1';
    c.fillRect(x + 0.6 * s, yt + 0.1 * s, 0.4 * s, 0.14 * s);
  }
  _sign(o, x, s) {
    const c = this.ctx;
    const yb = this.sy(0.9, o.Z), y0 = this.sy(3.1, o.Z), y1 = this.sy(2.4, o.Z);
    c.fillStyle = '#4b5258';
    c.fillRect(x - 1.3 * s, y0, 0.1 * s, yb - y0);
    c.fillRect(x + 1.2 * s, y0, 0.1 * s, yb - y0);
    c.fillStyle = '#18365c';
    c.fillRect(x - 1.5 * s, y0, 3 * s, y1 - y0);
    c.fillStyle = '#ffffff';
    c.font = `600 ${Math.round(0.36 * s)}px Overpass, "Helvetica Neue", Arial, sans-serif`;
    c.textAlign = 'center'; c.textBaseline = 'middle';
    c.fillText('Fensterhausen', x, (y0 + y1) / 2 + 0.02 * s);
  }
  _pole(o, x, s) {
    const c = this.ctx;
    const yb = this.sy(0, o.Z), yt = this.sy(8, o.Z);
    c.fillStyle = '#5a6066';
    c.fillRect(x - 0.13 * s, yt, 0.26 * s, yb - yt);
    c.fillStyle = 'rgba(0,0,0,0.18)';
    c.fillRect(x + 0.05 * s, yt, 0.08 * s, yb - yt);
  }
}

function mix(a, b, t) {
  if (!t) return a;
  const pa = parseInt(a.slice(1), 16), pb = parseInt(b.slice(1), 16);
  const r = Math.round(((pa >> 16) & 255) * (1 - t) + ((pb >> 16) & 255) * t);
  const g = Math.round(((pa >> 8) & 255) * (1 - t) + ((pb >> 8) & 255) * t);
  const bl = Math.round((pa & 255) * (1 - t) + (pb & 255) * t);
  return `rgb(${r},${g},${bl})`;
}

function makeCanvas(w, h) {
  if (typeof document !== 'undefined') { const c = document.createElement('canvas'); c.width = w; c.height = h; return c; }
  return new OffscreenCanvas(w, h);
}

function vn2(x, y, s) {
  const xi = Math.floor(x), yi = Math.floor(y), fx = x - xi, fy = y - yi;
  const ux = fx * fx * (3 - 2 * fx), uy = fy * fy * (3 - 2 * fy);
  const h = (a, b) => hash(a * 7919 + b * 104729, s);
  return (h(xi, yi) * (1 - ux) + h(xi + 1, yi) * ux) * (1 - uy) + (h(xi, yi + 1) * (1 - ux) + h(xi + 1, yi + 1) * ux) * uy;
}
function fieldTexture(w, h, seed) {
  const cv = makeCanvas(w, h), c = cv.getContext('2d');
  const img = c.createImageData(w, h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const n = 0.55 * vn2(x / 9, y / 9, seed) + 0.3 * vn2(x / 3.5, y / 3.5, seed + 1) + 0.15 * hash(x * 13 + y * 977, seed + 2);
    const furrow = 0.5 + 0.5 * Math.sin(x * 0.7 + vn2(x / 20, y / 20, seed + 3) * 4);
    const v = (n - 0.5) * 120 + (furrow - 0.5) * 40;
    const i = (y * w + x) * 4;
    img.data[i] = 128 + v; img.data[i + 1] = 128 + v; img.data[i + 2] = 128 + v * 0.8; img.data[i + 3] = 255;
  }
  c.putImageData(img, 0, 0);
  return cv;
}
function noiseTexture(w, h, rgb, amp, seed) {
  const cv = makeCanvas(w, h), c = cv.getContext('2d');
  const img = c.createImageData(w, h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const n = (hash(x * 7 + y * 131, seed) - 0.5) * amp + (vnoise(x / 6 + y * 3.1, seed + 3) - 0.5) * amp;
    const i = (y * w + x) * 4;
    img.data[i] = rgb[0] + n; img.data[i + 1] = rgb[1] + n * 1.1; img.data[i + 2] = rgb[2] + n * 0.8; img.data[i + 3] = 255;
  }
  c.putImageData(img, 0, 0);
  return cv;
}

root.FBDemo = { DemoRide };
})(typeof window !== 'undefined' ? window : globalThis);
