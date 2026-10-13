import { HARNESS_COLORS } from "./palette.js";

export function characterTextureKey(appearance, pose, harness = null) {
  const suffix = appearance.outfit === "neutral" && harness !== null && Object.hasOwn(HARNESS_COLORS, harness) ? `:${harness}` : "";
  return `ch:${appearance.outfit}:${appearance.variant}:${pose}${suffix}`;
}

export function harnessPalette(palette, color) {
  const tint = [1, 3, 5].map((start) => Number.parseInt(color.slice(start, start + 2), 16));
  return palette.map((entry) => {
    const rgb = [1, 3, 5].map((start) => Number.parseInt(entry.slice(start, start + 2), 16));
    const light = Math.max(...rgb);
    if (light - Math.min(...rgb) > 16 || light < 0x90) return entry;
    return "#" + tint.map((channel) => Math.min(255, Math.round(channel * light / 0xab)).toString(16).padStart(2, "0")).join("");
  });
}

export async function loadCharacterTextures(scene) {
  const response = await fetch("/assets/characters.json", { cache: "force-cache" });
  if (!response.ok) throw new Error(`Unable to load character art (${response.status})`);
  const sheet = await response.json();
  if (sheet.width !== 32 || sheet.height !== 48 || !Array.isArray(sheet.poses) || !sheet.outfits) {
    throw new Error("Invalid character art data");
  }
  for (const [outfit, variants] of Object.entries(sheet.outfits)) {
    if (!Array.isArray(variants)) throw new Error(`Invalid ${outfit} character variants`);
    variants.forEach((variant, index) => {
      for (const pose of sheet.poses) {
        const frame = variant.frames?.[pose];
        if (typeof frame !== "string") throw new Error(`Missing ${outfit} ${pose} character frame`);
        const canvas = frameCanvas(sheet.width, sheet.height, variant.palette, frame, `${outfit} ${pose}`);
        const key = `ch:${outfit}:${index}:${pose}`;
        if (scene.textures.exists(key)) scene.textures.remove(key);
        scene.textures.addCanvas(key, canvas);
        if (outfit === "neutral") {
          for (const [harness, color] of Object.entries(HARNESS_COLORS)) {
            const tintedKey = characterTextureKey({ outfit, variant: index }, pose, harness);
            const tintedCanvas = frameCanvas(sheet.width, sheet.height, harnessPalette(variant.palette, color), frame, `${outfit} ${pose} ${harness}`);
            if (scene.textures.exists(tintedKey)) scene.textures.remove(tintedKey);
            scene.textures.addCanvas(tintedKey, tintedCanvas);
          }
        }
      }
    });
  }
  return sheet;
}

export function textureFor(appearance, pose, harness = null) {
  return characterTextureKey(appearance, pose, harness);
}

function frameCanvas(width, height, palette, frame, label) {
  if (!Array.isArray(palette)) throw new Error(`Invalid palette for ${label}`);
  const rows = frame.replace(/\r/g, "").split("\n");
  if (rows.length !== height || rows.some((row) => row.length !== width)) throw new Error(`Invalid dimensions for ${label}`);
  const colors = palette.map((color) => {
    if (typeof color !== "string" || !/^#[0-9a-f]{6}$/i.test(color)) throw new Error(`Invalid palette color for ${label}`);
    return [Number.parseInt(color.slice(1, 3), 16), Number.parseInt(color.slice(3, 5), 16), Number.parseInt(color.slice(5, 7), 16), 255];
  });
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext("2d", { alpha: true });
  if (!context) throw new Error("Canvas 2D context is unavailable");
  const image = context.createImageData(width, height);
  for (let y = 0; y < height; y++) {
    const row = rows[y];
    for (let x = 0; x < width; x++) {
      const char = row[x];
      if (char === ".") continue;
      const index = Number.parseInt(char, 36);
      const color = colors[index];
      if (!Number.isInteger(index) || !color) throw new Error(`Invalid palette index in ${label}`);
      const offset = (y * width + x) * 4;
      image.data[offset] = color[0];
      image.data[offset + 1] = color[1];
      image.data[offset + 2] = color[2];
      image.data[offset + 3] = color[3];
    }
  }
  context.putImageData(image, 0, 0);
  return canvas;
}
