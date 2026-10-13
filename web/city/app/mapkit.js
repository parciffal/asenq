// Browser-only geometry: upper sidewalk 48px, road 72px, lower sidewalk 24px.
export const STREET = Object.freeze({ top: -32, height: 144, roadTop: 48, roadHeight: 72, lowerTop: 120, bottom: 112, spine: 6.5 });

// Keep building interiors and station sizes intact; stretch only the space between them.
function streetY(y) {
  if (y <= -4) return y;
  if (y <= 0) return -4 + (y + 4) * 2.625;
  if (y < 6) return STREET.spine + y * 1.25;
  return y + 8;
}

function streetPoint(point) {
  return { ...point, y: streetY(point.y) };
}

function streetRect(rect) {
  const y = streetY(rect.y);
  return { ...rect, y, height: streetY(rect.y + rect.height) - y };
}

export function streetRoute(path) {
  let length = 0;
  const segments = path.segments.map((segment) => {
    const from = streetPoint(segment.from), to = streetPoint(segment.to);
    const size = Math.abs(to.x - from.x) + Math.abs(to.y - from.y);
    const mapped = { from, to, start: length, length: size };
    length += size;
    return mapped;
  });
  return { segments, length };
}

/** Project each incoming daemon layout once; terminal cell geometry remains unchanged. */
export function streetLayout(layout) {
  return {
    ...layout,
    venues: layout.venues.map((venue) => ({
      ...venue, rect: streetRect(venue.rect), entrance: streetPoint(venue.entrance),
      rooms: venue.rooms.map((room) => ({ ...room, rect: streetRect(room.rect), anchor: streetPoint(room.anchor) })),
    })),
    characters: layout.characters.map((character) => ({ ...character, rect: streetRect(character.rect), anchor: streetPoint(character.anchor) })),
    targets: layout.targets.map((target) => ({ ...target, rect: streetRect(target.rect), anchor: streetPoint(target.anchor) })),
    routes: Object.fromEntries(Object.entries(layout.routes).map(([key, path]) => [key, streetRoute(path)])),
    bounds: streetRect(layout.bounds),
    moved: layout.moved.map((move) => ({ ...move, from: streetPoint(move.from), to: streetPoint(move.to) })),
  };
}

export function clampView({ scrollX, scrollY, zoom }, viewport, world) {
  const axis = (scroll, start, size, view) => {
    const position = size >= view
      ? Math.max(start, Math.min(start + size - view, scroll))
      : start + (size - view) / 2;
    return Math.round(position * zoom) / zoom;
  };
  return {
    scrollX: axis(scrollX, world.x, world.width, viewport.width / zoom),
    scrollY: axis(scrollY, world.y, world.height, viewport.height / zoom),
  };
}

export function plateText(name, max = 24) {
  const points = Array.from(name);
  if (points.length <= max) return name;
  const tail = Math.min(9, max - 1);
  return points.slice(0, max - tail - 1).join("") + "…" + (tail ? points.slice(-tail).join("") : "");
}

export function vacantLotX(venues) {
  return Math.floor((Math.max(...venues.map((venue) => venue.rect.x / 48), -1) + 1) * 48) * 8;
}

export function cityWorld(bounds, lotX) {
  const left = Math.min(bounds ? bounds.x * 8 : 0, lotX);
  const top = Math.min(bounds ? bounds.y * 8 : STREET.top, STREET.top);
  const right = Math.max(bounds ? (bounds.x + bounds.width) * 8 : 320, lotX + 320);
  const bottom = Math.max(bounds ? (bounds.y + bounds.height) * 8 : STREET.bottom, STREET.bottom);
  return { x: left - 320, y: top - 96, width: right - left + 640, height: bottom - top + 192 };
}
