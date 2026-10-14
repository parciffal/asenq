import { PAL } from "./palette.js";

const EARTH = "#120a0f";
const EARTH_DARK = "#0d070b";

function rect(ctx, color, x, y, width, height) {
  ctx.fillStyle = color;
  ctx.fillRect(x, y, width, height);
}

function rng(seed) {
  return () => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed / 0x100000000; };
}

function earth(ctx, y0, height, seed) {
  const rand = rng(seed);
  rect(ctx, EARTH, 0, y0, 384, height);
  for (let y = y0 + 3; y < y0 + height; y += 5 + Math.floor(rand() * 4)) {
    for (let x = Math.floor(rand() * 20); x < 384; x += 14 + Math.floor(rand() * 30)) {
      rect(ctx, rand() > 0.5 ? PAL.grid : EARTH_DARK, x, y, 4 + Math.floor(rand() * 14), 1);
    }
  }
  for (let i = 0; i < height / 3; i++) {
    const x = Math.floor(rand() * 382), y = y0 + Math.floor(rand() * (height - 2));
    rect(ctx, rand() > 0.85 ? PAL.panel : "#22121a", x, y, 2, rand() > 0.6 ? 2 : 1);
  }
}

/** Repeating 384x80 service-tunnel level. Place at world y=STREET.bottom (112, under the street),
 * x phased to multiples of 384 so shafts line up with the street crossings (+148px).
 * Level n sits at 112+80n, matching off-venue street workstations (rect.y*8, 64px canvas).
 * Local 0..63 is the tunnel (street workstations stand on its floor at 59..64); 64..79 is bedrock.
 */
export function paintTunnelTile(canvas) {
  canvas.width = 384;
  canvas.height = 80;
  const ctx = canvas.getContext("2d");
  ctx.imageSmoothingEnabled = false;
  // Back wall.
  rect(ctx, PAL.wall, 0, 0, 384, 64);
  for (let y = 16; y < 56; y += 10) rect(ctx, PAL.grid, 0, y, 384, 1);
  for (let y = 16, row = 0; y < 56; y += 10, row++) {
    for (let x = row % 2 ? 0 : 16; x < 384; x += 32) rect(ctx, PAL.grid, x, y + 1, 1, 9);
  }
  rect(ctx, PAL.redDark, 0, 46, 384, 2);
  rect(ctx, PAL.border, 0, 46, 384, 1);
  // Ceiling slab + utility pipes.
  rect(ctx, PAL.void, 0, 0, 384, 2);
  rect(ctx, PAL.panel, 0, 2, 384, 5);
  rect(ctx, PAL.steel, 0, 7, 384, 1);
  for (let x = 0; x < 384; x += 32) rect(ctx, PAL.void, x, 2, 1, 5);
  rect(ctx, PAL.cyanDark, 0, 9, 384, 3);
  rect(ctx, PAL.cyan, 0, 9, 384, 1);
  rect(ctx, PAL.redDark, 0, 13, 384, 2);
  rect(ctx, PAL.steel, 0, 15, 384, 1);
  for (let x = 20; x < 384; x += 48) {
    rect(ctx, PAL.steelLight, x, 8, 2, 8);
    rect(ctx, PAL.void, x + 2, 8, 1, 8);
  }
  // Ceiling lights, phased with the street lamps (+48px every 96px).
  for (let x = 48; x < 384; x += 96) {
    rect(ctx, PAL.steel, x - 6, 16, 14, 2);
    rect(ctx, PAL.white, x - 5, 18, 12, 1);
    rect(ctx, PAL.glass, x - 9, 19, 18, 3);
    rect(ctx, PAL.glass, x - 5, 22, 10, 2);
  }
  // Wayfinding pips.
  for (let x = 88; x < 384; x += 192) {
    rect(ctx, PAL.void, x, 30, 18, 7);
    rect(ctx, PAL.yellow, x + 2, 32, 2, 3);
    rect(ctx, PAL.cyanDark, x + 6, 33, 10, 1);
  }
  // Floor.
  rect(ctx, PAL.sidewalk, 0, 58, 384, 6);
  rect(ctx, PAL.steelLight, 0, 58, 384, 1);
  for (let x = 0; x < 384; x += 16) rect(ctx, PAL.steel, x, 59, 1, 4);
  rect(ctx, PAL.void, 0, 63, 384, 1);
  // Bedrock between levels.
  earth(ctx, 64, 16, 0x7a11c0de);
  rect(ctx, PAL.void, 0, 64, 384, 1);
  // Access shaft under each crossing (+148..+172).
  rect(ctx, PAL.void, 150, 0, 20, 80);
  rect(ctx, PAL.steel, 150, 0, 2, 80);
  rect(ctx, PAL.steel, 168, 0, 2, 80);
  for (let y = 2; y < 80; y += 5) rect(ctx, PAL.steelLight, 152, y, 16, 1);
  rect(ctx, PAL.yellow, 148, 58, 2, 6);
  rect(ctx, PAL.yellow, 170, 58, 2, 6);
  return canvas;
}

/** Repeating 384x64 deep bedrock, tiled below the last tunnel level. */
export function paintBedrockTile(canvas) {
  canvas.width = 384;
  canvas.height = 64;
  const ctx = canvas.getContext("2d");
  ctx.imageSmoothingEnabled = false;
  earth(ctx, 0, 64, 0x5eedbeef);
  const rand = rng(0xc0ffee11);
  for (let i = 0; i < 3; i++) {
    const x = Math.floor(rand() * 360), y = 8 + Math.floor(rand() * 48);
    rect(ctx, PAL.cyanDark, x, y, 10 + Math.floor(rand() * 14), 1);
  }
  return canvas;
}
