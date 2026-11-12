// photo-geolocator-01 entry — model-free.
// Places each of the 25 street photos from its pixels alone: no model calls,
// no API key, no network beyond the env. How it works:
//   1. A small baseline-JPEG decoder written here (stdlib only) turns each
//      photo into RGB. JPEGs in this competition are baseline, 8-bit, 1 or 3
//      components; restart markers are honoured.
//   2. From a 256x144 sample of the photo it measures zone colour fractions
//      (sky, vegetation, tan/arid ground, red dirt, yellow lane paint, white
//      lane paint, snow-bright ground, dark forest, water, grey road) and a
//      lane-line count, plus vertical/horizontal texture. Photos whose sky
//      is at the bottom are flipped upright first.
//   3. A hand-written region vote: strong cues (snow in the middle band,
//      a yellow centre line, very lush saturated green, tan arid ground
//      with almost no green, red dirt road) add weight to generic region
//      centres (far north, tropics, deserts, the Americas, Europe, ...).
//      The vote is blended only 25% against a prior centre, because on the
//      75 practice photos the pixel cues are weak: the prior alone and the
//      blended vote score almost identically, and the blend only helps
//      when a trial is heavy on the Americas, so 25% is the honest weight.
//   4. The prior centre (54, 24) is the middle of where OpenStreetView-5M
//      photos actually come from: northern Eurasia is by far the densest
//      source, with the Americas next. It is a geographic prior, not a
//      table of photos: no photo, place or coordinate from the practice
//      pool is stored here.
// Deterministic: every answer is a pure function of the photo bytes.
// No wall clock, no unseeded randomness, no model calls, so a replay
// leaves exactly the same answers.

const PRIOR: [number, number] = [54, 24];
const BLEND = 0.25;

// ---------------------------------------------------------------- JPEG -----
interface HuffTable {
  lut: Int32Array; // index = next 16 bits; value = (symbol << 5) | len, or -1
}
interface Comp {
  id: number;
  h: number;
  v: number;
  tq: number;
  dcTable: number;
  acTable: number;
}
interface Jpeg {
  width: number;
  height: number;
  comps: Comp[];
  quant: Map<number, number[]>;
  dc: Map<number, HuffTable>;
  ac: Map<number, HuffTable>;
  restartInterval: number;
  scan: Uint8Array;
}

function buildHuff(counts: number[], symbols: number[]): HuffTable {
  const lut = new Int32Array(65536).fill(-1);
  let code = 0;
  let k = 0;
  for (let len = 1; len <= 16; len++) {
    for (let i = 0; i < counts[len - 1]!; i++) {
      const sym = symbols[k++]!;
      // Fill every 16-bit prefix that starts with this code.
      const remaining = 16 - len;
      const base = code << remaining;
      const count = 1 << remaining;
      const val = (sym << 5) | len;
      for (let j = 0; j < count; j++) lut[base + j] = val;
      code++;
    }
    code <<= 1;
  }
  return { lut };
}

function parseJpeg(buf: Uint8Array): Jpeg {
  let pos = 2; // skip SOI
  const quant = new Map<number, number[]>();
  const dc = new Map<number, HuffTable>();
  const ac = new Map<number, HuffTable>();
  let width = 0;
  let height = 0;
  let comps: Comp[] = [];
  let restartInterval = 0;
  let scan: Uint8Array = new Uint8Array(0);
  const zigzag = [
    0, 1, 8, 16, 9, 2, 3, 10, 17, 24, 32, 25, 18, 11, 4, 5,
    12, 19, 26, 33, 40, 48, 41, 34, 27, 20, 13, 6, 7, 14, 21,
    28, 35, 42, 49, 56, 57, 50, 43, 36, 29, 22, 15, 23, 30, 37,
    44, 51, 58, 59, 52, 45, 38, 31, 39, 46, 53, 60, 61, 54, 47,
    55, 62, 63,
  ];
  while (pos < buf.length) {
    if (buf[pos] !== 0xff) { pos++; continue; }
    const marker = buf[pos + 1]!;
    if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) { pos += 2; continue; }
    if (marker === 0xd9) break;
    const len = (buf[pos + 2]! << 8) | buf[pos + 3]!;
    const data = buf.subarray(pos + 4, pos + 2 + len);
    if (marker === 0xdb) {
      let i = 0;
      while (i < data.length) {
        const pqTq = data[i]!;
        const tq = pqTq & 15;
        const pq = pqTq >> 4;
        const table: number[] = new Array(64);
        if (pq === 0) {
          for (let j = 0; j < 64; j++) table[zigzag[j]!] = data[i + 1 + j]!;
          i += 65;
        } else {
          for (let j = 0; j < 64; j++) table[zigzag[j]!] = (data[i + 1 + j * 2]! << 8) | data[i + 2 + j * 2]!;
          i += 129;
        }
        quant.set(tq, table);
      }
    } else if (marker === 0xc0) {
      height = (data[1]! << 8) | data[2]!;
      width = (data[3]! << 8) | data[4]!;
      const n = data[5]!;
      comps = [];
      for (let c = 0; c < n; c++) {
        const o = 6 + c * 3;
        comps.push({ id: data[o]!, h: data[o + 1]! >> 4, v: data[o + 1]! & 15, tq: data[o + 2]!, dcTable: 0, acTable: 0 });
      }
    } else if (marker === 0xc4) {
      let i = 0;
      while (i < data.length) {
        const tcTh = data[i]!;
        const counts: number[] = [];
        let total = 0;
        for (let j = 0; j < 16; j++) { counts.push(data[i + 1 + j]!); total += data[i + 1 + j]!; }
        const symbols: number[] = [];
        for (let j = 0; j < total; j++) symbols.push(data[i + 17 + j]!);
        const table = buildHuff(counts, symbols);
        if ((tcTh >> 4) === 0) dc.set(tcTh & 15, table); else ac.set(tcTh & 15, table);
        i += 17 + total;
      }
    } else if (marker === 0xdd) {
      restartInterval = (data[0]! << 8) | data[1]!;
    } else if (marker === 0xda) {
      const n = data[0]!;
      for (let c = 0; c < n; c++) {
        const o = 1 + c * 2;
        const comp = comps.find((x) => x.id === data[o]!);
        if (comp) { comp.dcTable = data[o + 1]! >> 4; comp.acTable = data[o + 1]! & 15; }
      }
      scan = buf.subarray(pos + 2 + len);
      break;
    }
    pos += 2 + len;
  }
  return { width, height, comps, quant, dc, ac, restartInterval, scan };
}

// IDCT: 1-D, out[x] = 0.5 * sum_u in[u] * Cu * cos((2x+1) u pi / 16).
const COS: number[][] = [];
for (let u = 0; u < 8; u++) {
  COS.push([]);
  for (let x = 0; x < 8; x++) {
    COS[u]!.push(Math.cos(((2 * x + 1) * u * Math.PI) / 16) * (u === 0 ? 1 / Math.SQRT2 : 1));
  }
}
function idctBlock(coef: Float64Array, out: Float64Array): void {
  const tmp = new Float64Array(64);
  for (let y = 0; y < 8; y++) {
    for (let x = 0; x < 8; x++) {
      let s = 0;
      for (let u = 0; u < 8; u++) s += coef[y * 8 + u]! * COS[u]![x]!;
      tmp[y * 8 + x] = s * 0.5;
    }
  }
  for (let x = 0; x < 8; x++) {
    for (let y = 0; y < 8; y++) {
      let s = 0;
      for (let v = 0; v < 8; v++) s += tmp[v * 8 + x]! * COS[v]![y]!;
      out[y * 8 + x] = s * 0.5 + 128;
    }
  }
}

class BitReader {
  data: Uint8Array;
  pos = 0;
  acc = 0;
  bits = 0;
  restartSeen = false;
  constructor(data: Uint8Array) { this.data = data; }
  // Returns false when the next bytes are a restart marker (already consumed
  // past it, aligned) or the stream ends.
  private nextByte(): number {
    if (this.pos >= this.data.length) return -1;
    const b = this.data[this.pos]!;
    if (b === 0xff) {
      const nxt = this.data[this.pos + 1];
      if (nxt === 0x00) { this.pos += 2; return 0xff; }
      if (nxt !== undefined && nxt >= 0xd0 && nxt <= 0xd7) {
        this.pos += 2;
        this.acc = 0;
        this.bits = 0;
        this.restartSeen = true;
        return -1;
      }
      // A lone 0xFF that is not stuffing: treat as data 0xFF.
      this.pos += 1;
      return 0xff;
    }
    this.pos += 1;
    return b;
  }
  bit(): number {
    if (this.bits === 0) {
      const b = this.nextByte();
      if (b < 0) return -1;
      this.acc = b;
      this.bits = 8;
    }
    this.bits--;
    return (this.acc >> this.bits) & 1;
  }
  bitsN(n: number): number {
    let v = 0;
    for (let i = 0; i < n; i++) {
      const b = this.bit();
      if (b < 0) return -1;
      v = (v << 1) | b;
    }
    return v;
  }
  // Decode one Huffman symbol using the 16-bit table; refills the bit
  // buffer as needed. Returns -1 at end of stream / restart marker.
  symbol(table: HuffTable): number {
    while (this.bits < 16) {
      const b = this.nextByte();
      if (b < 0) return -1;
      this.acc = (this.acc << 8) | b;
      this.bits += 8;
    }
    const peek = (this.acc >> (this.bits - 16)) & 0xffff;
    const val = table.lut[peek]!;
    if (val < 0) return -1;
    const len = val & 31;
    this.bits -= len;
    this.acc &= (1 << this.bits) - 1;
    return val >> 5;
  }
}

function decodeBlock(
  br: BitReader, dcTable: HuffTable, acTable: HuffTable,
  dcPred: number, quant: number[], coef: Float64Array,
  out: { dc: number },
): boolean {
  coef.fill(0);
  const t = br.symbol(dcTable);
  if (t < 0) return false;
  let diff = 0;
  if (t > 0) {
    const v = br.bitsN(t);
    if (v < 0) return false;
    diff = v < (1 << (t - 1)) ? v - ((1 << t) - 1) : v;
  }
  const dcVal = dcPred + diff;
  coef[0] = dcVal * quant[0]!;
  let k = 1;
  while (k < 64) {
    const rs = br.symbol(acTable);
    if (rs < 0) return false;
    if (rs === 0x00) break; // EOB
    const run = rs >> 4;
    const size = rs & 15;
    if (rs === 0xf0) { k += 16; continue; } // ZRL
    k += run;
    if (k >= 64) break;
    let v = 0;
    if (size > 0) {
      const bits = br.bitsN(size);
      if (bits < 0) return false;
      v = bits < (1 << (size - 1)) ? bits - ((1 << size) - 1) : bits;
    }
    coef[k] = v * quant[k]!;
    k++;
  }
  out.dc = dcVal;
  return true;
}

function decodeJpeg(buf: Uint8Array): { width: number; height: number; rgb: Uint8Array } | null {
  try {
    const j = parseJpeg(buf);
    if (j.width === 0 || j.height === 0 || j.comps.length === 0) return null;
    const hMax = Math.max(...j.comps.map((c) => c.h));
    const vMax = Math.max(...j.comps.map((c) => c.v));
    const mcuW = Math.ceil(j.width / (8 * hMax));
    const mcuH = Math.ceil(j.height / (8 * vMax));
    // Component planes at sampled resolution.
    const planes = j.comps.map((c) => ({
      comp: c,
      w: mcuW * c.h * 8,
      h: mcuH * c.v * 8,
      data: new Float64Array(mcuW * c.h * 8 * mcuH * c.v * 8),
    }));
    const br = new BitReader(j.scan);
    const coef = new Float64Array(64);
    const block = new Float64Array(64);
    const dcPred = new Array(j.comps.length).fill(0);
    let mcuCount = 0;
    for (let my = 0; my < mcuH; my++) {
      for (let mx = 0; mx < mcuW; mx++) {
        for (let ci = 0; ci < j.comps.length; ci++) {
          const c = j.comps[ci]!;
          const plane = planes[ci]!;
          const dcTable = j.dc.get(c.dcTable);
          const acTable = j.ac.get(c.acTable);
          const q = j.quant.get(c.tq);
          if (!dcTable || !acTable || !q) return null;
          for (let by = 0; by < c.v; by++) {
            for (let bx = 0; bx < c.h; bx++) {
              const outDc = { dc: 0 };
              const ok = decodeBlock(br, dcTable, acTable, dcPred[ci]!, q, coef, outDc);
              if (!ok) {
                if (br.restartSeen) {
                  // Restart: predictors reset, this block is lost; fill with
                  // mid-grey and continue at the next MCU boundary. The
                  // caller only needs coarse colours, so a lost block is
                  // acceptable rather than failing the whole photo.
                  dcPred.fill(0);
                  br.restartSeen = false;
                  mcuCount++;
                  continue;
                }
                return null;
              }
              dcPred[ci] = outDc.dc;
              idctBlock(coef, block);
              const ox = (mx * c.h + bx) * 8;
              const oy = (my * c.v + by) * 8;
              for (let y = 0; y < 8; y++) {
                const row = (oy + y) * plane.w + ox;
                for (let x = 0; x < 8; x++) plane.data[row + x] = block[y * 8 + x]!;
              }
            }
          }
        }
        mcuCount++;
        if (j.restartInterval > 0 && mcuCount % j.restartInterval === 0) {
          dcPred.fill(0);
          // The bit reader aligns itself when it meets the RST marker.
        }
      }
    }
    const rgb = new Uint8Array(j.width * j.height * 3);
    const clamp = (v: number): number => (v < 0 ? 0 : v > 255 ? 255 : Math.round(v));
    if (j.comps.length === 1) {
      const p = planes[0]!;
      for (let y = 0; y < j.height; y++) {
        for (let x = 0; x < j.width; x++) {
          const sx = Math.floor((x * p.w) / j.width);
          const sy = Math.floor((y * p.h) / j.height);
          const g = clamp(p.data[sy * p.w + sx]!);
          const o = (y * j.width + x) * 3;
          rgb[o] = g; rgb[o + 1] = g; rgb[o + 2] = g;
        }
      }
    } else {
      const yP = planes[0]!;
      const cbP = planes[1]!;
      const crP = planes[2]!;
      for (let y = 0; y < j.height; y++) {
        for (let x = 0; x < j.width; x++) {
          const yy = clamp(yP.data[Math.floor((y * yP.h) / j.height) * yP.w + Math.floor((x * yP.w) / j.width)]!);
          const cb = cbP.data[Math.floor((y * cbP.h) / j.height) * cbP.w + Math.floor((x * cbP.w) / j.width)]!;
          const cr = crP.data[Math.floor((y * crP.h) / j.height) * crP.w + Math.floor((x * crP.w) / j.width)]!;
          const o = (y * j.width + x) * 3;
          rgb[o] = clamp(yy + 1.402 * (cr - 128));
          rgb[o + 1] = clamp(yy - 0.34414 * (cb - 128) - 0.71414 * (cr - 128));
          rgb[o + 2] = clamp(yy + 1.772 * (cb - 128));
        }
      }
    }
    return { width: j.width, height: j.height, rgb };
  } catch {
    return null;
  }
}

// -------------------------------------------------------------- features ---
interface Feats {
  [k: string]: number;
}
function features(img: { width: number; height: number; rgb: Uint8Array }): Feats {
  // Sample to a 256x144 grid (nearest), exactly the grid the thresholds
  // below were checked against.
  const GW = 256;
  const GH = 144;
  const grid = new Float64Array(GW * GH * 3);
  for (let gy = 0; gy < GH; gy++) {
    const sy = Math.floor((gy * img.height) / GH);
    for (let gx = 0; gx < GW; gx++) {
      const sx = Math.floor((gx * img.width) / GW);
      const si = (sy * img.width + sx) * 3;
      const di = (gy * GW + gx) * 3;
      grid[di] = img.rgb[si]!;
      grid[di + 1] = img.rgb[si + 1]!;
      grid[di + 2] = img.rgb[si + 2]!;
    }
  }
  const px = (x: number, y: number): [number, number, number] => {
    const i = (y * GW + x) * 3;
    return [grid[i]!, grid[i + 1]!, grid[i + 2]!];
  };
  // Flip upright when the sky is clearly at the bottom (a few Mapillary
  // photos are stored upside down).
  let topSky = 0;
  let botSky = 0;
  for (let y = 0; y < 36; y++) for (let x = 0; x < GW; x++) { const [, g, b] = px(x, y); const [r] = px(x, y); if (b > r + 20 && b > g + 10) topSky++; }
  for (let y = 108; y < GH; y++) for (let x = 0; x < GW; x++) { const [r, g, b] = px(x, y); if (b > r + 20 && b > g + 10) botSky++; }
  const flip = botSky > topSky + 0.25 * GW * 36;
  if (flip) {
    for (let y = 0; y < GH / 2; y++) {
      for (let x = 0; x < GW; x++) {
        const a = (y * GW + x) * 3;
        const b = ((GH - 1 - y) * GW + x) * 3;
        for (let k = 0; k < 3; k++) { const t = grid[a + k]!; grid[a + k] = grid[b + k]!; grid[b + k] = t; }
      }
    }
  }
  const cls = {
    green: (r: number, g: number, b: number) => g > r + 8 && g > b + 3,
    sky: (r: number, g: number, b: number) => b > r + 20 && b > g + 10,
    white: (r: number, g: number, b: number) => r > 185 && g > 185 && b > 185,
    tan: (r: number, g: number, b: number) => r > 105 && r > g + 10 && g > b + 5 && r < 205,
    red: (r: number, g: number, b: number) => r > g + 20 && g > b + 8 && r > 85,
    yellow: (r: number, g: number, b: number) => r > 150 && g > 110 && b < 130 && r - b > 55 && g - b > 20,
    grey: (r: number, g: number, b: number) => Math.abs(r - g) < 14 && Math.abs(g - b) < 14 && (r + g + b) / 3 > 65 && (r + g + b) / 3 < 175,
    dark: (r: number, g: number, b: number) => (r + g + b) / 3 < 55,
    water: (r: number, g: number, b: number) => b > r + 30 && b > 95,
    bright: (r: number, g: number, b: number) => (r + g + b) / 3 > 175,
  };
  const f: Feats = {};
  const zones: Record<string, [number, number, number, number]> = {
    top: [0, 0, GW, 36],
    mid: [0, 36, GW, 96],
    bot: [0, 96, GW, 144],
    ctr: [88, 48, 168, 144],
    botctr: [88, 96, 168, 144],
    all: [0, 0, GW, 144],
  };
  for (const [zn, [x0, y0, x1, y1]] of Object.entries(zones)) {
    const n = (x1 - x0) * (y1 - y0);
    for (const [cn, test] of Object.entries(cls)) {
      let c = 0;
      for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) { const [r, g, b] = px(x, y); if (test(r, g, b)) c++; }
      f[`${zn}_${cn}`] = c / n;
    }
  }
  let meanR = 0, meanG = 0, meanB = 0, bright = 0, sat = 0;
  for (let y = 0; y < GH; y++) for (let x = 0; x < GW; x++) {
    const [r, g, b] = px(x, y);
    meanR += r; meanG += g; meanB += b; bright += (r + g + b) / 3;
    const mx = Math.max(r, g, b);
    const mn = Math.min(r, g, b);
    sat += mx === 0 ? 0 : (mx - mn) / mx;
  }
  const n = GW * GH;
  f['meanR'] = meanR / n;
  f['meanG'] = meanG / n;
  f['meanB'] = meanB / n;
  f['bright'] = bright / n;
  f['sat'] = sat / n;
  f['top_sky'] = f['top_sky']!;
  f['bot_green'] = f['bot_green']!;
  // Texture: mean absolute grey gradient.
  let gx = 0, gy = 0, cnt = 0;
  for (let y = 1; y < GH - 1; y++) for (let x = 1; x < GW - 1; x++) {
    const [r0, g0, b0] = px(x, y);
    const [r1, g1, b1] = px(x + 1, y);
    const [r2, g2, b2] = px(x, y + 1);
    gx += Math.abs((r1 + g1 + b1) - (r0 + g0 + b0)) / 3;
    gy += Math.abs((r2 + g2 + b2) - (r0 + g0 + b0)) / 3;
    cnt++;
  }
  f['gradx'] = gx / cnt;
  f['grady'] = gy / cnt;
  // Lane lines: columns in the bottom half with many yellow pixels.
  let lineYellow = 0;
  for (let x = 0; x < GW; x++) {
    let c = 0;
    for (let y = 72; y < GH; y++) { const [r, g, b] = px(x, y); if (cls.yellow(r, g, b)) c++; }
    if (c > 15) lineYellow++;
  }
  f['line_yellow'] = lineYellow;
  return f;
}

// ------------------------------------------------------------ classifier ---
const REGIONS: Record<string, [number, number]> = {
  NORDIC: [62, 25], SIBERIA: [58, 100], EUROPE: [50, 12], RUS_W: [55, 42],
  C_ASIA: [44, 68], MIDEAST: [30, 48], S_ASIA: [23, 80], SE_ASIA: [12, 103],
  E_ASIA: [36, 122], NAM_W: [42, -112], NAM_E: [38, -84], MEX: [23, -102],
  SAM_N: [-6, -62], SAM_S: [-33, -66], AFR_W: [9, -3], AFR_E: [-12, 36],
  OCE: [-30, 142], NZ: [-43, 171],
};
function regionScores(f: Feats): Record<string, number> {
  const s: Record<string, number> = {};
  for (const k of Object.keys(REGIONS)) s[k] = 0;
  const lush = (f['mid_green'] ?? 0) + (f['bot_green'] ?? 0);
  if ((f['mid_white'] ?? 0) > 0.40 && (f['sat'] ?? 0) < 0.20) { s['NORDIC']! += 1.4; s['SIBERIA']! += 1.0; s['RUS_W']! += 0.7; }
  else if ((f['mid_white'] ?? 0) > 0.35 && (f['sat'] ?? 0) < 0.15) { s['NORDIC']! += 0.8; s['SIBERIA']! += 0.5; }
  if (lush > 1.0 && (f['sat'] ?? 0) > 0.30 && (f['bright'] ?? 0) > 110) { s['SE_ASIA']! += 1.0; s['AFR_E']! += 0.6; s['SAM_N']! += 0.5; }
  if ((f['bot_tan'] ?? 0) > 0.30 && (f['mid_green'] ?? 0) < 0.08 && (f['bot_green'] ?? 0) < 0.08) { s['MIDEAST']! += 1.0; s['AFR_W']! += 0.5; s['C_ASIA']! += 0.4; }
  if ((f['bot_red'] ?? 0) > 0.20 && (f['mid_green'] ?? 0) < 0.15 && (f['bot_tan'] ?? 0) > 0.15) { s['AFR_E']! += 0.9; s['SAM_N']! += 0.6; s['OCE']! += 0.3; }
  if ((f['line_yellow'] ?? 0) >= 3) { s['MEX']! += 0.9; s['NAM_E']! += 0.5; s['SAM_N']! += 0.5; }
  if ((f['mid_green'] ?? 0) > 0.30 && (f['bright'] ?? 0) < 110 && (f['top_sky'] ?? 0) < 0.6) { s['NORDIC']! += 0.8; s['SIBERIA']! += 0.8; s['NAM_W']! += 0.5; }
  if ((f['mid_green'] ?? 0) > 0.10 && (f['mid_green'] ?? 0) < 0.35 && (f['sat'] ?? 0) > 0.22 && (f['bot_white'] ?? 0) < 0.08) { s['EUROPE']! += 0.5; s['NAM_E']! += 0.4; s['E_ASIA']! += 0.3; }
  return s;
}
function toUnit(lat: number, lon: number): [number, number, number] {
  const a = (lat * Math.PI) / 180;
  const b = (lon * Math.PI) / 180;
  return [Math.cos(a) * Math.cos(b), Math.cos(a) * Math.sin(b), Math.sin(a)];
}
function classify(f: Feats): [number, number] {
  const s = regionScores(f);
  const total = Object.values(s).reduce((acc, v) => acc + v, 0);
  if (total <= 0) return PRIOR;
  let v = toUnit(PRIOR[0], PRIOR[1]).map((x) => x * (1 - BLEND));
  for (const [k, w] of Object.entries(s)) {
    if (w <= 0) continue;
    const [la, lo] = REGIONS[k]!;
    const u = toUnit(la, lo);
    const coef = (BLEND * w) / total;
    v = [v[0]! + coef * u[0]!, v[1]! + coef * u[1]!, v[2]! + coef * u[2]!];
  }
  const n = Math.hypot(v[0]!, v[1]!, v[2]!) || 1;
  const lat = (Math.asin(v[2]! / n) * 180) / Math.PI;
  const lon = (Math.atan2(v[1]!, v[0]!) * 180) / Math.PI;
  return [Math.round(lat * 1e6) / 1e6, Math.round(lon * 1e6) / 1e6];
}

// ------------------------------------------------------------------- env ---
interface Photo { id: string; url: string; answered: boolean; }
function need(name: string): string {
  const v = process.env[name];
  if (v === undefined || v === '') throw new Error(`${name} is not set`);
  return v;
}
async function main(): Promise<number> {
  const envUrl = need('MAKEFUN_ENV_URL').replace(/\/+$/, '');
  const listed = (await (await fetch(`${envUrl}/photos`)).json()) as { photos: Photo[] };
  const photos = listed.photos.filter((p) => !p.answered);
  const answers: { id: string; lat: number; lon: number }[] = [];
  for (const p of photos) {
    let lat = PRIOR[0];
    let lon = PRIOR[1];
    try {
      const res = await fetch(`${envUrl}${p.url}`);
      if (res.ok) {
        const img = decodeJpeg(new Uint8Array(await res.arrayBuffer()));
        if (img) [lat, lon] = classify(features(img));
      }
    } catch (err) {
      process.stderr.write(`geolocator: ${p.id}: ${(err as Error).message ?? String(err)}; using prior\n`);
    }
    answers.push({ id: p.id, lat, lon });
  }
  if (answers.length === 0) return 0;
  const res = await fetch(`${envUrl}/answers`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ answers }),
  });
  process.stdout.write(`geolocator: ${answers.length} of ${photos.length} photos answered: HTTP ${res.status} ${await res.text()}`);
  return res.ok ? 0 : 1;
}
try {
  process.exitCode = await main();
} catch (err) {
  process.stderr.write(`geolocator: ${(err as Error).stack ?? String(err)}\n`);
  process.exitCode = 1;
}
