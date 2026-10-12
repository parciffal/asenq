import { sanitizeTerminalText, terminalTextWidth } from "../tui/terminal.js";
import { venueAppearance } from "./model.js";
import type { CityLayout, CityRoom, CityTarget, CityVenue, PlacedCharacter, PlacedVenue, Point, Rect, RoutePath, RouteSegment, TargetPosition, VizUi, World } from "./types.js";

export const textWidth = (text: string): number => terminalTextWidth(text);
const nameCache = new Map<string, { text: string; width: number }>();
export function cleanLabel(raw: string): { text: string; width: number } {
  let hit = nameCache.get(raw);
  if (!hit) {
    if (nameCache.size > 1024) nameCache.clear();
    const text = sanitizeTerminalText(raw).trim() || "?";
    hit = { text, width: textWidth(text) };
    nameCache.set(raw, hit);
  }
  return hit;
}
export const targetKey = (target: CityTarget): string => target.kind === "venue" ? `v:${target.venueKey}`
  : target.kind === "character" ? `c:${target.id}` : `m:${target.venueKey}:${target.id}`;

/** A constant-size segment representation, never one allocation per route cell. */
export function routePoints(points: readonly Point[]): RoutePath {
  const segments: RouteSegment[] = [];
  let length = 0;
  for (let i = 1; i < points.length; i++) {
    const from = points[i - 1]!;
    const to = points[i]!;
    if (from.x !== to.x && from.y !== to.y) throw new Error("city routes must be orthogonal");
    const distance = Math.abs(to.x - from.x) + Math.abs(to.y - from.y);
    if (distance === 0) continue;
    segments.push({ from, to, start: length, length: distance });
    length += distance;
  }
  return { segments, length };
}
export function sampleRoute(path: RoutePath, distance: number): Point {
  const last = path.segments[path.segments.length - 1];
  if (!last) return { x: 0, y: 0 };
  const d = Math.max(0, Math.min(path.length, distance));
  for (const segment of path.segments) {
    if (d <= segment.start + segment.length) {
      const fraction = (d - segment.start) / segment.length;
      return { x: segment.from.x + (segment.to.x - segment.from.x) * fraction,
        y: segment.from.y + (segment.to.y - segment.from.y) * fraction };
    }
  }
  return last.to;
}
export function routeBetween(layout: CityLayout, from: CityTarget, to: CityTarget): RoutePath | null {
  const a = layout.routes.get(targetKey(from));
  const b = layout.routes.get(targetKey(to));
  if (!a || !b) return null;
  const points: Point[] = [];
  const start = layout.targets.find((p) => targetKey(p.target) === targetKey(from))?.anchor;
  const end = layout.targets.find((p) => targetKey(p.target) === targetKey(to))?.anchor;
  if (!start || !end) return null;
  points.push(start);
  for (const segment of a.segments) points.push(segment.to);
  const spineA = points[points.length - 1]!;
  const spineB = b.segments[b.segments.length - 1]?.to ?? end;
  if (spineA.y !== 0) points.push({ x: spineA.x, y: 0 });
  points.push({ x: spineB.x, y: 0 });
  for (let i = b.segments.length - 1; i >= 0; i--) points.push(b.segments[i]!.from);
  points.push(end);
  return routePoints(points);
}
export function matchingTargets(world: World, layout: CityLayout, ui: VizUi): TargetPosition[] {
  const byId = new Map(world.characters.map((c) => [c.id, c]));
  return layout.targets.filter(({ target }) => {
    if (target.kind === "venue") return true;
    const c = byId.get(target.id);
    return c !== undefined && (c.source !== "process" || ui.processes) && (c.source === "human" || ui.filter === null || c.harness === ui.filter);
  });
}

type VenueReservation = { key: string; name: string; appearance: CityVenue["appearance"]; strip: number; slots: Map<string, number>; floors: number };
/** All reservations are retained until this map instance is destroyed. */
export class CityPlacement {
  private readonly names = new Map<string, VenueReservation>();
  private readonly streets = new Map<string, number>([["human", 0]]);
  private readonly homes = new Map<string, string | null>();
  private readonly orders = new Map<string, number>();
  private previous = new Map<string, Point>();
  private nextVenue = 0;
  private nextOrder = 0;
  private bounds: Rect = { x: 0, y: -14, width: 40, height: 30 };

  renameChannel(oldName: string, name: string): void {
    const reservation = this.names.get(oldName);
    if (!reservation || oldName === name) return;
    this.names.delete(oldName);
    reservation.name = name;
    this.names.set(name, reservation);
  }

  update(world: World): CityLayout {
    for (const v of [...world.venues].sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0)) {
      if (!this.names.has(v.name)) {
        const strip = this.nextVenue++;
        this.names.set(v.name, { key: `venue:${strip}`, name: v.name, appearance: venueAppearance(v.name), strip, slots: new Map(), floors: 1 });
      }
      const reservation = this.names.get(v.name)!;
      v.key = reservation.key;
      v.appearance = reservation.appearance;
      for (const id of v.roster.map((c) => c.id).sort()) if (!reservation.slots.has(id)) reservation.slots.set(id, reservation.slots.size);
      for (const c of v.roster) reservation.floors = Math.max(reservation.floors, Math.floor(reservation.slots.get(c.id)! / 2) + 1);
    }
    const byName = new Map(world.venues.map((v) => [v.name, v]));
    for (const c of [...world.characters].sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0)) {
      const eligible = c.memberships.filter((name) => byName.has(name)).sort();
      const keys = eligible.map((name) => byName.get(name)!.key);
      const old = this.homes.get(c.id);
      const home = old !== undefined && old !== null && keys.includes(old) ? old : keys[0] ?? null;
      this.homes.set(c.id, home);
      if (home === null && !this.streets.has(c.id)) this.streets.set(c.id, this.streets.size);
    }
    const venues: PlacedVenue[] = [];
    const characters: PlacedCharacter[] = [];
    const targets: TargetPosition[] = [];
    const routes = new Map<string, RoutePath>();
    const roomsById = new Map<string, CityRoom>();
    const add = (target: CityTarget, anchor: Point, rect: Rect, points: Point[]): void => {
      const key = targetKey(target);
      if (!this.orders.has(key)) this.orders.set(key, this.nextOrder++);
      targets.push({ target, anchor, rect, order: this.orders.get(key)! });
      routes.set(key, routePoints(points));
    };
    for (const venue of world.venues.sort((a, b) => this.names.get(a.name)!.strip - this.names.get(b.name)!.strip)) {
      const r = this.names.get(venue.name)!;
      const x = r.strip * 48;
      const rect = { x, y: -14 - (r.floors - 1) * 10, width: 40, height: r.floors * 10 };
      const entrance = { x: x + 20, y: -4 };
      const rooms: CityRoom[] = [];
      add({ kind: "venue", venueKey: venue.key }, entrance, rect, [entrance, { x: entrance.x, y: 0 }]);
      for (const c of venue.roster) {
        const slot = r.slots.get(c.id)!;
        const floor = Math.floor(slot / 2);
        const roomRect = { x: x + 1 + (slot % 2) * 20, y: -13 - floor * 10, width: 18, height: 8 };
        const anchor = { x: roomRect.x + 5, y: roomRect.y + 1 };
        const canonical = this.homes.get(c.id) === venue.key;
        const room = { id: c.id, venueKey: venue.key, slot, floor, rect: roomRect, anchor, canonical };
        rooms.push(room);
        if (canonical) roomsById.set(c.id, room);
        else add({ kind: "membership", id: c.id, venueKey: venue.key }, anchor, roomRect,
          [anchor, { x: anchor.x, y: roomRect.y + 7 }, { x: entrance.x, y: roomRect.y + 7 }, entrance, { x: entrance.x, y: 0 }]);
      }
      venues.push({ venue, rect, entrance, floors: r.floors, rooms });
    }
    for (const c of world.characters) {
      const room = roomsById.get(c.id);
      const slot = this.streets.get(c.id) ?? 0;
      const rect = room?.rect ?? { x: (slot % 8) * 18, y: 6 + Math.floor(slot / 8) * 10, width: 16, height: 8 };
      const anchor = room?.anchor ?? { x: rect.x + 4, y: rect.y + 1 };
      const placed = { character: c, rect, anchor, home: this.homes.get(c.id) ?? null };
      characters.push(placed);
      const entrance = room ? venues.find((v) => v.venue.key === room.venueKey)!.entrance : null;
      const points = room && entrance ? [anchor, { x: anchor.x, y: rect.y + 7 }, { x: entrance.x, y: rect.y + 7 }, entrance, { x: entrance.x, y: 0 }]
        : [anchor, { x: rect.x + rect.width, y: anchor.y }, { x: rect.x + rect.width, y: 0 }];
      add({ kind: "character", id: c.id }, anchor, rect, points);
    }
    const moved: CityLayout["moved"] = [];
    for (const c of characters) {
      const from = this.previous.get(c.character.id);
      if (from && (from.x !== c.anchor.x || from.y !== c.anchor.y)) moved.push({ id: c.character.id, from, to: c.anchor });
    }
    this.previous = new Map(characters.map((c) => [c.character.id, c.anchor]));
    for (const rect of [...venues.map((v) => v.rect), ...characters.map((c) => c.rect)]) {
      const x = Math.min(this.bounds.x, rect.x);
      const y = Math.min(this.bounds.y, rect.y);
      this.bounds = { x, y, width: Math.max(this.bounds.x + this.bounds.width, rect.x + rect.width) - x,
        height: Math.max(this.bounds.y + this.bounds.height, rect.y + rect.height) - y };
    }
    targets.sort((a, b) => a.order - b.order);
    return { venues, characters, targets, routes, bounds: this.bounds, moved,
      byVenue: new Map(venues.map((v) => [v.venue.key, v])), byCharacter: new Map(characters.map((c) => [c.character.id, c])) };
  }
}
