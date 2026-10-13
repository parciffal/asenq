import assert from "node:assert/strict";
import { test } from "node:test";

// The browser stays uncompiled; static imports cannot resolve its shipped URL from dist/test.
const { clampView, plateText, vacantLotX, cityWorld, streetLayout, streetRoute } = await import(new URL("../../web/city/app/mapkit.js", import.meta.url).href);
// Runtime URL exercises the browser's uncompiled route sampler.
const { sample, walkPath } = await import(new URL("../../web/city/app/logic.js", import.meta.url).href);

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

test("wider streets preserve buildings and station sizes while aligning hits, routes and movement", () => {
  const rect = { x: 18, y: 6, width: 16, height: 8 };
  const anchor = { x: 22, y: 7 };
  const building = { x: 0, y: -14, width: 40, height: 10 };
  const layout = {
    venues: [{ key: "v", rect: building, entrance: { x: 20, y: -4 }, rooms: [] }],
    characters: [{ id: "s", rect, anchor, home: null }],
    targets: [{ target: { kind: "character", id: "s" }, rect, anchor, order: 0 }],
    routes: {},
    bounds: { x: 0, y: -14, width: 40, height: 30 },
    moved: [{ id: "s", from: { x: 2, y: -4 }, to: anchor }],
  };
  const mapped = streetLayout(layout);
  assert.deepEqual(mapped.venues[0].rect, building);
  assert.deepEqual(mapped.characters[0].rect, { x: 18, y: 14, width: 16, height: 8 });
  assert.deepEqual(mapped.targets[0].rect, mapped.characters[0].rect);
  assert.deepEqual(mapped.targets[0].anchor, mapped.characters[0].anchor);
  assert.deepEqual(mapped.moved[0].to, mapped.characters[0].anchor);
  assert.deepEqual(mapped.bounds, { x: 0, y: -14, width: 40, height: 38 });
  assert.equal(cityWorld(mapped.bounds, 0).height, 496);
  assert.deepEqual(streetLayout(layout), mapped);
  assert.equal(layout.characters[0]!.rect.y, 6);

  const route = streetRoute({ length: 21, segments: [
    { from: { x: 2, y: -4 }, to: { x: 2, y: 0 }, start: 0, length: 4 },
    { from: { x: 2, y: 0 }, to: { x: 12, y: 0 }, start: 4, length: 10 },
    { from: { x: 12, y: 0 }, to: { x: 12, y: 7 }, start: 14, length: 7 },
  ] });
  assert.equal(route.length, 29);
  assert.deepEqual(sample(route, 20.5), { x: 12, y: 6.5 });
  assert.deepEqual(sample(route, 29), { x: 12, y: 15 });
  assert.deepEqual(sample(route, 100), { x: 12, y: 15 });
  const walk = walkPath(mapped.moved[0].from, mapped.moved[0].to);
  assert.equal(walk[1].y, route.segments[0].to.y);
  assert.equal(walk[2].y, route.segments[1].to.y);
});
