import { PAL } from "./palette.js";

const DIGITS = ["111101101101111", "010110010010111", "111001111100111", "111001111001111", "101101111001001", "111100111001111", "111100111101111", "111001010010010", "111101111101111", "111101111001111"];

function random(seed) {
  let value = seed >>> 0;
  return () => {
    value = (Math.imul(value, 1664525) + 1013904223) >>> 0;
    return value / 4294967296;
  };
}

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

function monitor(ctx, x, y, width = 18, height = 14) {
  rect(ctx, PAL.steel, x - 1, y - 1, width + 2, height + 2);
  rect(ctx, PAL.glass, x, y, width, height);
  frame(ctx, PAL.cyanDark, x, y, width, height);
  rect(ctx, PAL.cyan, x + 2, y + 3, width - 5, 1);
  rect(ctx, PAL.cyanDark, x + 2, y + 6, width - 7, 1);
  rect(ctx, PAL.cyan, x + 2, y + 9, 3, 1);
  rect(ctx, PAL.steelLight, x + Math.floor(width / 2) - 1, y + height, 2, 3);
  rect(ctx, PAL.steel, x + Math.floor(width / 2) - 4, y + height + 3, 8, 1);
}

function light(ctx, x, width) {
  rect(ctx, PAL.cyanDark, x - 2, 2, width + 4, 5);
  rect(ctx, PAL.white, x, 3, width, 2);
  rect(ctx, PAL.glass, x + 2, 7, width - 4, 2);
}

function office(ctx, rng) {
  light(ctx, 18, 28);
  light(ctx, 96, 28);
  // Wall chart and filing cabinet; the left foreground remains a character bay.
  rect(ctx, PAL.steel, 9, 15, 20, 21);
  rect(ctx, PAL.wall, 10, 16, 18, 19);
  for (let i = 0; i < 4; i++) {
    rect(ctx, i % 2 ? PAL.cyanDark : PAL.cyan, 13 + i * 3, 28 - i * 2, 2, 5 + i * 2);
  }
  rect(ctx, PAL.steel, 66, 19, 12, 30);
  for (let y = 21; y < 48; y += 9) {
    frame(ctx, PAL.steelLight, 67, y, 10, 7);
    rect(ctx, PAL.white, 71, y + 2, 3, 1);
  }
  rect(ctx, PAL.panel, 84, 39, 54, 6);
  rect(ctx, PAL.orange, 84, 39, 54, 1);
  rect(ctx, PAL.steel, 88, 45, 3, 15);
  rect(ctx, PAL.steel, 132, 45, 3, 15);
  monitor(ctx, 89, 20);
  monitor(ctx, 113, 23, 20, 12);
  rect(ctx, PAL.steelLight, 97, 38, 17, 1);
  rect(ctx, PAL.white, 124, 36, 3, 3);
  rect(ctx, PAL.steel, 116, 47, 10, 8);
  rect(ctx, PAL.steelLight, 116, 47, 10, 2);
  rect(ctx, PAL.steel, 120, 55, 2, 6);
  rect(ctx, PAL.steel, 114, 60, 14, 1);
  rect(ctx, PAL.panel, 6, 54, 8, 6);
  rect(ctx, PAL.green, 8, 45, 2, 9);
  rect(ctx, PAL.green, 5, 48, 8, 3);
  if (rng() > 0.5) rect(ctx, PAL.orange, 80, 15, 3, 6);
}

function bar(ctx, rng) {
  rect(ctx, PAL.redDark, 7, 10, 130, 30);
  for (const y of [19, 31]) {
    rect(ctx, PAL.orange, 8, y, 128, 2);
    rect(ctx, PAL.panel, 8, y + 2, 128, 2);
    for (let x = 10; x < 136; x += 8) {
      const height = 4 + Math.floor(rng() * 5);
      const color = rng() > 0.5 ? PAL.green : PAL.orange;
      rect(ctx, color, x, y - height, 3, height);
      rect(ctx, PAL.white, x + 1, y - height - 2, 1, 2);
      rect(ctx, PAL.panel, x, y - 3, 3, 1);
    }
  }
  for (const x of [24, 96]) {
    rect(ctx, PAL.steel, x, 0, 1, 8);
    rect(ctx, PAL.orange, x - 4, 8, 9, 3);
    rect(ctx, PAL.white, x - 2, 11, 5, 2);
  }
  rect(ctx, PAL.panel, 64, 41, 74, 13);
  rect(ctx, PAL.redDark, 68, 45, 66, 8);
  rect(ctx, PAL.orange, 62, 39, 78, 3);
  rect(ctx, PAL.white, 63, 39, 76, 1);
  for (const x of [73, 98, 124]) {
    rect(ctx, PAL.border, x, 54, 10, 3);
    rect(ctx, PAL.orange, x + 1, 54, 8, 1);
    rect(ctx, PAL.steelLight, x + 4, 57, 2, 5);
    rect(ctx, PAL.steel, x + 1, 62, 8, 1);
  }
  rect(ctx, PAL.cyan, 78, 34, 3, 5);
  rect(ctx, PAL.white, 91, 35, 3, 4);
  // Fixed BAR motif, not a channel label; no font or external asset is needed.
  rect(ctx, PAL.void, 112, 4, 22, 13);
  frame(ctx, PAL.border, 112, 4, 22, 13);
  const glyphs = ["110101110101110", "010101111101101", "110101110101101"];
  for (let letter = 0; letter < glyphs.length; letter++) {
    for (let i = 0; i < 15; i++) {
      if (glyphs[letter][i] === "1") rect(ctx, PAL.alert, 116 + letter * 5 + i % 3, 8 + Math.floor(i / 3), 1, 1);
    }
  }
}

function garage(ctx, rng) {
  rect(ctx, PAL.steel, 0, 0, 144, 15);
  for (let y = 1; y < 15; y += 4) {
    rect(ctx, PAL.steelLight, 2, y, 140, 1);
    rect(ctx, PAL.wall, 2, y + 2, 140, 1);
  }
  rect(ctx, PAL.wall, 7, 21, 24, 24);
  frame(ctx, PAL.steel, 7, 21, 24, 24);
  for (const x of [11, 18, 25]) {
    rect(ctx, PAL.steelLight, x, 25, 2, 12);
    rect(ctx, PAL.steelLight, x - 1, 24, 4, 2);
    rect(ctx, PAL.orange, x, 36, 2, 3);
  }
  light(ctx, 68, 38);
  rect(ctx, PAL.redDark, 66, 56, 73, 3);
  // Parked vehicle silhouette, never moving street traffic.
  rect(ctx, PAL.steel, 93, 32, 28, 3);
  rect(ctx, PAL.steel, 87, 35, 39, 12);
  rect(ctx, PAL.glass, 92, 35, 27, 9);
  rect(ctx, PAL.cyanDark, 94, 36, 24, 1);
  rect(ctx, PAL.steel, 75, 45, 63, 10);
  rect(ctx, PAL.steelLight, 78, 45, 57, 2);
  rect(ctx, PAL.void, 82, 51, 11, 9);
  rect(ctx, PAL.void, 123, 51, 11, 9);
  rect(ctx, PAL.steelLight, 85, 54, 5, 4);
  rect(ctx, PAL.steelLight, 126, 54, 5, 4);
  rect(ctx, PAL.white, 76, 48, 4, 2);
  rect(ctx, PAL.alert, 135, 48, 3, 2);
  rect(ctx, PAL.border, 58, 40, 3, 19);
  rect(ctx, PAL.steelLight, 55, 58, 9, 2);
  rect(ctx, PAL.panel, 9, 51, 19, 10);
  rect(ctx, PAL.border, 9, 51, 19, 2);
  for (let y = 54; y < 60; y += 3) rect(ctx, PAL.steelLight, 12, y, 12, 1);
  if (rng() > 0.5) rect(ctx, PAL.orange, 65, 23, 5, 8);
}

function arcade(ctx, rng) {
  light(ctx, 12, 18);
  rect(ctx, PAL.magenta, 67, 7, 66, 2);
  rect(ctx, PAL.redDark, 67, 10, 66, 1);
  for (let i = 0; i < 3; i++) {
    const x = 65 + i * 25;
    const color = [PAL.cyan, PAL.magenta, PAL.yellow][i];
    rect(ctx, PAL.steel, x, 18, 21, 40);
    rect(ctx, PAL.void, x + 2, 21, 17, 19);
    frame(ctx, color, x + 3, 22, 15, 15);
    rect(ctx, PAL.glass, x + 4, 23, 13, 13);
    for (let n = 0; n < 6; n++) {
      rect(ctx, color, x + 5 + Math.floor(rng() * 10), 25 + Math.floor(rng() * 9), 2, 2);
    }
    rect(ctx, color, x + 2, 19, 17, 1);
    rect(ctx, PAL.panel, x, 41, 22, 5);
    rect(ctx, PAL.steelLight, x + 2, 41, 18, 1);
    rect(ctx, PAL.alert, x + 5, 39, 2, 3);
    rect(ctx, PAL.yellow, x + 13, 43, 2, 1);
    rect(ctx, PAL.void, x + 2, 48, 17, 9);
    rect(ctx, color, x + 8, 51, 5, 1);
    rect(ctx, PAL.redDark, x - 1, 58, 24, 2);
  }
  frame(ctx, PAL.magenta, 9, 16, 17, 23);
  rect(ctx, PAL.cyan, 13, 21, 3, 3);
  rect(ctx, PAL.yellow, 19, 27, 3, 3);
  rect(ctx, PAL.magenta, 13, 33, 9, 1);
}

function communications(ctx, rng) {
  light(ctx, 13, 22);
  for (const x of [68, 92, 116]) {
    rect(ctx, PAL.steel, x, 12, 21, 48);
    rect(ctx, PAL.void, x + 2, 14, 17, 43);
    frame(ctx, PAL.steelLight, x, 12, 21, 48);
    for (let y = 16; y < 56; y += 8) {
      rect(ctx, PAL.panel, x + 3, y, 15, 6);
      rect(ctx, PAL.steelLight, x + 4, y + 1, 9, 1);
      rect(ctx, PAL.cyanDark, x + 4, y + 3, 8, 1);
      rect(ctx, rng() > 0.25 ? PAL.cyan : PAL.yellow, x + 15, y + 2, 2, 2);
    }
    rect(ctx, PAL.cyanDark, x + 9, 60, 2, 3);
  }
  monitor(ctx, 9, 19, 20, 18);
  rect(ctx, PAL.panel, 7, 43, 25, 4);
  rect(ctx, PAL.steel, 9, 47, 2, 13);
  rect(ctx, PAL.steel, 28, 47, 2, 13);
  rect(ctx, PAL.cyanDark, 52, 4, 1, 56);
  rect(ctx, PAL.cyanDark, 52, 58, 84, 1);
  for (let y = 12; y < 55; y += 10) rect(ctx, PAL.steelLight, 50, y, 5, 1);
}

function house(ctx, rng) {
  // Window with a sky strip; left floor bay stays empty.
  rect(ctx, PAL.steelLight, 11, 11, 26, 23);
  rect(ctx, PAL.glass, 13, 13, 22, 19);
  rect(ctx, PAL.cyanDark, 13, 13, 22, 6);
  rect(ctx, PAL.cyan, 13, 13, 22, 1);
  rect(ctx, PAL.steelLight, 23, 13, 2, 19);
  rect(ctx, PAL.redDark, 9, 11, 3, 25);
  rect(ctx, PAL.redDark, 36, 11, 3, 25);
  // Bookshelf.
  rect(ctx, PAL.steel, 50, 14, 24, 30);
  for (const y of [15, 25, 35]) {
    rect(ctx, PAL.void, 51, y, 22, 8);
    for (let x = 52; x < 72; x += 3) {
      const color = [PAL.alert, PAL.cyan, PAL.orange, PAL.green, PAL.magenta][Math.floor(rng() * 5)];
      rect(ctx, color, x, y + 8 - 5 - Math.floor(rng() * 3), 2, 5 + Math.floor(rng() * 3));
    }
    rect(ctx, PAL.steelLight, 50, y + 8, 24, 1);
  }
  // Rug and sofa.
  rect(ctx, PAL.redDark, 80, 58, 56, 4);
  rect(ctx, PAL.border, 80, 58, 56, 1);
  rect(ctx, PAL.panel, 86, 34, 36, 12);
  rect(ctx, PAL.border, 86, 34, 36, 2);
  rect(ctx, PAL.panel, 82, 40, 6, 16);
  rect(ctx, PAL.panel, 120, 40, 6, 16);
  rect(ctx, PAL.border, 88, 46, 32, 10);
  rect(ctx, PAL.redDark, 88, 52, 32, 4);
  rect(ctx, PAL.steel, 85, 56, 2, 3);
  rect(ctx, PAL.steel, 121, 56, 2, 3);
  rect(ctx, PAL.orange, 91, 42, 6, 5);
  // Floor lamp with warm glow.
  rect(ctx, PAL.steelLight, 131, 24, 1, 33);
  rect(ctx, PAL.steel, 128, 57, 7, 2);
  rect(ctx, PAL.orange, 127, 17, 9, 7);
  rect(ctx, PAL.yellow, 129, 20, 5, 2);
  rect(ctx, PAL.redDark, 123, 5, 17, 1);
  // Plant.
  rect(ctx, PAL.panel, 60, 52, 8, 7);
  rect(ctx, PAL.green, 63, 42, 2, 10);
  rect(ctx, PAL.green, 59, 44, 4, 3);
  rect(ctx, PAL.green, 66, 46, 4, 3);
  if (rng() > 0.5) rect(ctx, PAL.orange, 78, 10, 3, 5);
}

function server(ctx, rng) {
  // Cable tray overhead.
  rect(ctx, PAL.steel, 44, 6, 96, 4);
  rect(ctx, PAL.steelLight, 44, 6, 96, 1);
  for (let x = 48; x < 138; x += 9) rect(ctx, PAL.cyanDark, x, 10, 1, 4);
  const leds = [PAL.cyan, PAL.yellow, PAL.green];
  // Two rows of racks, three racks each at the back, the cooling unit in front.
  for (let row = 0; row < 2; row++) {
    const y = row ? 40 : 15;
    const h = row ? 20 : 24;
    for (let i = 0; i < 4; i++) {
      const x = 48 + i * 22;
      rect(ctx, PAL.steel, x, y, 18, h);
      rect(ctx, PAL.void, x + 2, y + 2, 14, h - 4);
      frame(ctx, PAL.steelLight, x, y, 18, h);
      for (let yy = y + 3; yy < y + h - 4; yy += 4) {
        rect(ctx, PAL.panel, x + 3, yy, 8, 2);
        rect(ctx, leds[Math.floor(rng() * 3)], x + 13, yy, 2, 1);
        if (rng() > 0.4) rect(ctx, leds[Math.floor(rng() * 3)], x + 13, yy + 2, 2, 1);
      }
    }
  }
  rect(ctx, PAL.panel, 8, 17, 22, 18);
  frame(ctx, PAL.steel, 8, 17, 22, 18);
  for (let y = 20; y < 33; y += 3) rect(ctx, PAL.steelLight, 11, y, 16, 1);
  rect(ctx, PAL.cyan, 26, 19, 2, 1);
}

function library(ctx, rng) {
  const spines = [PAL.alert, PAL.cyan, PAL.orange, PAL.green, PAL.magenta, PAL.yellow];
  // Tall shelves across the back wall; left bay stays open.
  for (let i = 0; i < 3; i++) {
    const x = 46 + i * 31;
    rect(ctx, PAL.steel, x, 4, 28, 54);
    for (let y = 6; y < 54; y += 12) {
      rect(ctx, PAL.void, x + 2, y, 24, 10);
      for (let bx = x + 3; bx < x + 24; bx += 3) {
        const h = 6 + Math.floor(rng() * 4);
        rect(ctx, spines[Math.floor(rng() * spines.length)], bx, y + 10 - h, 2, h);
      }
      rect(ctx, PAL.steelLight, x + 1, y + 10, 26, 1);
    }
  }
  // Ladder against the shelf.
  rect(ctx, PAL.orange, 38, 8, 1, 50);
  rect(ctx, PAL.orange, 43, 8, 1, 50);
  for (let y = 12; y < 56; y += 6) rect(ctx, PAL.orange, 38, y, 6, 1);
  // Reading table and lamp.
  rect(ctx, PAL.panel, 96, 47, 30, 3);
  rect(ctx, PAL.orange, 96, 47, 30, 1);
  rect(ctx, PAL.steel, 99, 50, 2, 10);
  rect(ctx, PAL.steel, 121, 50, 2, 10);
  rect(ctx, PAL.steelLight, 108, 43, 1, 4);
  rect(ctx, PAL.orange, 105, 40, 7, 3);
  rect(ctx, PAL.yellow, 106, 43, 5, 1);
  rect(ctx, PAL.white, 113, 45, 6, 2);
}

function lab(ctx, rng) {
  // Hazard stripe along the ceiling edge.
  for (let x = 2; x < 142; x += 8) {
    rect(ctx, PAL.yellow, x, 3, 4, 3);
    rect(ctx, PAL.void, x + 4, 3, 4, 3);
  }
  // Wall chart (left, above the bay) and whiteboard grid.
  rect(ctx, PAL.steel, 9, 12, 22, 20);
  rect(ctx, PAL.white, 10, 13, 20, 18);
  for (let i = 0; i < 5; i++) rect(ctx, i % 2 ? PAL.cyanDark : PAL.alert, 12 + i * 3, 29 - (3 + i * 2), 2, 3 + i * 2);
  rect(ctx, PAL.steel, 50, 12, 38, 24);
  rect(ctx, PAL.white, 51, 13, 36, 22);
  for (let x = 57; x < 87; x += 6) rect(ctx, PAL.steelLight, x, 13, 1, 22);
  for (let y = 19; y < 35; y += 6) rect(ctx, PAL.steelLight, 51, y, 36, 1);
  rect(ctx, PAL.cyan, 54, 16, 8, 1);
  rect(ctx, PAL.alert, 66, 22, 10, 1);
  // Workbench.
  rect(ctx, PAL.panel, 56, 46, 80, 5);
  rect(ctx, PAL.cyan, 56, 46, 80, 1);
  rect(ctx, PAL.steel, 60, 51, 3, 10);
  rect(ctx, PAL.steel, 128, 51, 3, 10);
  // Glass vessels.
  for (let i = 0; i < 3; i++) {
    const x = 66 + i * 9;
    const color = [PAL.green, PAL.orange, PAL.cyan][i];
    rect(ctx, PAL.glass, x, 36 + i, 6, 10 - i);
    frame(ctx, PAL.steelLight, x, 36 + i, 6, 10 - i);
    rect(ctx, color, x + 1, 41 + i, 4, 4 - i);
    rect(ctx, PAL.white, x + 2, 34 + i, 2, 2);
  }
  // Scope monitor.
  monitor(ctx, 108, 26, 20, 12);
  rect(ctx, PAL.steelLight, 100, 40, 6, 6);
  rect(ctx, rng() > 0.5 ? PAL.alert : PAL.green, 102, 42, 2, 2);
}

const INTERIORS = { office, bar, garage, arcade, communications, house, server, library, lab };
const ROOM_KINDS = Object.keys(INTERIORS);

// Small integer hash (xorshift-multiply) so a room's kind never depends on the shared rng.
function mix(a, b, c) {
  let h = (Math.imul(a >>> 0, 0x9e3779b1) ^ Math.imul((b + 1) | 0, 0x85ebca6b) ^ Math.imul((c + 1) | 0, 0xc2b2ae35)) >>> 0;
  h ^= h >>> 15; h = Math.imul(h, 0x2c1b3c6d) >>> 0;
  h ^= h >>> 12; h = Math.imul(h, 0x297a2d39) >>> 0;
  return (h ^ (h >>> 15)) >>> 0;
}

/** kinds: ground-left is `appearance`; others hashed from (seed, floor, side), differing from the other
 * room on the floor and from the room below. Floors resolve bottom-up so floor n depends only on floors <= n. */
function pickKind(seed, appearance, floor, side, below, sibling) {
  if (floor === 0 && side === 0) return appearance;
  const avoid = new Set([below, sibling]);
  let choices = ROOM_KINDS.filter((kind) => !avoid.has(kind));
  if (choices.length === 0) choices = ROOM_KINDS.filter((kind) => kind !== sibling);
  return choices[mix(seed, floor, side) % choices.length];
}

function room(ctx, x, y, interior, rng) {
  ctx.save();
  ctx.translate(x, y);
  ctx.beginPath();
  ctx.rect(0, 0, 144, 64);
  ctx.clip();
  rect(ctx, PAL.wall, 0, 0, 144, 64);
  rect(ctx, PAL.grid, 2, 2, 140, 41);
  for (let yy = 10; yy < 42; yy += 10) {
    rect(ctx, PAL.panel, 2, yy, 140, 1);
    for (let xx = yy % 20 ? 12 : 28; xx < 140; xx += 32) rect(ctx, PAL.panel, xx, yy - 9, 1, 9);
  }
  rect(ctx, PAL.sidewalk, 1, 43, 142, 20);
  for (let yy = 46; yy < 64; yy += 8) rect(ctx, PAL.steel, 1, yy, 142, 1);
  for (let xx = 4; xx < 144; xx += 16) rect(ctx, PAL.panel, xx, 44, 1, 19);
  interior(ctx, rng);
  frame(ctx, PAL.cyanDark, 0, 0, 144, 64);
  rect(ctx, PAL.cyan, 0, 0, 144, 1);
  rect(ctx, PAL.cyanDark, 0, 63, 144, 1);
  rect(ctx, PAL.steelLight, 1, 62, 142, 1);
  ctx.restore();
}

function floorLabel(ctx, floor, y) {
  rect(ctx, PAL.void, 153, y, 14, 9);
  rect(ctx, PAL.white, 154, y + 2, 1, 5);
  rect(ctx, PAL.white, 154, y + 6, 3, 1);
  let x = 159;
  for (const digit of String(floor)) {
    const glyph = DIGITS[Number(digit)];
    for (let i = 0; i < 15; i++) if (glyph[i] === "1") rect(ctx, PAL.white, x + i % 3, y + 2 + Math.floor(i / 3), 1, 1);
    x += 4;
  }
}

function roof(ctx, appearance, rng) {
  rect(ctx, PAL.panel, 4, 17, 312, 31);
  rect(ctx, PAL.steelLight, 4, 17, 312, 2);
  rect(ctx, PAL.steel, 1, 44, 318, 4);
  rect(ctx, PAL.border, 0, 47, 320, 1);
  // Empty sign frame: the scene alone owns the authoritative channel label.
  rect(ctx, PAL.void, 12, 24, 250, 18);
  frame(ctx, PAL.border, 12, 24, 250, 18);
  rect(ctx, PAL.redDark, 16, 40, 242, 1);
  for (let x = 18; x < 254; x += 14) rect(ctx, PAL.grid, x, 26, 1, 13);
  rect(ctx, PAL.steel, 19, 8, 37, 9);
  rect(ctx, PAL.steelLight, 19, 8, 37, 1);
  for (let x = 22; x < 54; x += 4) rect(ctx, PAL.void, x, 11, 2, 5);
  rect(ctx, PAL.steel, 77, 10, 20, 7);
  frame(ctx, PAL.steelLight, 77, 10, 20, 7);
  rect(ctx, PAL.steel, 109, 13, 70, 4);
  rect(ctx, PAL.steelLight, 109, 13, 70, 1);
  rect(ctx, PAL.steel, 220, 3, 2, 14);
  rect(ctx, PAL.steelLight, 212, 7, 18, 1);
  rect(ctx, PAL.alert, 220, 2, 2, 2);
  rect(ctx, PAL.redDark, 270, 25, 35, 13);
  for (let x = 274; x < 302; x += 6) rect(ctx, rng() > 0.5 ? PAL.cyanDark : PAL.steel, x, 28, 3, 7);
  if (appearance === "communications") {
    rect(ctx, PAL.steelLight, 284, 1, 2, 23);
    rect(ctx, PAL.steel, 274, 23, 23, 2);
    rect(ctx, PAL.steelLight, 275, 7, 20, 2);
    rect(ctx, PAL.white, 277, 9, 16, 2);
    rect(ctx, PAL.steelLight, 279, 11, 12, 2);
    rect(ctx, PAL.cyan, 284, 3, 2, 3);
    rect(ctx, PAL.steel, 302, 10, 2, 34);
    rect(ctx, PAL.alert, 302, 8, 2, 2);
  }
}

/** Canvas origin: (venue.rect.x * 8, venue.rect.y * 8 - 48).
 * Ground floor is floor 0; its rooms start at local y = 48 + 80 * (floors - 1) + 8.
 * All geometry is integer pixel art; no occupant or message state is painted here.
 */
export function paintVenue(canvas, { appearance, floors, roomsPerFloor = 2, seed }) {
  if (!Number.isInteger(floors) || floors < 1 || roomsPerFloor !== 2 || !Object.hasOwn(INTERIORS, appearance)) {
    throw new RangeError("paintVenue requires a known appearance, positive floors and two rooms per floor");
  }
  canvas.width = 320;
  canvas.height = floors * 80 + 48;
  const ctx = canvas.getContext("2d");
  ctx.imageSmoothingEnabled = false;
  const rng = random(seed);
  const kinds = [];
  for (let floor = 0; floor < floors; floor++) {
    const below = kinds[floor - 1] ?? [];
    const left = pickKind(seed, appearance, floor, 0, below[0], undefined);
    kinds.push([left, pickKind(seed, appearance, floor, 1, below[1], left)]);
  }
  roof(ctx, appearance, rng);
  for (let floor = floors - 1; floor >= 0; floor--) {
    const y = 48 + 80 * (floors - 1 - floor);
    rect(ctx, PAL.panel, 0, y, 320, 80);
    for (let x = 0; x < 320; x += 8) {
      rect(ctx, PAL.redDark, x, y, 1, 80);
      if (rng() > 0.6) rect(ctx, PAL.border, x + 2, y + 3, 3, 1);
    }
    room(ctx, 8, y + 8, INTERIORS[kinds[floor][0]], rng);
    room(ctx, 168, y + 8, INTERIORS[kinds[floor][1]], rng);
    rect(ctx, PAL.steel, 0, y + 72, 320, 8);
    rect(ctx, PAL.steelLight, 0, y + 72, 320, 1);
    rect(ctx, PAL.void, 0, y + 76, 320, 2);
    rect(ctx, PAL.cyanDark, 8, y + 74, 144, 1);
    rect(ctx, PAL.cyanDark, 168, y + 74, 144, 1);
    rect(ctx, PAL.border, 0, y, 3, 80);
    rect(ctx, PAL.border, 317, y, 3, 80);
    rect(ctx, PAL.steelLight, 3, y, 1, 80);
    rect(ctx, PAL.steelLight, 316, y, 1, 80);
    rect(ctx, PAL.redDark, 153, y + 10, 14, 61);
    floorLabel(ctx, floor + 1, y + 12);
    if (floor === 0) {
      // Storefront door is centred on the authoritative entrance x = 160.
      rect(ctx, PAL.void, 155, y + 44, 10, 29);
      frame(ctx, PAL.cyanDark, 155, y + 44, 10, 29);
      rect(ctx, PAL.glass, 157, y + 47, 6, 19);
      rect(ctx, PAL.cyan, 161, y + 59, 1, 2);
      rect(ctx, PAL.steelLight, 154, y + 73, 12, 2);
      rect(ctx, PAL.cyan, 157, y + 40, 6, 1);
    } else {
      rect(ctx, PAL.steel, 157, y + 29, 6, 36);
      for (let yy = y + 31; yy < y + 65; yy += 6) rect(ctx, PAL.steelLight, 157, yy, 6, 1);
    }
    for (const x of [1, 318]) for (let yy = y + 9; yy < y + 72; yy += 24) rect(ctx, PAL.orange, x, yy, 1, 2);
  }
  return canvas;
}
