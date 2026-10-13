import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

// The browser stays uncompiled; static imports cannot resolve its shipped URL from dist/test.
const { harnessPalette, characterTextureKey } = await import(new URL("../../web/city/app/art/characters.js", import.meta.url).href);
const sheet = JSON.parse(readFileSync(new URL("../../web/city/assets/characters.json", import.meta.url), "utf8"));

test("neutral garments identify harness without recolouring faces, hair or outlines", () => {
  for (const variant of sheet.outfits.neutral) {
    for (const color of ["#f6893e", "#3fd27f", "#6aa8ff", "#c86dd7"]) {
      const tinted = harnessPalette(variant.palette, color);
      for (let i = 0; i < variant.palette.length; i++) {
        const original = variant.palette[i];
        const rgb = [1, 3, 5].map((start) => Number.parseInt(original.slice(start, start + 2), 16));
        if (Math.max(...rgb) - Math.min(...rgb) <= 16 && Math.max(...rgb) >= 0x90) {
          assert.notEqual(tinted[i], original);
          const changed = [1, 3, 5].map((start) => Number.parseInt(tinted[i].slice(start, start + 2), 16));
          assert.ok(Math.max(...changed) - Math.min(...changed) > 16);
        } else {
          assert.equal(tinted[i], original);
        }
      }
    }
  }
  const orange = harnessPalette(sheet.outfits.neutral[0].palette, "#f6893e")[11];
  assert.ok(Number.parseInt(orange.slice(1, 3), 16) > Number.parseInt(orange.slice(5, 7), 16));
  assert.equal(harnessPalette(sheet.outfits.neutral[0].palette, "#f6893e")[0], "#251f1b");
});

test("harness tint applies only to neutral outfits; explicit outfits win", () => {
  assert.equal(characterTextureKey({ outfit: "neutral", variant: 2 }, "work_a", "omp"), "ch:neutral:2:work_a:omp");
  assert.equal(characterTextureKey({ outfit: "claude", variant: 2 }, "work_a", "omp"), "ch:claude:2:work_a");
  assert.equal(characterTextureKey({ outfit: "neutral", variant: 0 }, "idle_a", null), "ch:neutral:0:idle_a");
});
