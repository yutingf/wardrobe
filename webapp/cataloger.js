/* cataloger.js — in-browser photo cataloging, zero tokens.
   Pipeline per uploaded image (all local, nothing leaves the device):
     0. OCR (Tesseract.js): if the image carries product text (a shopping
        screenshot), read Color / title / material words. Text is ground
        truth and overrides the vision guesses for the matching garment.
     1. Clothes parsing (SegFormer): segment the image into garment classes
        (upper-clothes, pants, skirt, dress, scarf, hat, shoes) plus person
        and background. On a worn/model shot each garment class becomes its
        own piece, with skin and background excluded; on a flat lay the
        garment regions are unioned and split by connected components.
     2. Rendering: each piece becomes a product-style catalog shot (cutout on
        white, straightened, light corrected). Color comes from the piece's
        own pixels only, so a black garment on a white wall reads black.
     3. CLIP: embeds cutouts to cluster same-garment angles and refine the
        category within the class's plausible set, plus pattern/material.
   The user reviews and edits every draft before it is saved to IndexedDB. */

'use strict';

const CATALOGER = (() => {
  const CDN = 'https://cdn.jsdelivr.net/npm/@huggingface/transformers@3.4.2';
  const OCR_CDN = 'https://cdn.jsdelivr.net/npm/tesseract.js@5/dist/tesseract.esm.min.js';
  const CLIP_MODEL = 'Xenova/clip-vit-base-patch32';
  const SEG_MODEL = 'Xenova/segformer_b2_clothes';
  const SAME_ITEM_THRESHOLD = 0.86; // cosine similarity above this = same garment
  const PROC_EDGE = 768;            // working resolution (phone tabs OOM above this)
  const OUT_EDGE = 768;             // saved product-photo resolution
  const MIN_BLOB_FRAC = 0.03;       // garment regions smaller than this are noise

  const CATEGORY_LABELS = [
    { label: 'a t-shirt', category: 'tee', layer: 'base', warmth: 1, formality: 1.5 },
    { label: 'a polo shirt', category: 'polo', layer: 'base', warmth: 1, formality: 2.5 },
    { label: 'a button-up dress shirt', category: 'shirt', layer: 'base', warmth: 1.5, formality: 3.5 },
    { label: 'a knit sweater', category: 'sweater', layer: 'mid', warmth: 3, formality: 2.5 },
    { label: 'a cardigan', category: 'cardigan', layer: 'mid', warmth: 2.5, formality: 3 },
    { label: 'a hoodie or sweatshirt', category: 'hoodie', layer: 'mid', warmth: 2.5, formality: 1.5 },
    { label: 'a suit jacket or blazer', category: 'blazer', layer: 'outer', warmth: 2.5, formality: 4.5 },
    { label: 'a wool overcoat', category: 'coat', layer: 'outer', warmth: 4, formality: 4 },
    { label: 'a puffer or down winter coat', category: 'coat', layer: 'outer', warmth: 4.5, formality: 1.5 },
    { label: 'a rain jacket or windbreaker', category: 'jacket', layer: 'outer', warmth: 2, formality: 1.5, waterResistant: true },
    { label: 'a denim or casual jacket', category: 'jacket', layer: 'outer', warmth: 2, formality: 1.5 },
    { label: 'a pair of jeans', category: 'jeans', layer: 'bottom', warmth: 2, formality: 2 },
    { label: 'a pair of chino pants', category: 'chinos', layer: 'bottom', warmth: 2, formality: 2.5 },
    { label: 'a pair of formal dress trousers', category: 'trousers', layer: 'bottom', warmth: 2.5, formality: 4 },
    { label: 'a pair of shorts', category: 'shorts', layer: 'bottom', warmth: 1, formality: 1.5 },
    { label: 'a skirt', category: 'skirt', layer: 'bottom', warmth: 1.5, formality: 3 },
    { label: 'a dress', category: 'dress', layer: 'base', warmth: 1.5, formality: 3.5 },
    { label: 'a pair of sneakers', category: 'sneakers', layer: 'footwear', warmth: 1, formality: 2 },
    { label: 'a pair of leather dress shoes', category: 'shoes', layer: 'footwear', warmth: 2, formality: 4 },
    { label: 'a pair of boots', category: 'boots', layer: 'footwear', warmth: 2.5, formality: 3 },
    { label: 'a scarf', category: 'scarf', layer: 'accessory', warmth: 2, formality: 3 },
    { label: 'a winter hat or baseball cap', category: 'hat', layer: 'accessory', warmth: 1.5, formality: 1.5 },
  ];
  const CAT_BY_NAME = {};
  for (const c of CATEGORY_LABELS) if (!CAT_BY_NAME[c.category]) CAT_BY_NAME[c.category] = c;
  const catLayer = name => (CAT_BY_NAME[name] || {}).layer;

  const TEMPLATES = [
    'a photo of {}',
    'a product photo of {}, isolated on a white background',
    'a flat lay photo of {}',
  ];

  const PATTERN_LABELS = [
    { label: 'plain solid-colored clothing with no pattern', value: 'solid' },
    { label: 'striped clothing', value: 'stripe' },
    { label: 'plaid or tartan clothing', value: 'plaid' },
    { label: 'checked or gingham clothing', value: 'check' },
    { label: 'floral patterned clothing', value: 'floral' },
    { label: 'clothing with a graphic print or logo', value: 'graphic' },
    { label: 'polka dot clothing', value: 'polka-dot' },
  ];

  const MATERIAL_LABELS = ['cotton', 'wool', 'denim', 'leather', 'linen', 'synthetic', 'fleece', 'suede', 'down'];
  const MATERIAL_WARMTH = { wool: 0.5, fleece: 0.5, down: 1, linen: -0.5 };

  // ---------------------------------------------------------------- SegFormer classes

  // ATR/clothes classes -> the categories CLIP may choose among for that region.
  const CLASS_CATS = {
    'Upper-clothes': ['tee', 'polo', 'shirt', 'sweater', 'cardigan', 'hoodie', 'blazer', 'coat', 'jacket'],
    'Pants': ['jeans', 'chinos', 'trousers', 'shorts'],
    'Skirt': ['skirt'],
    'Dress': ['dress'],
    'Scarf': ['scarf'],
    'Hat': ['hat'],
    'Shoe': ['sneakers', 'shoes', 'boots'], // Left-shoe + Right-shoe merged
  };
  const PERSON_CLASSES = ['Face', 'Hair', 'Left-leg', 'Right-leg', 'Left-arm', 'Right-arm', 'Sunglasses', 'Neck'];

  // ---------------------------------------------------------------- palette (pixel color naming)

  const COLOR_HEX = {
    black: '#1a1a1a', white: '#f2f2ef', 'light gray': '#c9c9c9', gray: '#8a8a8a', charcoal: '#3d3d3d',
    cream: '#f0e9d8', beige: '#d9c7a7', tan: '#c8a06a', khaki: '#b7a878',
    navy: '#1f2f52', denim: '#4a6a94', indigo: '#2a3a6b',
    brown: '#6b4a2f', camel: '#b3854d', olive: '#6b6b3f', burgundy: '#6d2033',
    rust: '#b7410e', mustard: '#d4a017',
    red: '#c0392b', coral: '#ee6f57', orange: '#e07b39', peach: '#f2b28c',
    yellow: '#e8c33b', green: '#3e7c4f', sage: '#9caf88', teal: '#2f7f7f',
    'light blue': '#a3c6e8', blue: '#3b6fb5', 'royal blue': '#2b4dbb',
    purple: '#6a4c93', lavender: '#b9a7d6', pink: '#e29ab0', magenta: '#b03a8c',
  };
  const COLOR_NAMES = Object.keys(COLOR_HEX);

  // ---------------------------------------------------------------- OCR keyword maps

  // Longer / more specific phrases first; first hit wins.
  const CAT_KEYWORDS = [
    ['crop pant', 'trousers'], ['wide leg', 'trousers'], ['dress pant', 'trousers'], ['trouser', 'trousers'],
    ['chino', 'chinos'], ['jean', 'jeans'], ['legging', 'trousers'], ['shorts', 'shorts'],
    ['skirt', 'skirt'], ['gown', 'dress'], ['dress', 'dress'],
    ['blazer', 'blazer'], ['sport coat', 'blazer'], ['suit jacket', 'blazer'],
    ['overcoat', 'coat'], ['trench', 'coat'], ['parka', 'coat'], ['peacoat', 'coat'],
    ['windbreaker', 'jacket'], ['bomber', 'jacket'], ['denim jacket', 'jacket'], ['coat', 'coat'], ['jacket', 'jacket'],
    ['sweatshirt', 'hoodie'], ['hoodie', 'hoodie'], ['pullover', 'sweater'], ['jumper', 'sweater'], ['sweater', 'sweater'],
    ['cardigan', 'cardigan'], ['polo', 'polo'], ['t-shirt', 'tee'], ['tee', 'tee'], ['tank', 'tee'],
    ['blouse', 'shirt'], ['button-up', 'shirt'], ['button up', 'shirt'], ['button-down', 'shirt'], ['shirt', 'shirt'],
    ['scarf', 'scarf'], ['boot', 'boots'], ['sneaker', 'sneakers'], ['trainer', 'sneakers'],
    ['loafer', 'shoes'], ['heel', 'shoes'], ['pump', 'shoes'], ['shoe', 'shoes'],
    ['beanie', 'hat'], ['cap', 'hat'], ['hat', 'hat'], ['pant', 'trousers'],
  ];
  const PATTERN_KEYWORDS = [
    ['pinstripe', 'stripe'], ['stripe', 'stripe'], ['plaid', 'plaid'], ['tartan', 'plaid'],
    ['gingham', 'check'], ['houndstooth', 'check'], ['check', 'check'],
    ['floral', 'floral'], ['flower', 'floral'], ['graphic', 'graphic'], ['logo', 'graphic'],
    ['printed', 'graphic'], ['polka', 'polka-dot'], ['solid', 'solid'],
  ];
  const MATERIAL_KEYWORDS = [
    ['linen', 'linen'], ['cashmere', 'wool'], ['merino', 'wool'], ['wool', 'wool'], ['corduroy', 'cotton'],
    ['cotton', 'cotton'], ['denim', 'denim'], ['leather', 'leather'], ['suede', 'suede'],
    ['fleece', 'fleece'], ['down', 'down'], ['polyester', 'synthetic'], ['nylon', 'synthetic'],
    ['spandex', 'synthetic'], ['elastane', 'synthetic'], ['acrylic', 'synthetic'],
  ];
  const COLOR_SYNONYMS = {
    grey: 'gray', 'off-white': 'cream', ivory: 'cream', 'navy blue': 'navy',
    maroon: 'burgundy', wine: 'burgundy', taupe: 'beige', stone: 'beige', 'sky blue': 'light blue',
    'baby blue': 'light blue', cobalt: 'royal blue', chocolate: 'brown', tan: 'tan',
  };

  // ---------------------------------------------------------------- models (one heavy model at a time)

  let libPromise = null, clipPromise = null, segPromise = null;
  const lib = () => (libPromise || (libPromise = import(CDN)));
  const progFor = onProgress => p => {
    if (p.status === 'progress' && p.total) {
      onProgress(`downloading models ${Math.round((p.loaded / p.total) * 100)}% (${p.file})`);
    }
  };

  function loadCLIP(onProgress) {
    if (!clipPromise) {
      clipPromise = (async () => {
        const T = await lib();
        const prog = progFor(onProgress);
        const processor = await T.AutoProcessor.from_pretrained(CLIP_MODEL, { progress_callback: prog });
        const tokenizer = await T.AutoTokenizer.from_pretrained(CLIP_MODEL);
        const vision = await T.CLIPVisionModelWithProjection.from_pretrained(CLIP_MODEL, { progress_callback: prog });
        const text = await T.CLIPTextModelWithProjection.from_pretrained(CLIP_MODEL, { progress_callback: prog });
        return { T, processor, tokenizer, vision, text };
      })();
      clipPromise.catch(() => { clipPromise = null; });
    }
    return clipPromise;
  }

  function loadSeg(onProgress) {
    if (!segPromise) {
      segPromise = (async () => {
        const T = await lib();
        const seg = await T.pipeline('image-segmentation', SEG_MODEL, { progress_callback: progFor(onProgress) });
        return { T, seg };
      })();
      segPromise.catch(() => { segPromise = null; });
    }
    return segPromise;
  }

  async function disposeSeg() {
    if (!segPromise) return;
    try { const s = await segPromise; await s.seg.dispose(); } catch { /* best effort */ }
    segPromise = null;
  }

  // ---------------------------------------------------------------- OCR

  let ocrWorker = null;
  async function loadOCR(onProgress) {
    if (ocrWorker) return ocrWorker;
    onProgress('loading text reader…');
    const mod = await import(OCR_CDN);
    const createWorker = mod.default.createWorker;
    ocrWorker = await createWorker('eng');
    return ocrWorker;
  }
  async function disposeOCR() {
    if (!ocrWorker) return;
    try { await ocrWorker.terminate(); } catch { /* best effort */ }
    ocrWorker = null;
  }

  async function readText(worker, file) {
    try {
      const { data } = await worker.recognize(URL.createObjectURL(file));
      return data.confidence >= 40 ? data.text : '';
    } catch { return ''; }
  }

  // Parse product text into { color, category, pattern, material } (any subset)
  // or null if nothing recognizable was found.
  function parseHints(text) {
    if (!text || text.replace(/\s/g, '').length < 8) return null;
    const lower = ' ' + text.toLowerCase().replace(/[^a-z0-9:\- ]/g, ' ').replace(/\s+/g, ' ') + ' ';
    const firstHit = pairs => { for (const [kw, val] of pairs) if (lower.includes(kw)) return val; return null; };

    // color: prefer an explicit "Color: X" line, else scan for a palette word
    let color = null;
    const cm = lower.match(/colou?r\s*:?\s*([a-z][a-z ]{2,20})/);
    const names = [...COLOR_NAMES, ...Object.keys(COLOR_SYNONYMS)].sort((a, b) => b.length - a.length);
    const scanColor = s => { for (const n of names) if (s.includes(n)) return COLOR_SYNONYMS[n] || n; return null; };
    if (cm) color = scanColor(' ' + cm[1] + ' ');
    if (!color) color = scanColor(lower);

    const category = firstHit(CAT_KEYWORDS);
    const pattern = firstHit(PATTERN_KEYWORDS);
    const material = firstHit(MATERIAL_KEYWORDS);
    if (!color && !category && !pattern && !material) return null;
    return { color, category, pattern, material };
  }

  // ---------------------------------------------------------------- math

  function normalize(vec) { let n = 0; for (const v of vec) n += v * v; n = Math.sqrt(n) || 1; return vec.map(v => v / n); }
  function cosine(a, b) { let s = 0; for (let i = 0; i < a.length; i++) s += a[i] * b[i]; return s; }
  function meanVec(vecs) { const o = new Array(vecs[0].length).fill(0); for (const v of vecs) for (let i = 0; i < v.length; i++) o[i] += v[i]; return normalize(o.map(x => x / vecs.length)); }

  // ---------------------------------------------------------------- canvas helpers

  async function fileToCanvas(file) {
    const bmp = await createImageBitmap(file);
    const scale = Math.min(1, PROC_EDGE / Math.max(bmp.width, bmp.height));
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.round(bmp.width * scale));
    canvas.height = Math.max(1, Math.round(bmp.height * scale));
    canvas.getContext('2d').drawImage(bmp, 0, 0, canvas.width, canvas.height);
    return canvas;
  }
  const canvasToBlob = (canvas, q = 0.9) => new Promise(res => canvas.toBlob(res, 'image/jpeg', q));

  // ---------------------------------------------------------------- segmentation

  async function classMasks(s, canvas) {
    const W = canvas.width, H = canvas.height;
    const d = canvas.getContext('2d').getImageData(0, 0, W, H);
    const raw = new s.T.RawImage(d.data, W, H, 4).rgb();
    const results = await s.seg(raw);
    const masks = {}, area = {};
    for (const r of results) {
      const m = await r.mask.resize(W, H);
      masks[r.label] = m.data;
      let n = 0; for (let i = 0; i < W * H; i++) if (m.data[i] > 128) n++;
      area[r.label] = n / (W * H);
    }
    return { masks, area, W, H };
  }

  function boundingBox(mask, W, H) {
    let x0 = W, y0 = H, x1 = -1, y1 = -1;
    for (let y = 0; y < H; y++)
      for (let x = 0; x < W; x++)
        if (mask[y * W + x] > 128) { if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y; }
    return x1 < 0 ? null : { x0, y0, x1: x1 + 1, y1: y1 + 1 };
  }

  function orInto(dst, src, W, H) { if (src) for (let i = 0; i < W * H; i++) if (src[i] > 128) dst[i] = 255; }

  // Connected components on a downscaled binary mask -> bounding boxes.
  function findBlobs(mask, w, h) {
    const scale = Math.min(1, 256 / Math.max(w, h));
    const sw = Math.max(1, Math.round(w * scale)), sh = Math.max(1, Math.round(h * scale));
    const small = new Uint8Array(sw * sh);
    for (let y = 0; y < sh; y++)
      for (let x = 0; x < sw; x++)
        small[y * sw + x] = mask[Math.floor(y / scale) * w + Math.floor(x / scale)] > 128 ? 1 : 0;
    const label = new Int32Array(sw * sh).fill(-1);
    const blobs = [], stack = [];
    for (let i = 0; i < small.length; i++) {
      if (!small[i] || label[i] >= 0) continue;
      const id = blobs.length;
      let area = 0, minX = sw, maxX = 0, minY = sh, maxY = 0;
      stack.push(i); label[i] = id;
      while (stack.length) {
        const p = stack.pop(), px = p % sw, py = (p / sw) | 0;
        area++;
        if (px < minX) minX = px; if (px > maxX) maxX = px; if (py < minY) minY = py; if (py > maxY) maxY = py;
        for (const q of [p - 1, p + 1, p - sw, p + sw]) {
          if (q < 0 || q >= small.length) continue;
          if (Math.abs((q % sw) - px) > 1) continue;
          if (small[q] && label[q] < 0) { label[q] = id; stack.push(q); }
        }
      }
      blobs.push({ area, minX, maxX, minY, maxY });
    }
    let boxes = blobs.filter(b => b.area / (sw * sh) >= MIN_BLOB_FRAC).map(b => ({
      x0: Math.floor(b.minX / scale), x1: Math.ceil((b.maxX + 1) / scale),
      y0: Math.floor(b.minY / scale), y1: Math.ceil((b.maxY + 1) / scale),
    }));
    let merged = true;
    while (merged) {
      merged = false;
      outer: for (let i = 0; i < boxes.length; i++)
        for (let j = i + 1; j < boxes.length; j++) {
          const a = boxes[i], b = boxes[j];
          if (Math.min(a.x1, b.x1) - Math.max(a.x0, b.x0) > 0 && Math.min(a.y1, b.y1) - Math.max(a.y0, b.y0) > 0) {
            boxes[i] = { x0: Math.min(a.x0, b.x0), x1: Math.max(a.x1, b.x1), y0: Math.min(a.y0, b.y0), y1: Math.max(a.y1, b.y1) };
            boxes.splice(j, 1); merged = true; break outer;
          }
        }
    }
    return boxes;
  }

  // ---------------------------------------------------------------- product-photo render

  function cutout(canvas, mask, box) {
    const w = canvas.width;
    const pad = Math.round(0.03 * Math.max(box.x1 - box.x0, box.y1 - box.y0));
    const x0 = Math.max(0, box.x0 - pad), y0 = Math.max(0, box.y0 - pad);
    const x1 = Math.min(canvas.width, box.x1 + pad), y1 = Math.min(canvas.height, box.y1 + pad);
    const cw = x1 - x0, ch = y1 - y0;
    const src = canvas.getContext('2d').getImageData(x0, y0, cw, ch);
    for (let y = 0; y < ch; y++)
      for (let x = 0; x < cw; x++) {
        const a = box.fullFallback ? 255 : (mask[(y + y0) * w + (x + x0)] || 0);
        src.data[(y * cw + x) * 4 + 3] = a;
      }
    return src;
  }

  function autoAdjust(img) {
    const d = img.data;
    let n = 0, mr = 0, mg = 0, mb = 0; const lumas = [];
    for (let i = 0; i < d.length; i += 4) {
      if (d[i + 3] < 128) continue;
      n++; mr += d[i]; mg += d[i + 1]; mb += d[i + 2];
      lumas.push(0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2]);
    }
    if (n < 50) return img;
    mr /= n; mg /= n; mb /= n;
    const m = (mr + mg + mb) / 3, clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
    const sr = clamp(m / (mr || 1), 0.85, 1.2), sg = clamp(m / (mg || 1), 0.85, 1.2), sb = clamp(m / (mb || 1), 0.85, 1.2);
    lumas.sort((a, b) => a - b);
    const p2 = lumas[Math.floor(0.02 * lumas.length)], p98 = lumas[Math.floor(0.98 * lumas.length)];
    const gain = Math.min(1.6, 235 / Math.max(30, p98 - p2));
    for (let i = 0; i < d.length; i += 4) {
      d[i] = clamp((d[i] * sr - p2) * gain + 15, 0, 255);
      d[i + 1] = clamp((d[i + 1] * sg - p2) * gain + 15, 0, 255);
      d[i + 2] = clamp((d[i + 2] * sb - p2) * gain + 15, 0, 255);
    }
    return img;
  }

  function straightenAngle(img) {
    const pts = [], stride = Math.max(1, Math.floor(Math.sqrt((img.width * img.height) / 1500)));
    for (let y = 0; y < img.height; y += stride)
      for (let x = 0; x < img.width; x += stride)
        if (img.data[(y * img.width + x) * 4 + 3] > 128) pts.push([x, y]);
    if (pts.length < 100) return 0;
    const area = a => {
      const r = (a * Math.PI) / 180, c = Math.cos(r), s = Math.sin(r);
      let minX = 1e9, maxX = -1e9, minY = 1e9, maxY = -1e9;
      for (const [x, y] of pts) { const rx = x * c - y * s, ry = x * s + y * c; if (rx < minX) minX = rx; if (rx > maxX) maxX = rx; if (ry < minY) minY = ry; if (ry > maxY) maxY = ry; }
      return (maxX - minX) * (maxY - minY);
    };
    const base = area(0); let best = 0, bestArea = base;
    for (let a = -27; a <= 27; a += 3) { const v = area(a); if (v < bestArea) { bestArea = v; best = a; } }
    return bestArea < base * 0.95 ? best : 0;
  }

  function productRender(img) {
    autoAdjust(img);
    let c = document.createElement('canvas');
    c.width = img.width; c.height = img.height;
    c.getContext('2d').putImageData(img, 0, 0);
    const angle = straightenAngle(img);
    if (angle !== 0) {
      const r = (angle * Math.PI) / 180;
      const cw = Math.ceil(Math.abs(c.width * Math.cos(r)) + Math.abs(c.height * Math.sin(r)));
      const ch = Math.ceil(Math.abs(c.width * Math.sin(r)) + Math.abs(c.height * Math.cos(r)));
      const rc = document.createElement('canvas'); rc.width = cw; rc.height = ch;
      const ctx = rc.getContext('2d');
      ctx.translate(cw / 2, ch / 2); ctx.rotate(r); ctx.drawImage(c, -c.width / 2, -c.height / 2);
      c = rc;
    }
    const d = c.getContext('2d').getImageData(0, 0, c.width, c.height);
    let minX = c.width, maxX = 0, minY = c.height, maxY = 0;
    for (let y = 0; y < c.height; y++)
      for (let x = 0; x < c.width; x++)
        if (d.data[(y * c.width + x) * 4 + 3] > 20) { if (x < minX) minX = x; if (x > maxX) maxX = x; if (y < minY) minY = y; if (y > maxY) maxY = y; }
    if (maxX <= minX || maxY <= minY) { minX = 0; minY = 0; maxX = c.width - 1; maxY = c.height - 1; }
    const tw = maxX - minX + 1, th = maxY - minY + 1;
    const margin = Math.round(0.06 * Math.max(tw, th));
    const scale = Math.min(1, OUT_EDGE / (Math.max(tw, th) + 2 * margin));
    const out = document.createElement('canvas');
    out.width = Math.round((tw + 2 * margin) * scale);
    out.height = Math.round((th + 2 * margin) * scale);
    const octx = out.getContext('2d');
    octx.fillStyle = '#ffffff'; octx.fillRect(0, 0, out.width, out.height);
    octx.drawImage(c, minX, minY, tw, th, margin * scale, margin * scale, tw * scale, th * scale);
    return out;
  }

  // ---------------------------------------------------------------- pixel color naming

  const hexToRgb = h => [parseInt(h.slice(1, 3), 16), parseInt(h.slice(3, 5), 16), parseInt(h.slice(5, 7), 16)];
  const PALETTE_RGB = COLOR_NAMES.map(n => ({ name: n, rgb: hexToRgb(COLOR_HEX[n]) }));
  function colorDist(a, b) {
    const rm = (a[0] + b[0]) / 2, dr = a[0] - b[0], dg = a[1] - b[1], db = a[2] - b[2];
    return Math.sqrt((2 + rm / 256) * dr * dr + 4 * dg * dg + (2 + (255 - rm) / 256) * db * db);
  }
  const GRAYS = ['black', 'charcoal', 'gray', 'light gray', 'white'];
  function nearestColorName(rgb) {
    const sat = Math.max(...rgb) - Math.min(...rgb);
    const cands = sat < 26 ? PALETTE_RGB.filter(p => GRAYS.includes(p.name)) : PALETTE_RGB;
    let best = cands[0], bd = Infinity;
    for (const p of cands) { const d = colorDist(rgb, p.rgb); if (d < bd) { bd = d; best = p; } }
    return best.name;
  }
  function dominantColors(img) {
    const px = [], stride = Math.max(1, Math.floor(Math.sqrt((img.width * img.height) / 4000)));
    for (let y = 0; y < img.height; y += stride)
      for (let x = 0; x < img.width; x += stride) {
        const i = (y * img.width + x) * 4;
        if (img.data[i + 3] > 200) px.push([img.data[i], img.data[i + 1], img.data[i + 2]]);
      }
    if (px.length < 30) return [{ name: 'gray', weight: 1 }];
    const K = 4;
    let centroids = Array.from({ length: K }, (_, k) => px[Math.floor((k + 0.5) * px.length / K)].slice());
    const assign = new Array(px.length).fill(0);
    for (let iter = 0; iter < 8; iter++) {
      for (let i = 0; i < px.length; i++) {
        let bd = Infinity, bk = 0;
        for (let k = 0; k < K; k++) { const d = colorDist(px[i], centroids[k]); if (d < bd) { bd = d; bk = k; } }
        assign[i] = bk;
      }
      const sums = Array.from({ length: K }, () => [0, 0, 0, 0]);
      for (let i = 0; i < px.length; i++) { const s = sums[assign[i]]; s[0] += px[i][0]; s[1] += px[i][1]; s[2] += px[i][2]; s[3]++; }
      for (let k = 0; k < K; k++) if (sums[k][3]) centroids[k] = [sums[k][0] / sums[k][3], sums[k][1] / sums[k][3], sums[k][2] / sums[k][3]];
    }
    const weights = new Array(K).fill(0);
    for (const a of assign) weights[a]++;
    const named = {};
    for (let k = 0; k < K; k++) { if (!weights[k]) continue; const name = nearestColorName(centroids[k]); named[name] = (named[name] || 0) + weights[k] / px.length; }
    return Object.entries(named).map(([name, weight]) => ({ name, weight })).sort((a, b) => b.weight - a.weight);
  }

  // ---------------------------------------------------------------- CLIP

  async function embedCanvas(m, canvas) {
    const d = canvas.getContext('2d').getImageData(0, 0, canvas.width, canvas.height);
    const raw = new m.T.RawImage(d.data, canvas.width, canvas.height, 4).rgb();
    const inputs = await m.processor(raw);
    const { image_embeds } = await m.vision(inputs);
    return normalize(Array.from(image_embeds.data));
  }
  const textCache = {};
  async function ensembleTextEmbeds(m, labels, cacheKey) {
    if (textCache[cacheKey]) return textCache[cacheKey];
    const prompts = labels.flatMap(l => TEMPLATES.map(t => t.replace('{}', l)));
    const tokens = m.tokenizer(prompts, { padding: true, truncation: true });
    const { text_embeds } = await m.text(tokens);
    const dim = text_embeds.dims[1], flat = Array.from(text_embeds.data);
    const out = labels.map((_, li) => meanVec(TEMPLATES.map((_, ti) => normalize(flat.slice((li * TEMPLATES.length + ti) * dim, (li * TEMPLATES.length + ti + 1) * dim)))));
    textCache[cacheKey] = out;
    return out;
  }
  function classify(embed, labelEmbeds) {
    const sims = labelEmbeds.map(t => cosine(embed, t));
    const exps = sims.map(s => Math.exp(s * 100)), total = exps.reduce((a, b) => a + b, 0);
    let best = 0; for (let i = 1; i < sims.length; i++) if (sims[i] > sims[best]) best = i;
    return { index: best, confidence: exps[best] / total };
  }

  // ---------------------------------------------------------------- pieces

  function makePiece(canvas, mask, box, prior, sourceIndex) {
    const img = cutout(canvas, mask, box);
    const colors = dominantColors(img);
    const product = productRender(img);
    return { colors, sourceIndex, categoryPrior: prior, _product: product, _needsBlob: true };
  }

  async function finalizePiece(p) {
    if (p._needsBlob) { p.blob = await canvasToBlob(p._product); p.url = URL.createObjectURL(p.blob); p._needsBlob = false; }
    return p;
  }

  // Segment one file into rendered pieces (no CLIP embedding yet).
  async function fileToRawPieces(s, canvas, sourceIndex, onProgress) {
    onProgress('finding garments…');
    let masks, area, W, H;
    try { ({ masks, area, W, H } = await classMasks(s, canvas)); }
    catch (err) { console.warn('segmentation failed, keeping the whole photo:', err); masks = null; }
    if (!masks) {
      const box = { x0: 0, y0: 0, x1: canvas.width, y1: canvas.height, fullFallback: true };
      return [makePiece(canvas, new Uint8Array(0), box, null, sourceIndex)];
    }
    const personArea = PERSON_CLASSES.reduce((a, c) => a + (area[c] || 0), 0);
    const worn = personArea > 0.001;
    const pieces = [];
    if (worn) {
      // one piece per garment class; a person wears one of each
      const shoe = new Uint8Array(W * H);
      orInto(shoe, masks['Left-shoe'], W, H); orInto(shoe, masks['Right-shoe'], W, H);
      const classMap = {};
      for (const cls of Object.keys(CLASS_CATS)) {
        if (cls === 'Shoe') { if (area['Left-shoe'] || area['Right-shoe']) classMap.Shoe = shoe; }
        else if (masks[cls] && area[cls] >= 0.006) classMap[cls] = masks[cls];
      }
      for (const [cls, mask] of Object.entries(classMap)) {
        const box = boundingBox(mask, W, H);
        if (box) pieces.push(makePiece(canvas, mask, box, CLASS_CATS[cls], sourceIndex));
      }
    } else {
      // flat lay: union garment regions, split by connected components
      const fg = new Uint8Array(W * H);
      for (const cls of [...Object.keys(CLASS_CATS), 'Left-shoe', 'Right-shoe']) orInto(fg, masks[cls], W, H);
      let any = false; for (let i = 0; i < W * H; i++) if (fg[i]) { any = true; break; }
      const boxes = any ? findBlobs(fg, W, H) : [];
      for (const box of boxes) pieces.push(makePiece(canvas, fg, box, null, sourceIndex));
      if (!pieces.length) pieces.push(makePiece(canvas, new Uint8Array(0), { x0: 0, y0: 0, x1: W, y1: H, fullFallback: true }, null, sourceIndex));
    }
    return pieces;
  }

  async function embedPieces(m, pieces, onProgress) {
    for (let i = 0; i < pieces.length; i++) {
      if (pieces[i].embed) continue;
      onProgress(`reading garment ${i + 1} of ${pieces.length}…`);
      pieces[i].embed = await embedCanvas(m, pieces[i]._product);
      await finalizePiece(pieces[i]);
      pieces[i]._product = null;
    }
  }

  function clusterPieces(pieces) {
    const groups = [], assigned = new Array(pieces.length).fill(-1);
    for (let i = 0; i < pieces.length; i++) {
      if (assigned[i] >= 0) continue;
      const g = [i]; assigned[i] = groups.length;
      for (let j = i + 1; j < pieces.length; j++) {
        if (assigned[j] >= 0) continue;
        if (g.some(k => pieces[k].sourceIndex === pieces[j].sourceIndex)) continue;
        if (g.some(k => cosine(pieces[k].embed, pieces[j].embed) >= SAME_ITEM_THRESHOLD)) { g.push(j); assigned[j] = groups.length; }
      }
      groups.push(g);
    }
    return groups;
  }

  function groupColors(pieces) {
    const agg = {};
    for (const p of pieces) for (const c of p.colors) agg[c.name] = (agg[c.name] || 0) + c.weight;
    const sorted = Object.entries(agg).sort((a, b) => b[1] - a[1]);
    const total = sorted.reduce((s, [, w]) => s + w, 0) || 1;
    const out = [sorted[0][0]];
    if (sorted[1] && sorted[1][1] / total >= 0.25) out.push(sorted[1][0]);
    return out;
  }

  async function attributesFor(m, pieces, hintsBySource) {
    const rep = meanVec(pieces.map(p => p.embed));
    const prior = pieces[0].categoryPrior;
    const catLabels = prior ? CATEGORY_LABELS.filter(c => prior.includes(c.category)) : CATEGORY_LABELS;
    const catEmbeds = await ensembleTextEmbeds(m, catLabels.map(c => c.label), 'cat:' + (prior ? prior.join(',') : 'all'));
    const patEmbeds = await ensembleTextEmbeds(m, PATTERN_LABELS.map(p => p.label), 'pattern');
    const matEmbeds = await ensembleTextEmbeds(m, MATERIAL_LABELS.map(x => `clothing made of ${x}`), 'material');
    const cat = classify(rep, catEmbeds), pat = classify(rep, patEmbeds), mat = classify(rep, matEmbeds);
    let c = catLabels[cat.index];
    let material = MATERIAL_LABELS[mat.index];
    let colors = groupColors(pieces);
    let color = colors[0], pattern = PATTERN_LABELS[pat.index].value;

    // apply product-text hints to the garment they describe
    const hints = [...new Set(pieces.map(p => p.sourceIndex))].map(si => hintsBySource[si]).filter(Boolean);
    let fromLabel = false;
    const applicable = hints.filter(h => !h.category || catLayer(h.category) === c.layer);
    if (applicable.length) {
      const h = applicable[0];
      fromLabel = true;
      if (h.category && catLayer(h.category) === c.layer && CAT_BY_NAME[h.category]) c = CAT_BY_NAME[h.category];
      if (h.color) { color = h.color; colors = [h.color, ...colors.filter(x => x !== h.color)]; }
      if (h.pattern) pattern = h.pattern;
      if (h.material) material = h.material;
    }

    const warmth = Math.min(5, Math.max(1, c.warmth + (MATERIAL_WARMTH[material] || 0)));
    return {
      category: c.category, layer: c.layer, warmth, formality: c.formality,
      waterResistant: !!c.waterResistant, color, colors, pattern, material,
      confidence: { category: fromLabel ? 1 : cat.confidence, pattern: fromLabel ? 1 : pat.confidence, material: fromLabel ? 1 : mat.confidence },
      needsMoreAngles: !fromLabel && (cat.confidence < 0.5 || pieces.length < 2),
      fromLabel,
    };
  }

  // ---------------------------------------------------------------- public API

  async function draftGroups(files, onProgress) {
    // phase 0: OCR each image for product text
    const hintsBySource = {};
    const worker = await loadOCR(onProgress);
    const canvases = [];
    for (let i = 0; i < files.length; i++) {
      onProgress(`photo ${i + 1} of ${files.length}: reading any text…`);
      hintsBySource[i] = parseHints(await readText(worker, files[i]));
      canvases[i] = await fileToCanvas(files[i]);
    }
    await disposeOCR();

    // phase 1: clothes segmentation -> rendered pieces, then free the model
    const s = await loadSeg(onProgress);
    const pieces = [];
    for (let i = 0; i < files.length; i++) {
      onProgress(`photo ${i + 1} of ${files.length}: analyzing…`);
      pieces.push(...await fileToRawPieces(s, canvases[i], i, msg => onProgress(`photo ${i + 1} of ${files.length}: ${msg}`)));
    }
    await disposeSeg();

    // phase 2: CLIP embedding, grouping, attributes
    const m = await loadCLIP(onProgress);
    await embedPieces(m, pieces, onProgress);
    onProgress('grouping pieces into garments…');
    const drafts = [];
    for (const idxs of clusterPieces(pieces)) {
      const groupPieces = idxs.map(i => pieces[i]);
      drafts.push({ photos: groupPieces, ...(await attributesFor(m, groupPieces, hintsBySource)) });
    }
    onProgress('');
    return drafts;
  }

  async function addAnglesToDraft(draft, files, onProgress) {
    const s = await loadSeg(onProgress);
    const fresh = [];
    for (let i = 0; i < files.length; i++) {
      onProgress(`extra angle ${i + 1} of ${files.length}: analyzing…`);
      const canvas = await fileToCanvas(files[i]);
      const pieces = await fileToRawPieces(s, canvas, -1 - i, msg => onProgress(msg));
      fresh.push(pieces[0]);
    }
    await disposeSeg();
    const m = await loadCLIP(onProgress);
    await embedPieces(m, fresh, onProgress);
    // keep the draft's known class for the extra angles
    for (const p of fresh) p.categoryPrior = draft.photos[0] ? draft.photos[0].categoryPrior : null;
    draft.photos.push(...fresh);
    Object.assign(draft, await attributesFor(m, draft.photos, {}));
    onProgress('');
    return draft;
  }

  // ---------------------------------------------------------------- saving

  const slugify = s => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '');

  async function saveItem(draft) {
    const id = `${slugify(draft.name)}-${Date.now().toString(36)}`;
    const photoKeys = [];
    for (let i = 0; i < draft.photos.length; i++) {
      await finalizePiece(draft.photos[i]);
      const key = `${id}-${i}`;
      await DBX.putPhoto(key, draft.photos[i].blob);
      photoKeys.push(key);
    }
    const item = {
      id, name: draft.name, category: draft.category, layer: draft.layer,
      colors: draft.colors && draft.colors.length ? [draft.color, ...draft.colors.filter(c => c !== draft.color)] : [draft.color],
      pattern: draft.pattern, material: draft.material, warmth: draft.warmth, formality: draft.formality,
      waterResistant: draft.waterResistant, photoKeys, user: true,
    };
    await DBX.putItem(item);
    return item;
  }

  async function addPhotosToItem(item, photos) {
    const photoKeys = [...(item.photoKeys || [])];
    for (let i = 0; i < photos.length; i++) {
      await finalizePiece(photos[i]);
      const key = `${item.id}-x${Date.now().toString(36)}-${i}`;
      await DBX.putPhoto(key, photos[i].blob);
      photoKeys.push(key);
    }
    await DBX.putItem({ ...item, photoKeys });
  }

  return {
    CATEGORY_LABELS, COLOR_NAMES, PATTERN_LABELS, MATERIAL_LABELS,
    draftGroups, addAnglesToDraft, saveItem, addPhotosToItem,
    _internals: { loadSeg, loadCLIP, loadOCR, fileToCanvas, classMasks, fileToRawPieces, parseHints, findBlobs, cutout, productRender, dominantColors },
  };
})();

if (typeof window !== 'undefined') window.CATALOGER = CATALOGER;
