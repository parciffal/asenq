import { PAL } from "./palette.js";
import { STREET } from "../mapkit.js";

function rect(ctx, color, x, y, width, height) {
  ctx.fillStyle = color;
  ctx.fillRect(x, y, width, height);
}

function frame(ctx, color, x, y, width, height) {
  rect(ctx, color, x, y, width, 1);
  rect(ctx, color, x, y + height - 1, width, 1);
  rect(ctx, color, x, y, 1, height);
  rect(ctx, color, x + width - 1, y, 1, height);
}

function lamp(ctx, x) {
  // Pixel halos, not blurred gradients: nearest-neighbour art stays crisp.
  rect(ctx, PAL.glass, x - 11, 23, 25, 6);
  rect(ctx, PAL.cyanDark, x - 7, 25, 17, 4);
  rect(ctx, PAL.steel, x - 3, 28, 7, 3);
  rect(ctx, PAL.steelLight, x, 8, 2, 21);
  rect(ctx, PAL.void, x + 2, 8, 1, 21);
  rect(ctx, PAL.steel, x - 8, 6, 11, 3);
  rect(ctx, PAL.cyanDark, x - 9, 8, 8, 3);
  rect(ctx, PAL.white, x - 8, 8, 6, 1);
  rect(ctx, PAL.border, x, 24, 2, 2);
}

/** x0 and width are world pixels, not cells. Place at world (x0, STREET.top).
 * Local y 0..47 = upper sidewalk; 48..119 = road; 120..143 = lower sidewalk.
 * World-phased details keep adjacent tiles and resized strips aligned.
 */
export function paintStreetTile(canvas, x0, width) {
  canvas.width = width;
  canvas.height = STREET.height;
  const ctx = canvas.getContext("2d");
  ctx.imageSmoothingEnabled = false;
  rect(ctx, PAL.sidewalk, 0, 0, width, STREET.roadTop);
  rect(ctx, PAL.road, 0, STREET.roadTop, width, STREET.roadHeight);
  rect(ctx, PAL.sidewalk, 0, STREET.lowerTop, width, STREET.height - STREET.lowerTop);
  for (let y = 0; y < STREET.roadTop; y += 8) {
    rect(ctx, PAL.steel, 0, y, width, 1);
    for (let worldX = Math.floor((x0 - 8) / 16) * 16; worldX < x0 + width; worldX += 16) {
      rect(ctx, PAL.panel, worldX - x0 + (y % 16 ? 8 : 0), y + 1, 1, 7);
    }
  }
  for (let y = STREET.lowerTop; y < STREET.height; y += 8) {
    rect(ctx, PAL.steel, 0, y, width, 1);
    for (let worldX = Math.floor(x0 / 16) * 16; worldX < x0 + width; worldX += 16) {
      rect(ctx, PAL.panel, worldX - x0 + (y % 16 ? 8 : 0), y + 1, 1, 7);
    }
  }
  rect(ctx, PAL.steelLight, 0, STREET.roadTop - 2, width, 1);
  rect(ctx, PAL.void, 0, STREET.roadTop - 1, width, 2);
  rect(ctx, PAL.steelLight, 0, STREET.lowerTop, width, 1);
  rect(ctx, PAL.void, 0, STREET.height - 1, width, 1);
  // Fine road wear is periodic, with no vehicles or simulated message activity.
  for (let worldX = Math.floor(x0 / 64) * 64; worldX < x0 + width; worldX += 64) {
    rect(ctx, PAL.grid, worldX - x0 + 7, STREET.roadTop + 8, 9, 1);
    rect(ctx, PAL.grid, worldX - x0 + 25, STREET.lowerTop - 10, 13, 1);
    rect(ctx, PAL.steel, worldX - x0 + 46, STREET.lowerTop - 4, 2, 1);
  }
  for (let worldX = Math.floor(x0 / 48) * 48; worldX < x0 + width; worldX += 48) {
    rect(ctx, PAL.orange, worldX - x0 + 8, STREET.roadTop + STREET.roadHeight / 2 - 1, 18, 1);
    rect(ctx, PAL.panel, worldX - x0 + 8, STREET.roadTop + STREET.roadHeight / 2 + 1, 18, 1);
  }
  // One crossing per 48-cell venue strip, centred at its +160px entrance.
  for (let base = Math.floor((x0 - 192) / 384) * 384; base < x0 + width; base += 384) {
    const x = base + 148 - x0;
    rect(ctx, PAL.road, x, STREET.roadTop, 24, STREET.roadHeight);
    for (let y = STREET.roadTop + 3; y < STREET.lowerTop - 1; y += 6) rect(ctx, PAL.steelLight, x, y, 24, 3);
    rect(ctx, PAL.yellow, x, STREET.roadTop - 4, 24, 1);
    rect(ctx, PAL.yellow, x, STREET.lowerTop + 3, 24, 1);
  }
  for (let worldX = Math.floor(x0 / 96) * 96; worldX < x0 + width + 96; worldX += 96) {
    const x = worldX + 48 - x0;
    lamp(ctx, x);
    rect(ctx, PAL.void, x + 20, 26, 11, 3);
    for (let dx = 1; dx < 10; dx += 3) rect(ctx, PAL.steel, x + 20 + dx, 26, 1, 3);
  }
  return canvas;
}

const PROCESS = {
  P: "110101110100100", R: "110101110101101", O: "111101101101111",
  C: "111100100100111", E: "111100110100111", S: "111100111001111",
};

function processPlate(ctx) {
  rect(ctx, PAL.void, 66, 5, 55, 11);
  frame(ctx, PAL.ghost, 66, 5, 55, 11);
  let x = 80;
  for (const letter of "PROCESS") {
    const glyph = PROCESS[letter];
    for (let i = 0; i < 15; i++) if (glyph[i] === "1") rect(ctx, PAL.ghost, x + i % 3, 8 + Math.floor(i / 3), 1, 1);
    x += 4;
  }
}

function terminal(ctx, trim) {
  rect(ctx, PAL.steel, 77, 19, 37, 26);
  frame(ctx, PAL.steelLight, 77, 19, 37, 26);
  rect(ctx, PAL.void, 79, 21, 33, 22);
  frame(ctx, trim, 81, 23, 29, 17);
  rect(ctx, PAL.glass, 82, 24, 27, 15);
  rect(ctx, PAL.cyan, 85, 27, 17, 1);
  rect(ctx, PAL.cyanDark, 85, 30, 21, 1);
  rect(ctx, PAL.cyan, 85, 33, 3, 1);
  rect(ctx, PAL.cyanDark, 90, 33, 12, 1);
  rect(ctx, PAL.steelLight, 74, 45, 43, 4);
  rect(ctx, PAL.panel, 76, 46, 39, 2);
  for (let x = 82; x < 104; x += 4) rect(ctx, PAL.steelLight, x, 46, 2, 1);
  rect(ctx, trim, 109, 46, 3, 1);
  rect(ctx, PAL.steel, 80, 49, 3, 11);
  rect(ctx, PAL.steel, 109, 49, 3, 11);
  rect(ctx, PAL.panel, 86, 51, 17, 6);
  frame(ctx, PAL.steel, 86, 51, 17, 6);
  rect(ctx, PAL.cyanDark, 89, 53, 7, 1);
}

/** Fixed 128x64 canvas. Place at (character.rect.x * 8, character.rect.y * 8).
 * The character stands at local (40, 62); scenery never draws an occupant.
 */
export function paintWorkstation(canvas, kind) {
  if (kind !== "session" && kind !== "process" && kind !== "operator") {
    throw new RangeError("paintWorkstation requires session, process or operator");
  }
  canvas.width = 128;
  canvas.height = 64;
  const ctx = canvas.getContext("2d");
  ctx.imageSmoothingEnabled = false;
  if (kind === "process") {
    for (let x = 3; x < 125; x += 8) {
      rect(ctx, PAL.ghost, x, 2, 4, 1);
      rect(ctx, PAL.ghost, x, 62, 4, 1);
    }
    for (let y = 3; y < 62; y += 8) {
      rect(ctx, PAL.ghost, 2, y, 1, 4);
      rect(ctx, PAL.ghost, 125, y, 1, 4);
    }
    frame(ctx, PAL.steel, 77, 25, 32, 23);
    frame(ctx, PAL.cyanDark, 80, 28, 26, 16);
    rect(ctx, PAL.ghost, 82, 45, 5, 1);
    rect(ctx, PAL.steel, 73, 49, 40, 1);
    rect(ctx, PAL.steel, 78, 50, 1, 9);
    rect(ctx, PAL.steel, 108, 50, 1, 9);
    processPlate(ctx);
    return canvas;
  }
  const trim = kind === "operator" ? PAL.yellow : PAL.cyan;
  rect(ctx, PAL.sidewalk, 3, 59, 122, 5);
  rect(ctx, PAL.steelLight, 5, 59, 118, 1);
  rect(ctx, PAL.void, 8, 62, 112, 2);
  rect(ctx, PAL.panel, 6, 3, 116, 4);
  rect(ctx, PAL.steelLight, 6, 3, 116, 1);
  rect(ctx, trim, 9, 6, 110, 1);
  rect(ctx, PAL.steel, 8, 7, 3, 51);
  rect(ctx, PAL.steel, 118, 7, 3, 51);
  rect(ctx, PAL.void, 11, 7, 1, 51);
  rect(ctx, PAL.void, 117, 7, 1, 51);
  rect(ctx, PAL.panel, 68, 9, 49, 50);
  frame(ctx, PAL.steel, 68, 9, 49, 50);
  for (let y = 12; y < 57; y += 8) rect(ctx, PAL.wall, 70, y, 45, 1);
  terminal(ctx, trim);
  rect(ctx, trim, 13, 55, 45, 1);
  rect(ctx, PAL.steel, 16, 57, 39, 1);
  rect(ctx, PAL.cyanDark, 12, 9, 1, 40);
  rect(ctx, PAL.white, 22, 7, 19, 1);
  if (kind === "operator") {
    frame(ctx, PAL.yellow, 4, 1, 120, 62);
    rect(ctx, PAL.yellow, 70, 11, 45, 1);
    rect(ctx, PAL.yellow, 16, 61, 38, 1);
    rect(ctx, PAL.steel, 58, 38, 9, 18);
    rect(ctx, PAL.cyan, 60, 41, 5, 5);
    rect(ctx, PAL.cyanDark, 60, 48, 5, 3);
    rect(ctx, PAL.yellow, 60, 54, 5, 1);
  } else {
    rect(ctx, PAL.redDark, 15, 15, 4, 15);
    rect(ctx, PAL.cyan, 16, 18, 2, 6);
    rect(ctx, PAL.cyanDark, 16, 27, 2, 2);
  }
  return canvas;
}
