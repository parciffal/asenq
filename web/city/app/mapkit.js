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
  const top = Math.min(bounds ? bounds.y * 8 : -32, -32);
  const right = Math.max(bounds ? (bounds.x + bounds.width) * 8 : 320, lotX + 320);
  const bottom = Math.max(bounds ? (bounds.y + bounds.height) * 8 : 48, 48);
  return { x: left - 320, y: top - 96, width: right - left + 640, height: bottom - top + 192 };
}
