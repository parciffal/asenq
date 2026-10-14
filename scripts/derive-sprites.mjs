import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const config = JSON.parse(readFileSync(join(root, "assets/characters/derive.json"), "utf8"));
const poses = ["idle_a", "idle_b", "walk_a", "walk_b", "work_a", "work_b", "send_a", "send_b"];
const outfits = ["claude", "codex", "gemini", "qwen", "llama", "mistral", "operator"];
const fail = (message) => { throw new Error(message); };
const clippingIssues = [];

function binary(name, args, maxBuffer = 64 * 1024 * 1024) {
  const result = spawnSync(name, args, { maxBuffer });
  if (result.error?.code === "ENOENT") fail("derive-sprites needs ffmpeg and ffprobe on PATH");
  if (result.error || result.status !== 0) fail(`${name}: ${result.error?.message ?? result.stderr.toString().trim()}`);
  return result.stdout;
}

function load(outfit) {
  const file = join(root, `assets/characters/source/${outfit}.png`);
  const metadata = JSON.parse(binary("ffprobe", ["-v", "error", "-select_streams", "v:0", "-show_entries", "stream=width,height", "-of", "json", file]).toString());
  const { width, height } = metadata.streams[0];
  const rgba = binary("ffmpeg", ["-v", "error", "-i", file, "-f", "rawvideo", "-pix_fmt", "rgba", "-"]);
  if (rgba.length !== width * height * 4) fail(`${outfit}: incomplete RGBA pixels`);
  return { width, height, rgba };
}

/** Iterative 8-connected full-resolution labeling, with deterministic scan order. */
function components(sheet) {
  const { width, height, rgba } = sheet;
  const labels = new Int32Array(width * height);
  const stack = new Int32Array(labels.length);
  const found = [];
  for (let start = 0; start < labels.length; start++) {
    if (labels[start] || rgba[start * 4 + 3] < config.maskAlpha) continue;
    const label = found.length + 1;
    labels[start] = label;
    let count = 0, sx = 0, sy = 0, length = 1;
    stack[0] = start;
    while (length) {
      const p = stack[--length];
      const x = p % width, y = Math.floor(p / width);
      count++; sx += x; sy += y;
      for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
        const nx = x + dx, ny = y + dy;
        if ((!dx && !dy) || nx < 0 || nx >= width || ny < 0 || ny >= height) continue;
        const next = ny * width + nx;
        if (labels[next] || rgba[next * 4 + 3] < config.maskAlpha) continue;
        labels[next] = label;
        stack[length++] = next;
      }
    }
    found.push({ label, count, x: sx / count, y: sy / count });
  }
  return { labels, found };
}

function clusters(values, count) {
  const sorted = [...values].sort((a, b) => a - b);
  let centers = Array.from({ length: count }, (_, i) => sorted[Math.round(i * (sorted.length - 1) / (count - 1))]);
  for (let iteration = 0; iteration < config.kmeansIterations; iteration++) {
    const sums = new Float64Array(count), sizes = new Uint32Array(count);
    for (const v of values) {
      const index = nearest(centers, v);
      sums[index] += v; sizes[index]++;
    }
    centers = centers.map((v, i) => sizes[i] ? sums[i] / sizes[i] : v).sort((a, b) => a - b);
  }
  return centers;
}

function nearest(centers, value) {
  let best = 0;
  for (let i = 1; i < centers.length; i++) if (Math.abs(centers[i] - value) < Math.abs(centers[best] - value)) best = i;
  return best;
}

function framesOf(sheet, outfit) {
  const { labels, found } = components(sheet);
  let bodies = found.filter((c) => c.count >= config.bodyMinPixels);
  const assignments = new Int32Array(found.length + 1).fill(-1);
  const frames = Array.from({ length: outfit === "operator" ? 8 : 48 }, () => []);
  if (outfit === "operator") {
    const reference = [...bodies].sort((a, b) => b.count - a.count || a.label - b.label)[0];
    bodies = bodies.filter((c) => c !== reference).sort((a, b) => Number(a.y >= sheet.height / 2) - Number(b.y >= sheet.height / 2) || a.x - b.x);
    if (bodies.length !== 8) fail(`${outfit}: expected 8 bodies after dropping reference, got ${bodies.length}`);
    for (const c of found) {
      if (c.count < config.componentMinPixels || c === reference) continue;
      let best = 0;
      for (let i = 1; i < bodies.length; i++) if (Math.hypot(c.x - bodies[i].x, c.y - bodies[i].y) < Math.hypot(c.x - bodies[best].x, c.y - bodies[best].y)) best = i;
      assignments[c.label] = best;
    }
  } else {
    if (bodies.length !== 48) fail(`${outfit}: expected 48 bodies, got ${bodies.length}`);
    const ys = clusters(bodies.map((c) => c.y), 6), xs = clusters(bodies.map((c) => c.x), 8);
    const occupied = new Set();
    for (const c of bodies) occupied.add(nearest(ys, c.y) * 8 + nearest(xs, c.x));
    if (occupied.size !== 48) fail(`${outfit}: body clustering did not yield all 6×8 frames`);
    for (const c of found) if (c.count >= config.componentMinPixels) assignments[c.label] = nearest(ys, c.y) * 8 + nearest(xs, c.x);
  }
  // Grow the assigned high-alpha components through their alpha>=128 edge pixels.
  // Multi-source breadth-first growth resolves any shared edge deterministically.
  const owners = new Int32Array(labels.length).fill(-1);
  const queue = new Int32Array(labels.length);
  let end = 0;
  for (let p = 0; p < labels.length; p++) {
    const frame = assignments[labels[p]];
    if (labels[p] && frame >= 0) { owners[p] = frame; queue[end++] = p; }
  }
  for (let begin = 0; begin < end; begin++) {
    const p = queue[begin], x = p % sheet.width, y = Math.floor(p / sheet.width);
    for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
      const nx = x + dx, ny = y + dy;
      if ((!dx && !dy) || nx < 0 || nx >= sheet.width || ny < 0 || ny >= sheet.height) continue;
      const next = ny * sheet.width + nx;
      if (owners[next] >= 0 || sheet.rgba[next * 4 + 3] < config.pixelAlpha || (labels[next] && assignments[labels[next]] < 0)) continue;
      owners[next] = owners[p]; queue[end++] = next;
    }
  }
  for (let p = 0; p < owners.length; p++) if (owners[p] >= 0) frames[owners[p]].push(p);
  return frames;
}

function bbox(pixels, width) {
  let left = Infinity, right = -Infinity, top = Infinity, bottom = -Infinity;
  for (const p of pixels) { const x = p % width, y = Math.floor(p / width); left = Math.min(left, x); right = Math.max(right, x); top = Math.min(top, y); bottom = Math.max(bottom, y); }
  return { left, right, top, bottom, height: bottom - top + 1 };
}

/** Population-weighted median-cut: widest channel, r>g>b ties. */
function paletteOf(sheet, frames) {
  const histogram = new Map();
  for (const frame of frames) for (const p of frame) {
    const offset = p * 4;
    const packed = (sheet.rgba[offset] << 16) | (sheet.rgba[offset + 1] << 8) | sheet.rgba[offset + 2];
    histogram.set(packed, (histogram.get(packed) ?? 0) + 1);
  }
  const pixels = [...histogram].sort(([a], [b]) => a - b).map(([packed, count]) => ({ rgb: [packed >> 16, (packed >> 8) & 255, packed & 255], count, packed }));
  // Preserve legitimate source whites in their own median-cut box: otherwise a
  // rare white polo/cap can be averaged into a much larger skin-color population.
  const white = [], other = [];
  for (const pixel of pixels) {
    const { sat, val } = hsv(pixel.rgb);
    (val >= 0.85 && sat <= 0.25 ? white : other).push(pixel);
  }
  let boxes = [other, white].filter((box) => box.length > 0);
  while (boxes.length < config.paletteSize) {
    let selected = -1, channel = 0, widest = -1;
    for (let i = 0; i < boxes.length; i++) {
      if (boxes[i].length < 2) continue;
      for (let c = 0; c < 3; c++) {
        let min = 255, max = 0;
        for (const pixel of boxes[i]) { min = Math.min(min, pixel.rgb[c]); max = Math.max(max, pixel.rgb[c]); }
        if (max - min > widest || (max - min === widest && c < channel)) { widest = max - min; selected = i; channel = c; }
      }
    }
    if (selected < 0) fail("not enough distinct colors for 12-color palette");
    const box = boxes[selected].sort((a, b) => a.rgb[channel] - b.rgb[channel] || a.packed - b.packed);
    const total = box.reduce((n, p) => n + p.count, 0);
    let sum = 0, split = 1;
    for (let i = 0; i < box.length - 1; i++) { sum += box[i].count; split = i + 1; if (sum >= total / 2) break; }
    boxes.splice(selected, 1, box.slice(0, split), box.slice(split));
  }
  return boxes.map((box) => {
    const total = box.reduce((n, p) => n + p.count, 0);
    return [0, 1, 2].map((c) => Math.round(box.reduce((n, p) => n + p.rgb[c] * p.count, 0) / total));
  });
}

function hsv([r, g, b]) {
  const max = Math.max(r, g, b), min = Math.min(r, g, b), delta = max - min;
  let hue = delta === 0 ? 0 : max === r ? ((g - b) / delta) % 6 : max === g ? (b - r) / delta + 2 : (r - g) / delta + 4;
  hue = (hue * 60 + 360) % 360;
  return { hue, sat: max === 0 ? 0 : delta / max, val: max / 255 };
}

function headBounds(grid, profile) {
  if (!profile.followHead) return { top: 0, bottom: profile.headRows };
  // Fitted web figures can begin below row 18. Follow their central silhouette,
  // ignoring outstretched hands, and scale the head span with the figure height.
  let top = grid.findIndex((row) => row.slice(Math.floor(profile.width / 4), Math.ceil(profile.width * 3 / 4)).some((pixel) => pixel !== "."));
  if (top < 0) top = 0;
  return { top, bottom: Math.min(profile.height, top + Math.min(profile.headRows, Math.ceil((profile.height - top) / 4))) };
}

function neutralWeb(variant, recolored) {
  const frames = Object.fromEntries(poses.map((pose) => [pose, variant.frames[pose].split("\n").map((row) => [...row])]));
  const keep = new Set();
  for (const grid of Object.values(frames)) {
    const { top, bottom } = headBounds(grid, config.web);
    for (let y = top; y < bottom; y++) for (const pixel of grid[y]) if (pixel !== ".") keep.add(variant.palette[parseInt(pixel, 12)]);
  }
  // Preserve source head/skin colors and reserve at least one neutral garment
  // shade. Quantize rare overflow colors within the 12-color browser contract.
  variant.palette.forEach((color, i) => { if (color === recolored[i]) keep.add(color); });
  const shades = new Map();
  for (const grid of Object.values(frames)) for (const row of grid) for (const pixel of row) if (pixel !== ".") {
    const color = recolored[parseInt(pixel, 12)];
    if (!keep.has(color)) shades.set(color, (shades.get(color) ?? 0) + 1);
  }
  const neutral = [...shades].sort(([a, n], [b, m]) => m - n || (a < b ? -1 : a > b ? 1 : 0)).map(([color]) => color);
  const palette = [...[...keep].slice(0, config.paletteSize - (neutral.length ? 1 : 0)), ...neutral].slice(0, config.paletteSize);
  const rgb = (hex) => [1, 3, 5].map((offset) => parseInt(hex.slice(offset, offset + 2), 16));
  const colors = palette.map(rgb);
  const indexOf = (hex) => {
    const exact = palette.indexOf(hex);
    if (exact >= 0) return exact.toString(12);
    const source = rgb(hex);
    let best = 0, distance = Infinity;
    for (const [i, color] of colors.entries()) {
      const d = color.reduce((sum, channel, j) => sum + (channel - source[j]) ** 2, 0);
      if (d < distance) { best = i; distance = d; }
    }
    return best.toString(12);
  };
  return { palette, frames: Object.fromEntries(poses.map((pose) => {
    const grid = frames[pose], { top, bottom } = headBounds(grid, config.web);
    return [pose, grid.map((row, y) => row.map((pixel) => pixel === "." ? "." : indexOf((y >= top && y < bottom ? variant.palette : recolored)[parseInt(pixel, 12)])).join("")).join("\n")];
  })) };
}

function deriveVariant(sheet, frames, outfit, variant, profile) {
  const boxes = frames.map((f) => bbox(f, sheet.width));
  const initialScale = profile.baseline / boxes[0].height;
  const torsoCenters = frames.map((frame, frameIndex) => {
    const box = boxes[frameIndex];
    let torsoX = 0, torsoCount = 0;
    for (const p of frame) {
      const y = Math.floor(p / sheet.width) - box.top;
      if (y >= box.height * 0.35 && y <= box.height * 0.6) { torsoX += p % sheet.width; torsoCount++; }
    }
    if (!torsoCount) fail(`${outfit} row ${variant + 1} ${poses[frameIndex]}: missing torso`);
    return torsoX / torsoCount;
  });
  const fits = (scale) => frames.every((frame, frameIndex) => {
    let lost = 0;
    const box = boxes[frameIndex], torso = torsoCenters[frameIndex];
    for (const p of frame) {
      const x0 = profile.anchorX + (p % sheet.width - torso) * scale;
      const y0 = profile.baseline + 1 + (Math.floor(p / sheet.width) - box.bottom - 1) * scale;
      const inside = Math.max(0, Math.min(profile.width, x0 + scale) - Math.max(0, x0)) * Math.max(0, Math.min(profile.height, y0 + scale) - Math.max(0, y0));
      lost += 1 - inside / (scale * scale);
    }
    return lost / frame.length <= config.clipLimit;
  });
  let scale = initialScale;
  if (!fits(initialScale)) {
    let low = 0, high = initialScale;
    for (let i = 0; i < config.scaleFit.iterations; i++) {
      const middle = (low + high) / 2;
      if (fits(middle)) low = middle; else high = middle;
    }
    scale = low;
    console.error(`${outfit} row ${variant + 1}: shared scale fit ${initialScale.toFixed(12)} -> ${scale.toFixed(12)}`);
  }
  const palette = paletteOf(sheet, frames);
  const colorCache = new Map();
  const indexOf = (p) => {
    const offset = p * 4;
    const packed = (sheet.rgba[offset] << 16) | (sheet.rgba[offset + 1] << 8) | sheet.rgba[offset + 2];
    if (colorCache.has(packed)) return colorCache.get(packed);
    const rgb = [sheet.rgba[offset], sheet.rgba[offset + 1], sheet.rgba[offset + 2]];
    let best = 0, distance = Infinity;
    for (let i = 0; i < palette.length; i++) {
      const d = palette[i].reduce((sum, c, j) => sum + (c - rgb[j]) ** 2, 0);
      if (d < distance) { distance = d; best = i; }
    }
    colorCache.set(packed, best);
    return best;
  };
  const frequencies = new Uint32Array(palette.length);
  let population = 0;
  for (const frame of frames) for (const p of frame) { frequencies[indexOf(p)]++; population++; }
  const features = palette.map((rgb, i) => { const { sat, val } = hsv(rgb); return sat >= 0.55 && val >= 0.65 && frequencies[i] / population < 0.04; });
  const whiteFeatures = palette.map((rgb) => { const { sat, val } = hsv(rgb); return val >= 0.85 && sat <= 0.25; });
  const grids = frames.map((frame, frameIndex) => {
    const box = boxes[frameIndex];
    const torso = torsoCenters[frameIndex];
    const area = new Float64Array(profile.width * profile.height);
    const votes = Array.from({ length: area.length }, () => new Float64Array(palette.length));
    let lost = 0;
    for (const p of frame) {
      const x0 = profile.anchorX + (p % sheet.width - torso) * scale, x1 = x0 + scale;
      const y0 = profile.baseline + 1 + (Math.floor(p / sheet.width) - box.bottom - 1) * scale, y1 = y0 + scale;
      const inside = Math.max(0, Math.min(profile.width, x1) - Math.max(0, x0)) * Math.max(0, Math.min(profile.height, y1) - Math.max(0, y0));
      lost += 1 - inside / (scale * scale);
      const index = indexOf(p);
      for (let y = Math.max(0, Math.floor(y0)); y < Math.min(profile.height, Math.ceil(y1)); y++) for (let x = Math.max(0, Math.floor(x0)); x < Math.min(profile.width, Math.ceil(x1)); x++) {
        const coverage = Math.max(0, Math.min(x + 1, x1) - Math.max(x, x0)) * Math.max(0, Math.min(y + 1, y1) - Math.max(y, y0));
        area[y * profile.width + x] += coverage;
        votes[y * profile.width + x][index] += coverage;
      }
    }
    if (lost / frame.length > config.clipLimit) clippingIssues.push(`${outfit} row ${variant + 1} ${poses[frameIndex]}: clipped ${(lost / frame.length * 100).toFixed(3)}% of opaque pixels (>2%)`);
    return Array.from({ length: profile.height }, (_, y) => Array.from({ length: profile.width }, (_, x) => {
      const p = y * profile.width + x;
      if (area[p] < config.coverage) return ".";
      let best = 0, feature = -1, whiteFeature = -1;
      for (let i = 0; i < palette.length; i++) {
        if (votes[p][i] > votes[p][best]) best = i;
        if (features[i] && votes[p][i] >= 0.2 && (feature < 0 || votes[p][i] > votes[p][feature])) feature = i;
        if (whiteFeatures[i] && votes[p][i] >= 0.2 && (whiteFeature < 0 || votes[p][i] > votes[p][whiteFeature])) whiteFeature = i;
      }
      return (feature >= 0 ? feature : whiteFeature >= 0 ? whiteFeature : best).toString(12);
    }));
  });
  const headCentroid = (grid) => {
    let x = 0, y = 0, count = 0;
    const { top, bottom } = headBounds(grid, profile);
    for (let row = top; row < bottom; row++) for (let col = 0; col < profile.width; col++) if (grid[row][col] !== ".") { x += col; y += row; count++; }
    return count ? { x: x / count, y: y / count } : { x: profile.anchorX, y: profile.headRows / 2 };
  };
  for (const pose of profile.headFix[outfit]?.[String(variant + 1)] ?? []) {
    const i = poses.indexOf(pose);
    if (i < 0) fail(`${outfit}: unknown headFix pose ${pose}`);
    const base = headCentroid(grids[0]), target = headCentroid(grids[i]);
    const dx = Math.round(target.x - base.x), dy = Math.round(target.y - base.y);
    const baseBounds = headBounds(grids[0], profile), targetBounds = headBounds(grids[i], profile);
    for (let y = targetBounds.top; y < targetBounds.bottom; y++) for (let x = 0; x < profile.width; x++) {
      const sourceY = y - dy;
      grids[i][y][x] = sourceY >= baseBounds.top && sourceY < baseBounds.bottom ? grids[0][sourceY]?.[x - dx] ?? "." : ".";
    }
  }
  return { palette: palette.map((rgb) => `#${rgb.map((v) => v.toString(16).padStart(2, "0")).join("")}`), frames: Object.fromEntries(poses.map((pose, i) => [pose, grids[i].map((row) => row.join("")).join("\n")])) };
}

function generate() {
  const detailedProfile = { width: config.width, height: config.height, baseline: config.baseline, anchorX: config.anchorX, headRows: 9, headFix: config.headFix };
  const detailed = {}, web = {};
  for (const outfit of outfits) {
    const sheet = load(outfit), frames = framesOf(sheet, outfit);
    const variants = Array.from({ length: outfit === "operator" ? 1 : 6 }, (_, variant) => frames.slice(variant * 8, variant * 8 + 8));
    detailed[outfit] = variants.map((frames, variant) => deriveVariant(sheet, frames, outfit, variant, detailedProfile));
    web[outfit] = variants.map((frames, variant) => deriveVariant(sheet, frames, outfit, variant, config.web));
  }
  if (clippingIssues.length) fail(clippingIssues.join("\n"));
  for (const profile of [detailed, web]) profile.neutral = profile.mistral.map((variant, row) => ({ ...variant, palette: variant.palette.map((hex, index) => {
    const rgb = [1, 3, 5].map((offset) => parseInt(hex.slice(offset, offset + 2), 16));
    const { hue, sat, val } = hsv(rgb), n = config.neutral;
    if ((config.neutralKeep[String(row + 1)] ?? []).includes(index) || hue < n.hueMin || hue > n.hueMax || sat < n.saturationMin || val < n.valueMin) return hex;
    const g = Math.round(255 * (0.18 + 0.5 * val));
    return `#${[g, g, Math.min(255, g + 8)].map((v) => v.toString(16).padStart(2, "0")).join("")}`;
  }) }));
  web.neutral = web.mistral.map((variant, row) => neutralWeb(variant, web.neutral[row].palette));
  return { detailed, web };
}

function preview(detailed, outfit) {
  if (!Object.hasOwn(detailed, outfit)) fail(`unknown outfit ${outfit}`);
  // 168 columns × 85 output rows for six variants; operator is 168 × 15.
  console.log(`${outfit}: ${poses.join("  ")}`);
  for (const [variantIndex, variant] of detailed[outfit].entries()) {
    console.log(`variant ${variantIndex + 1}`);
    const frames = poses.map((pose) => variant.frames[pose].split("\n"));
    for (let y = 0; y < config.height; y += 2) {
      let line = "";
      for (const frame of frames) {
        for (let x = 0; x < config.width; x++) {
          const top = frame[y][x], bottom = frame[y + 1][x];
          if (top === "." && bottom === ".") { line += "\x1b[0m "; continue; }
          const fg = top !== "." ? top : bottom;
          const rgb = [1, 3, 5].map((o) => parseInt(variant.palette[parseInt(fg, 12)].slice(o, o + 2), 16));
          line += `\x1b[0m\x1b[38;2;${rgb.join(";")}m`;
          if (top !== "." && bottom !== "." && top !== bottom) {
            const bg = [1, 3, 5].map((o) => parseInt(variant.palette[parseInt(bottom, 12)].slice(o, o + 2), 16));
            line += `\x1b[48;2;${bg.join(";")}m▀`;
          } else line += top === "." ? "▄" : bottom === "." ? "▀" : "█";
        }
        line += "\x1b[0m ";
      }
      console.log(line + "\x1b[0m");
    }
    console.log("");
  }
}

function png(web, outfit, path) {
  if (!Object.hasOwn(web, outfit)) fail(`unknown outfit ${outfit}`);
  const scale = 4, gap = 4;
  const width = poses.length * (config.web.width * scale + gap) + gap;
  const height = web[outfit].length * (config.web.height * scale + gap) + gap;
  const rgba = Buffer.alloc(width * height * 4);
  for (let p = 0; p < rgba.length; p += 4) { rgba[p] = 0x10; rgba[p + 1] = 0x06; rgba[p + 2] = 0x09; rgba[p + 3] = 255; }
  for (const [row, variant] of web[outfit].entries()) for (const [col, pose] of poses.entries()) {
    const frame = variant.frames[pose].split("\n");
    const palette = variant.palette.map((hex) => [1, 3, 5].map((offset) => parseInt(hex.slice(offset, offset + 2), 16)));
    for (let y = 0; y < config.web.height; y++) for (let x = 0; x < config.web.width; x++) {
      if (frame[y][x] === ".") continue;
      const rgb = palette[parseInt(frame[y][x], 12)];
      for (let dy = 0; dy < scale; dy++) for (let dx = 0; dx < scale; dx++) {
        const p = ((gap + row * (config.web.height * scale + gap) + y * scale + dy) * width + gap + col * (config.web.width * scale + gap) + x * scale + dx) * 4;
        rgba[p] = rgb[0]; rgba[p + 1] = rgb[1]; rgba[p + 2] = rgb[2];
      }
    }
  }
  const result = spawnSync("ffmpeg", ["-v", "error", "-y", "-f", "rawvideo", "-pix_fmt", "rgba", "-s", `${width}x${height}`, "-i", "-", "-frames:v", "1", path], { input: rgba, maxBuffer: 64 * 1024 * 1024 });
  if (result.error?.code === "ENOENT") fail("derive-sprites needs ffmpeg and ffprobe on PATH");
  if (result.error || result.status !== 0) fail(`ffmpeg: ${result.error?.message ?? result.stderr.toString().trim()}`);
  console.log(`generated ${path}`);
}

try {
  const args = process.argv.slice(2);
  if (!(args.length === 0 || (args.length === 1 && args[0] === "--check") || (args.length === 2 && args[0] === "--preview") || (args.length === 3 && args[0] === "--png"))) fail("usage: node scripts/derive-sprites.mjs [--check | --preview <outfit|operator|neutral> | --png <outfit|operator|neutral> <path>]");
  const { detailed, web } = generate();
  const output = "// Generated by scripts/derive-sprites.mjs from assets/characters/source; do not edit.\n" +
    'import type { Outfit } from "./appearance.js";\nimport type { DetailedVariant } from "./cast.js";\n\n' +
    `export const DETAILED: Record<Outfit | "operator", readonly DetailedVariant[]> = ${JSON.stringify(detailed, null, 2)};\n`;
  const path = join(root, "src/viz/cast-detailed.ts");
  const webPath = join(root, "web/city/assets/characters.json");
  const webOutput = JSON.stringify({ width: config.web.width, height: config.web.height, poses, outfits: web }) + "\n";
  if (args[0] === "--preview") preview(detailed, args[1]);
  else if (args[0] === "--png") png(web, args[1], args[2]);
  else if (args[0] === "--check") {
    for (const [file, expected] of [[path, output], [webPath, webOutput]]) {
      let existing;
      try { existing = readFileSync(file, "utf8"); } catch { fail(`${file} is missing; run node scripts/derive-sprites.mjs`); }
      if (existing !== expected) fail(`${file} differs; run node scripts/derive-sprites.mjs`);
    }
    console.log("cast-detailed.ts and characters.json match deterministic derivation");
  } else {
    mkdirSync(dirname(webPath), { recursive: true });
    writeFileSync(path, output); writeFileSync(webPath, webOutput);
    console.log("generated src/viz/cast-detailed.ts and web/city/assets/characters.json");
  }
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
