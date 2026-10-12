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
