import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const output = join(root, "web/city/assets");

function ffmpeg(args, input) {
  const result = spawnSync("ffmpeg", ["-v", "error", ...args], { input, maxBuffer: 64 * 1024 * 1024 });
  if (result.error?.code === "ENOENT") throw new Error("pixelize-backdrop needs ffmpeg on PATH");
  if (result.error || result.status !== 0) throw new Error(`ffmpeg: ${result.error?.message ?? result.stderr.toString().trim()}`);
  return result.stdout;
}

// Normalize the generated black/transparent sky to the requested magenta key.
// Flood only sky-connected black; never key enclosed dark building interiors.
function keySky(file) {
  const png = readFileSync(file);
  const width = png.readUInt32BE(16), height = png.readUInt32BE(20);
  const rgba = ffmpeg(["-i", file, "-f", "rawvideo", "-pix_fmt", "rgba", "-"]);
  if (rgba.length !== width * height * 4) throw new Error("incomplete mid-layer RGBA pixels");
  const queue = new Uint32Array(width * height);
  let end = 0;
  const visit = (p) => {
    const offset = p * 4;
    if (rgba[offset] > 8 || rgba[offset + 1] > 8 || rgba[offset + 2] > 8) return;
    rgba[offset] = 255; rgba[offset + 1] = 0; rgba[offset + 2] = 255; rgba[offset + 3] = 255;
    queue[end++] = p;
  };
  for (let x = 0; x < width; x++) visit(x);
  for (let start = 0; start < end; start++) {
    const p = queue[start], x = p % width;
    if (x > 0) visit(p - 1);
    if (x + 1 < width) visit(p + 1);
    if (p >= width) visit(p - width);
    if (p + width < width * height) visit(p + width);
  }
  // colorkey replaces input alpha; turn existing transparency into key color
  // too, including open gaps isolated from the sky by the elevated highway.
  for (let offset = 0; offset < rgba.length; offset += 4) if (rgba[offset + 3] === 0) {
    rgba[offset] = 255; rgba[offset + 1] = 0; rgba[offset + 2] = 255; rgba[offset + 3] = 255;
  }
  return { width, height, rgba };
}

try {
  mkdirSync(output, { recursive: true });
  for (const layer of ["far", "mid"]) {
    const key = layer === "mid" ? ",colorkey=0xff00ff:0.25:0.05" : "";
    const graph = `[0:v]scale=480:-2:flags=area,crop=480:270:0:ih-270,format=rgba${key},split[colors][image];` +
      "[colors]palettegen=max_colors=24:reserve_transparent=1[palette];" +
      "[image][palette]paletteuse=dither=none,format=rgba,split[a][mirror];" +
      "[mirror]hflip[b];[a][b]hstack,format=rgba[out]";
    const file = join(output, `skyline-${layer}.png`);
    const source = join(root, `assets/city/source/skyline-${layer}.png`);
    const sky = layer === "mid" ? keySky(source) : null;
    const input = sky ? ["-f", "rawvideo", "-pix_fmt", "rgba", "-s", `${sky.width}x${sky.height}`, "-i", "-"] : ["-i", source];
    ffmpeg(["-y", ...input, "-filter_complex", graph, "-map", "[out]", "-frames:v", "1", file], sky?.rgba);
    console.log(`generated web/city/assets/skyline-${layer}.png (960×270)`);
  }
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
