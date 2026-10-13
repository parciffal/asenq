import assert from "node:assert/strict";
import { test } from "node:test";

// The browser stays uncompiled; static imports cannot resolve its shipped URL from dist/test.
const { clampView, plateText, vacantLotX, cityWorld } = await import(new URL("../../web/city/app/mapkit.js", import.meta.url).href);

const world = { x: -320, y: -496, width: 2400, height: 1200 };
const viewport = { width: 1001, height: 701 };

test("camera clamps every edge and preserves views inside a larger world", () => {
  for (const zoom of [1, 2, 3, 4]) {
    for (const scrollX of [-10000, -320, 0, 10000]) {
      for (const scrollY of [-10000, -496, 0, 10000]) {
        const view = clampView({ scrollX, scrollY, zoom }, viewport, world);
        assert.ok(view.scrollX >= world.x);
        assert.ok(view.scrollY >= world.y);
        assert.ok(view.scrollX + viewport.width / zoom <= world.x + world.width + 1e-9);
        assert.ok(view.scrollY + viewport.height / zoom <= world.y + world.height + 1e-9);
        assert.deepEqual(clampView({ ...view, zoom }, viewport, world), view);
      }
    }
    assert.deepEqual(clampView({ scrollX: 0, scrollY: 0, zoom }, viewport, world), { scrollX: 0, scrollY: 0 });
  }
});

test("camera centres a smaller world regardless of requested scroll", () => {
  const small = { x: 80, y: -40, width: 100, height: 60 };
  const screen = { width: 800, height: 600 };
  for (const zoom of [1, 2, 3, 4]) {
    const expected = {
      scrollX: Math.round((small.x + (small.width - screen.width / zoom) / 2) * zoom) / zoom,
      scrollY: Math.round((small.y + (small.height - screen.height / zoom) / 2) * zoom) / zoom,
    };
    const view = clampView({ scrollX: 10000, scrollY: -10000, zoom }, screen, small);
    assert.deepEqual(view, expected);
    assert.deepEqual(clampView({ ...view, zoom }, screen, small), view);
  }
});

test("name plates preserve case and both ends of long code-point names", () => {
  assert.equal(plateText("ops-11"), "ops-11");
  assert.equal(plateText("Claude-Arctic-Fox"), "Claude-Arctic-Fox");
  const name = "abcdefghijklmno" + "😀".repeat(16) + "XYZ123456";
  assert.equal(Array.from(name).length, 40);
  const plate = plateText(name);
  assert.equal(Array.from(plate).length, 24);
  assert.equal(plate, "abcdefghijklmn…XYZ123456");
});

test("city world follows live channels: adding extends, removing and deleting the last shrink", () => {
  assert.equal(vacantLotX([0, 48, 96].map((x) => ({ rect: { x } }))), 1152);
  assert.deepEqual(cityWorld({ x: 0, y: -14, width: 136, height: 30 }, 1152), { x: -320, y: -208, width: 2112, height: 432 });
  assert.equal(vacantLotX([0, 48].map((x) => ({ rect: { x } }))), 768);
  assert.equal(cityWorld({ x: 0, y: -14, width: 88, height: 30 }, 768).width, 1728);
  assert.equal(vacantLotX([]), 0);
  assert.deepEqual(cityWorld({ x: 0, y: -14, width: 40, height: 30 }, 0), { x: -320, y: -208, width: 960, height: 432 });
});
