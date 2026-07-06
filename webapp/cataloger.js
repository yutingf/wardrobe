/* cataloger.js — in-browser photo cataloging, zero tokens.
   Pipeline per uploaded photo (all local, nothing leaves the device):
     1. RMBG-1.4 removes the background; disconnected mask regions are
        SEPARATE garments (one photo can hold several pieces).
     2. Each piece is rendered as a product-style photo: cutout on white,
        auto-straightened, light/white-balance corrected. That render is
        what gets saved and displayed.
     3. CLIP embeds the clean cutouts to cluster same-garment angles and
        zero-shot-draft category/pattern/material (prompt-ensembled).
        Color comes from the garment's own pixels (k-means -> palette),
        which is more reliable than CLIP for color.
     4. Low-confidence drafts are flagged so the user adds more angles.
   The user reviews and edits every draft before it is saved to IndexedDB. */

'use strict';

const CATALOGER = (() => {
  const CDN = 'https://cdn.jsdelivr.net/npm/@huggingface/transformers@3.4.2';
  const CLIP_MODEL = 'Xenova/clip-vit-base-patch32';
  const RMBG_MODEL = 'briaai/RMBG-1.4';
  const SAME_ITEM_THRESHOLD = 0.86; // cosine similarity above this = same garment
  const PROC_EDGE = 768;            // working resolution (phone tabs crash on OOM above this)
  const OUT_EDGE = 768;             // saved product-photo resolution
  const MIN_BLOB_FRAC = 0.04;       // mask blobs smaller than this are noise

  // Zero-shot label sets. Each category label carries engine defaults.
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

  // Prompt ensembling: each label is embedded with several templates and the
  // text embeddings averaged; the saved images ARE product shots on white,
  // so product-style prompts match the distribution.
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

  // material nudges the category's default warmth
  const MATERIAL_WARMTH = { wool: 0.5, fleece: 0.5, down: 1, linen: -0.5 };

  // Named palette for pixel-based color naming (matches COLORS in engine.js).
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

  // ---------------------------------------------------------------- models

  // The two models never share memory: RMBG runs first over all photos and is
  // fully disposed before CLIP loads. Peak usage = one model, not both —
  // phone tabs get OOM-killed otherwise.
  let libPromise = null, clipPromise = null, rmbgPromise = null;

  function lib() {
    if (!libPromise) libPromise = import(CDN);
    return libPromise;
  }

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
      clipPromise.catch(() => { clipPromise = null; }); // allow retry after failure
    }
    return clipPromise;
  }

  function loadRMBG(onProgress) {
    if (!rmbgPromise) {
      rmbgPromise = (async () => {
        const T = await lib();
        const prog = progFor(onProgress);
        const model = await T.AutoModel.from_pretrained(RMBG_MODEL, { config: { model_type: 'custom' }, progress_callback: prog });
        const processor = await T.AutoProcessor.from_pretrained(RMBG_MODEL, {
          config: {
            do_normalize: true, do_pad: false, do_rescale: true, do_resize: true,
            image_mean: [0.5, 0.5, 0.5], image_std: [1, 1, 1],
            feature_extractor_type: 'ImageFeatureExtractor',
            resample: 2, rescale_factor: 0.00392156862745098,
            // 512 instead of the model's native 1024: activation memory drops
            // to a quarter, which phones need; mask quality stays usable
            size: { width: 512, height: 512 },
          },
        });
        return { T, model, processor };
      })();
      rmbgPromise.catch(() => { rmbgPromise = null; });
    }
    return rmbgPromise;
  }

  async function disposeRMBG() {
    if (!rmbgPromise) return;
    try {
      const r = await rmbgPromise;
      await r.model.dispose();
    } catch { /* disposing is best-effort */ }
    rmbgPromise = null;
  }

  // ---------------------------------------------------------------- math

  function normalize(vec) {
    let n = 0;
    for (const v of vec) n += v * v;
    n = Math.sqrt(n) || 1;
    return vec.map(v => v / n);
  }

  function cosine(a, b) {
    let s = 0;
    for (let i = 0; i < a.length; i++) s += a[i] * b[i];
    return s;
  }

  function meanVec(vecs) {
    const out = new Array(vecs[0].length).fill(0);
    for (const v of vecs) for (let i = 0; i < v.length; i++) out[i] += v[i];
    return normalize(out.map(x => x / vecs.length));
  }

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

  function canvasToBlob(canvas, quality = 0.9) {
    return new Promise(res => canvas.toBlob(res, 'image/jpeg', quality));
  }

  // ---------------------------------------------------------------- background removal

  async function garmentMask(r, canvas) {
    const ctx = canvas.getContext('2d');
    const d = ctx.getImageData(0, 0, canvas.width, canvas.height);
    // RGBA -> RGB: the RMBG feature extractor expects 3 channels
    const raw = new r.T.RawImage(d.data, canvas.width, canvas.height, 4).rgb();
    const { pixel_values } = await r.processor(raw);
    const { output } = await r.model({ input: pixel_values });
    const maskImg = await r.T.RawImage.fromTensor(output[0].mul(255).to('uint8'))
      .resize(canvas.width, canvas.height);
    return maskImg.data; // Uint8Array, length w*h
  }

  // Connected components on a downscaled binary mask; disconnected regions
  // are separate garments in the same photo.
  function findBlobs(mask, w, h) {
    const scale = Math.min(1, 256 / Math.max(w, h));
    const sw = Math.max(1, Math.round(w * scale)), sh = Math.max(1, Math.round(h * scale));
    const small = new Uint8Array(sw * sh);
    for (let y = 0; y < sh; y++)
      for (let x = 0; x < sw; x++)
        small[y * sw + x] = mask[Math.floor(y / scale) * w + Math.floor(x / scale)] > 128 ? 1 : 0;

    const label = new Int32Array(sw * sh).fill(-1);
    const blobs = [];
    const stack = [];
    for (let i = 0; i < small.length; i++) {
      if (!small[i] || label[i] >= 0) continue;
      const id = blobs.length;
      let area = 0, minX = sw, maxX = 0, minY = sh, maxY = 0;
      stack.push(i); label[i] = id;
      while (stack.length) {
        const p = stack.pop();
        const px = p % sw, py = (p / sw) | 0;
        area++;
        if (px < minX) minX = px; if (px > maxX) maxX = px;
        if (py < minY) minY = py; if (py > maxY) maxY = py;
        for (const q of [p - 1, p + 1, p - sw, p + sw]) {
          if (q < 0 || q >= small.length) continue;
          if (Math.abs((q % sw) - px) > 1) continue; // no row wrap
          if (small[q] && label[q] < 0) { label[q] = id; stack.push(q); }
        }
      }
      blobs.push({ area, minX, maxX, minY, maxY });
    }

    let boxes = blobs
      .filter(b => b.area / (sw * sh) >= MIN_BLOB_FRAC)
      .map(b => ({
        x0: Math.floor(b.minX / scale), x1: Math.ceil((b.maxX + 1) / scale),
        y0: Math.floor(b.minY / scale), y1: Math.ceil((b.maxY + 1) / scale),
      }));

    // merge boxes that overlap (mask holes can split one garment)
    let merged = true;
    while (merged) {
      merged = false;
      outer: for (let i = 0; i < boxes.length; i++) {
        for (let j = i + 1; j < boxes.length; j++) {
          const a = boxes[i], b = boxes[j];
          const ox = Math.min(a.x1, b.x1) - Math.max(a.x0, b.x0);
          const oy = Math.min(a.y1, b.y1) - Math.max(a.y0, b.y0);
          if (ox > 0 && oy > 0) {
            boxes[i] = { x0: Math.min(a.x0, b.x0), x1: Math.max(a.x1, b.x1), y0: Math.min(a.y0, b.y0), y1: Math.max(a.y1, b.y1) };
            boxes.splice(j, 1);
            merged = true;
            break outer;
          }
        }
      }
    }
    // fallback: nothing confident -> whole photo is one piece
    if (!boxes.length) boxes = [{ x0: 0, x1: w, y0: 0, y1: h, fullFallback: true }];
    return boxes;
  }

  // ---------------------------------------------------------------- product-photo rendering

  // Cutout of one piece as RGBA ImageData (alpha from the mask).
  function cutout(canvas, mask, box) {
    const w = canvas.width;
    const pad = Math.round(0.03 * Math.max(box.x1 - box.x0, box.y1 - box.y0));
    const x0 = Math.max(0, box.x0 - pad), y0 = Math.max(0, box.y0 - pad);
    const x1 = Math.min(canvas.width, box.x1 + pad), y1 = Math.min(canvas.height, box.y1 + pad);
    const cw = x1 - x0, ch = y1 - y0;
    const src = canvas.getContext('2d').getImageData(x0, y0, cw, ch);
    for (let y = 0; y < ch; y++)
      for (let x = 0; x < cw; x++) {
        const a = box.fullFallback ? 255 : mask[(y + y0) * w + (x + x0)];
        src.data[(y * cw + x) * 4 + 3] = a;
      }
    return src;
  }

  // Gray-world white balance + percentile luminance stretch on visible pixels.
  function autoAdjust(img) {
    const d = img.data;
    let n = 0, mr = 0, mg = 0, mb = 0;
    const lumas = [];
    for (let i = 0; i < d.length; i += 4) {
      if (d[i + 3] < 128) continue;
      n++; mr += d[i]; mg += d[i + 1]; mb += d[i + 2];
      lumas.push(0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2]);
    }
    if (n < 50) return img;
    mr /= n; mg /= n; mb /= n;
    const m = (mr + mg + mb) / 3;
    const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
    const sr = clamp(m / (mr || 1), 0.85, 1.2), sg = clamp(m / (mg || 1), 0.85, 1.2), sb = clamp(m / (mb || 1), 0.85, 1.2);
    lumas.sort((a, b) => a - b);
    const p2 = lumas[Math.floor(0.02 * lumas.length)], p98 = lumas[Math.floor(0.98 * lumas.length)];
    const span = Math.max(30, p98 - p2);
    const gain = Math.min(1.6, 235 / span);
    for (let i = 0; i < d.length; i += 4) {
      d[i] = clamp((d[i] * sr - p2) * gain + 15, 0, 255);
      d[i + 1] = clamp((d[i + 1] * sg - p2) * gain + 15, 0, 255);
      d[i + 2] = clamp((d[i + 2] * sb - p2) * gain + 15, 0, 255);
    }
    return img;
  }

  // Angle (degrees) that minimizes the piece's bounding box: straightens
  // photos taken at a tilt. Conservative: only applied when it clearly helps.
  function straightenAngle(img) {
    const pts = [];
    const stride = Math.max(1, Math.floor(Math.sqrt((img.width * img.height) / 1500)));
    for (let y = 0; y < img.height; y += stride)
      for (let x = 0; x < img.width; x += stride)
        if (img.data[(y * img.width + x) * 4 + 3] > 128) pts.push([x, y]);
    if (pts.length < 100) return 0;
    const area = a => {
      const r = (a * Math.PI) / 180, c = Math.cos(r), s = Math.sin(r);
      let minX = 1e9, maxX = -1e9, minY = 1e9, maxY = -1e9;
      for (const [x, y] of pts) {
        const rx = x * c - y * s, ry = x * s + y * c;
        if (rx < minX) minX = rx; if (rx > maxX) maxX = rx;
        if (ry < minY) minY = ry; if (ry > maxY) maxY = ry;
      }
      return (maxX - minX) * (maxY - minY);
    };
    const base = area(0);
    let best = 0, bestArea = base;
    for (let a = -27; a <= 27; a += 3) {
      const v = area(a);
      if (v < bestArea) { bestArea = v; best = a; }
    }
    return bestArea < base * 0.95 ? best : 0;
  }

  // Compose the final catalog shot: adjusted cutout, straightened, centered
  // on white, longest edge OUT_EDGE.
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
      const rc = document.createElement('canvas');
      rc.width = cw; rc.height = ch;
      const ctx = rc.getContext('2d');
      ctx.translate(cw / 2, ch / 2);
      ctx.rotate(r);
      ctx.drawImage(c, -c.width / 2, -c.height / 2);
      c = rc;
    }

    // trim to visible content
    const d = c.getContext('2d').getImageData(0, 0, c.width, c.height);
    let minX = c.width, maxX = 0, minY = c.height, maxY = 0;
    for (let y = 0; y < c.height; y++)
      for (let x = 0; x < c.width; x++)
        if (d.data[(y * c.width + x) * 4 + 3] > 20) {
          if (x < minX) minX = x; if (x > maxX) maxX = x;
          if (y < minY) minY = y; if (y > maxY) maxY = y;
        }
    if (maxX <= minX || maxY <= minY) { minX = 0; minY = 0; maxX = c.width - 1; maxY = c.height - 1; }
    const tw = maxX - minX + 1, th = maxY - minY + 1;
    const margin = Math.round(0.06 * Math.max(tw, th));
    const scale = Math.min(1, OUT_EDGE / (Math.max(tw, th) + 2 * margin));
    const out = document.createElement('canvas');
    out.width = Math.round((tw + 2 * margin) * scale);
    out.height = Math.round((th + 2 * margin) * scale);
    const octx = out.getContext('2d');
    octx.fillStyle = '#ffffff';
    octx.fillRect(0, 0, out.width, out.height);
    octx.drawImage(c, minX, minY, tw, th, margin * scale, margin * scale, tw * scale, th * scale);
    return out;
  }

  // ---------------------------------------------------------------- pixel color naming

  function hexToRgb(hex) {
    return [parseInt(hex.slice(1, 3), 16), parseInt(hex.slice(3, 5), 16), parseInt(hex.slice(5, 7), 16)];
  }
  const PALETTE_RGB = COLOR_NAMES.map(n => ({ name: n, rgb: hexToRgb(COLOR_HEX[n]) }));

  // "redmean" perceptual-ish RGB distance
  function colorDist(a, b) {
    const rm = (a[0] + b[0]) / 2;
    const dr = a[0] - b[0], dg = a[1] - b[1], db = a[2] - b[2];
    return Math.sqrt((2 + rm / 256) * dr * dr + 4 * dg * dg + (2 + (255 - rm) / 256) * db * db);
  }

  const GRAYS = ['black', 'charcoal', 'gray', 'light gray', 'white'];

  function nearestColorName(rgb) {
    // desaturated tones must land on the gray scale, never on a hue
    const sat = Math.max(...rgb) - Math.min(...rgb);
    const candidates = sat < 26 ? PALETTE_RGB.filter(p => GRAYS.includes(p.name)) : PALETTE_RGB;
    let best = candidates[0], bd = Infinity;
    for (const p of candidates) {
      const d = colorDist(rgb, p.rgb);
      if (d < bd) { bd = d; best = p; }
    }
    return best.name;
  }

  // Dominant garment colors via k-means over the cutout's visible pixels.
  function dominantColors(img) {
    const px = [];
    const stride = Math.max(1, Math.floor(Math.sqrt((img.width * img.height) / 4000)));
    for (let y = 0; y < img.height; y += stride)
      for (let x = 0; x < img.width; x += stride) {
        const i = (y * img.width + x) * 4;
        if (img.data[i + 3] > 200) px.push([img.data[i], img.data[i + 1], img.data[i + 2]]);
      }
    if (px.length < 30) return [{ name: 'gray', weight: 1 }];
    const K = 4;
    let centroids = Array.from({ length: K }, (_, k) => px[Math.floor((k + 0.5) * px.length / K)].slice());
    let assign = new Array(px.length).fill(0);
    for (let iter = 0; iter < 8; iter++) {
      for (let i = 0; i < px.length; i++) {
        let bd = Infinity, bk = 0;
        for (let k = 0; k < K; k++) {
          const d = colorDist(px[i], centroids[k]);
          if (d < bd) { bd = d; bk = k; }
        }
        assign[i] = bk;
      }
      const sums = Array.from({ length: K }, () => [0, 0, 0, 0]);
      for (let i = 0; i < px.length; i++) {
        const s = sums[assign[i]];
        s[0] += px[i][0]; s[1] += px[i][1]; s[2] += px[i][2]; s[3]++;
      }
      for (let k = 0; k < K; k++) if (sums[k][3]) centroids[k] = [sums[k][0] / sums[k][3], sums[k][1] / sums[k][3], sums[k][2] / sums[k][3]];
    }
    const weights = new Array(K).fill(0);
    for (const a of assign) weights[a]++;
    const named = {};
    for (let k = 0; k < K; k++) {
      if (!weights[k]) continue;
      const name = nearestColorName(centroids[k]);
      named[name] = (named[name] || 0) + weights[k] / px.length;
    }
    return Object.entries(named)
      .map(([name, weight]) => ({ name, weight }))
      .sort((a, b) => b.weight - a.weight);
  }

  // ---------------------------------------------------------------- CLIP classification

  async function embedCanvas(m, canvas) {
    const ctx = canvas.getContext('2d');
    const d = ctx.getImageData(0, 0, canvas.width, canvas.height);
    const raw = new m.T.RawImage(d.data, canvas.width, canvas.height, 4).rgb();
    const inputs = await m.processor(raw);
    const { image_embeds } = await m.vision(inputs);
    return normalize(Array.from(image_embeds.data));
  }

  const textCache = {};
  // one embedding per label = normalized mean over prompt templates
  async function ensembleTextEmbeds(m, labels, cacheKey) {
    if (textCache[cacheKey]) return textCache[cacheKey];
    const prompts = labels.flatMap(l => TEMPLATES.map(t => t.replace('{}', l)));
    const tokens = m.tokenizer(prompts, { padding: true, truncation: true });
    const { text_embeds } = await m.text(tokens);
    const dim = text_embeds.dims[1];
    const flat = Array.from(text_embeds.data);
    const out = labels.map((_, li) => meanVec(
      TEMPLATES.map((_, ti) => normalize(flat.slice((li * TEMPLATES.length + ti) * dim, (li * TEMPLATES.length + ti + 1) * dim)))
    ));
    textCache[cacheKey] = out;
    return out;
  }

  function classify(embed, labelEmbeds) {
    const sims = labelEmbeds.map(t => cosine(embed, t));
    const exps = sims.map(s => Math.exp(s * 100));
    const total = exps.reduce((a, b) => a + b, 0);
    let best = 0;
    for (let i = 1; i < sims.length; i++) if (sims[i] > sims[best]) best = i;
    return { index: best, confidence: exps[best] / total };
  }

  // ---------------------------------------------------------------- pieces & drafting

  // Phase 1 (RMBG only): one file -> one or more rendered pieces, NO
  // embeddings yet. Keeps the product canvas around for the CLIP phase.
  async function fileToRawPieces(r, file, sourceIndex, onProgress) {
    const canvas = await fileToCanvas(file);
    onProgress('removing background…');
    let mask;
    try {
      mask = await garmentMask(r, canvas);
    } catch (err) {
      console.warn('background removal failed, keeping the whole photo:', err);
      mask = null;
    }
    const boxes = mask ? findBlobs(mask, canvas.width, canvas.height) : [{ x0: 0, x1: canvas.width, y0: 0, y1: canvas.height, fullFallback: true }];
    const pieces = [];
    for (const box of boxes) {
      const img = cutout(canvas, mask || new Uint8Array(0), box);
      const colors = dominantColors(img);
      const product = productRender(img);
      const blob = await canvasToBlob(product);
      pieces.push({ blob, url: URL.createObjectURL(blob), colors, sourceIndex, _product: product });
    }
    return pieces;
  }

  // Phase 2 (CLIP only): embed the rendered pieces and release the canvases.
  async function embedPieces(m, pieces, onProgress) {
    for (let i = 0; i < pieces.length; i++) {
      if (pieces[i].embed) continue;
      onProgress(`reading garment ${i + 1} of ${pieces.length}…`);
      pieces[i].embed = await embedCanvas(m, pieces[i]._product);
      pieces[i]._product = null;
    }
  }

  // Cluster pieces into garments. Pieces cut from the SAME source photo are
  // different garments by construction and never merge.
  function clusterPieces(pieces) {
    const groups = [];
    const assigned = new Array(pieces.length).fill(-1);
    for (let i = 0; i < pieces.length; i++) {
      if (assigned[i] >= 0) continue;
      const g = [i];
      assigned[i] = groups.length;
      for (let j = i + 1; j < pieces.length; j++) {
        if (assigned[j] >= 0) continue;
        if (g.some(k => pieces[k].sourceIndex === pieces[j].sourceIndex)) continue;
        if (g.some(k => cosine(pieces[k].embed, pieces[j].embed) >= SAME_ITEM_THRESHOLD)) {
          g.push(j);
          assigned[j] = groups.length;
        }
      }
      groups.push(g);
    }
    return groups;
  }

  // Combine each group's pixel colors: primary = highest total weight.
  function groupColors(pieces) {
    const agg = {};
    for (const p of pieces) for (const c of p.colors) agg[c.name] = (agg[c.name] || 0) + c.weight;
    const sorted = Object.entries(agg).sort((a, b) => b[1] - a[1]);
    const total = sorted.reduce((s, [, w]) => s + w, 0) || 1;
    const out = [sorted[0][0]];
    if (sorted[1] && sorted[1][1] / total >= 0.25) out.push(sorted[1][0]);
    return out;
  }

  async function attributesFor(m, pieces) {
    const rep = meanVec(pieces.map(p => p.embed));
    const catEmbeds = await ensembleTextEmbeds(m, CATEGORY_LABELS.map(c => c.label), 'cat');
    const patEmbeds = await ensembleTextEmbeds(m, PATTERN_LABELS.map(p => p.label), 'pattern');
    const matEmbeds = await ensembleTextEmbeds(m, MATERIAL_LABELS.map(x => `clothing made of ${x}`), 'material');
    const cat = classify(rep, catEmbeds);
    const pat = classify(rep, patEmbeds);
    const mat = classify(rep, matEmbeds);
    const c = CATEGORY_LABELS[cat.index];
    const material = MATERIAL_LABELS[mat.index];
    const colors = groupColors(pieces);
    const needsMoreAngles = cat.confidence < 0.5 || pieces.length < 2;
    return {
      category: c.category, layer: c.layer,
      warmth: Math.min(5, Math.max(1, c.warmth + (MATERIAL_WARMTH[material] || 0))),
      formality: c.formality,
      waterResistant: !!c.waterResistant,
      color: colors[0], colors, pattern: PATTERN_LABELS[pat.index].value, material,
      confidence: { category: cat.confidence, pattern: pat.confidence, material: mat.confidence },
      needsMoreAngles,
    };
  }

  // ---------------------------------------------------------------- public API

  async function draftGroups(files, onProgress) {
    // phase 1: background removal on every photo, then free the model
    const r = await loadRMBG(onProgress);
    const pieces = [];
    for (let i = 0; i < files.length; i++) {
      onProgress(`photo ${i + 1} of ${files.length}: analyzing…`);
      pieces.push(...await fileToRawPieces(r, files[i], i, msg => onProgress(`photo ${i + 1} of ${files.length}: ${msg}`)));
    }
    await disposeRMBG();
    // phase 2: classification
    const m = await loadCLIP(onProgress);
    await embedPieces(m, pieces, onProgress);
    onProgress('grouping pieces into garments…');
    const groups = clusterPieces(pieces);
    const drafts = [];
    for (const idxs of groups) {
      const groupPieces = idxs.map(i => pieces[i]);
      drafts.push({ photos: groupPieces, ...(await attributesFor(m, groupPieces)) });
    }
    onProgress('');
    return drafts;
  }

  // Extra angles for an existing draft: process, append, re-draft attributes.
  async function addAnglesToDraft(draft, files, onProgress) {
    const r = await loadRMBG(onProgress);
    const fresh = [];
    for (let i = 0; i < files.length; i++) {
      onProgress(`extra angle ${i + 1} of ${files.length}: analyzing…`);
      const pieces = await fileToRawPieces(r, files[i], -1 - i, msg => onProgress(msg));
      // an "extra angle" photo should hold one piece; take the first if split
      fresh.push(pieces[0]);
    }
    await disposeRMBG();
    const m = await loadCLIP(onProgress);
    await embedPieces(m, fresh, onProgress);
    draft.photos.push(...fresh);
    Object.assign(draft, await attributesFor(m, draft.photos));
    onProgress('');
    return draft;
  }

  // ---------------------------------------------------------------- saving

  function slugify(s) {
    return s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '');
  }

  async function saveItem(draft) {
    const id = `${slugify(draft.name)}-${Date.now().toString(36)}`;
    const photoKeys = [];
    for (let i = 0; i < draft.photos.length; i++) {
      const key = `${id}-${i}`;
      await DBX.putPhoto(key, draft.photos[i].blob);
      photoKeys.push(key);
    }
    const item = {
      id, name: draft.name, category: draft.category, layer: draft.layer,
      colors: draft.colors && draft.colors.length ? [draft.color, ...draft.colors.filter(c => c !== draft.color)] : [draft.color],
      pattern: draft.pattern, material: draft.material,
      warmth: draft.warmth, formality: draft.formality,
      waterResistant: draft.waterResistant, photoKeys, user: true,
    };
    await DBX.putItem(item);
    return item;
  }

  async function addPhotosToItem(item, photos) {
    const photoKeys = [...(item.photoKeys || [])];
    for (let i = 0; i < photos.length; i++) {
      const key = `${item.id}-x${Date.now().toString(36)}-${i}`;
      await DBX.putPhoto(key, photos[i].blob);
      photoKeys.push(key);
    }
    await DBX.putItem({ ...item, photoKeys });
  }

  return {
    CATEGORY_LABELS, COLOR_NAMES, PATTERN_LABELS, MATERIAL_LABELS,
    draftGroups, addAnglesToDraft, saveItem, addPhotosToItem,
    // stage-by-stage access for headless pipeline tests
    _internals: { loadRMBG, loadCLIP, disposeRMBG, fileToCanvas, garmentMask, findBlobs, cutout, productRender, dominantColors },
  };
})();

if (typeof window !== 'undefined') window.CATALOGER = CATALOGER;
