import type { Appearance } from "../viz/appearance.js";
import type { CityCharacter, CityRoom, CityView, FeedLine, Point, Rect, RoutePath, TargetPosition, VenueAppearance } from "../viz/types.js";

export type CityWire = {
  connection: "connected" | "offline";
  notice: string | null;
  settingsWarning: string | null;
  reducedMotion: boolean;
  characters: (CityCharacter & { appearance: Appearance })[];
  venues: { key: string; name: string; appearance: VenueAppearance; rosterIds: string[]; postCount: number }[];
  feed: FeedLine[];
  layout: {
    venues: { key: string; rect: Rect; entrance: Point; floors: number; rooms: CityRoom[] }[];
    characters: { id: string; rect: Rect; anchor: Point; home: string | null }[];
    targets: TargetPosition[];
    routes: Record<string, RoutePath>;
    bounds: Rect;
    moved: { id: string; from: Point; to: Point }[];
  };
};

/** Coordinates remain world cells; only the browser scales them to pixels. */
export function toWire(view: CityView, settingsWarning: string | null, reducedMotion: boolean): CityWire {
  const { world, layout, appearances, notice } = view;
  return {
    connection: world.connection, notice, settingsWarning, reducedMotion,
    characters: world.characters.map((character) => ({ ...character, appearance: appearances.get(character.id)! })),
    venues: world.venues.map((venue) => ({
      key: venue.key, name: venue.name, appearance: venue.appearance,
      rosterIds: venue.roster.map((character) => character.id), postCount: venue.postCount,
    })),
    feed: world.feed,
    layout: {
      venues: layout.venues.map(({ venue, rect, entrance, floors, rooms }) => ({ key: venue.key, rect, entrance, floors, rooms })),
      characters: layout.characters.map(({ character, rect, anchor, home }) => ({ id: character.id, rect, anchor, home })),
      targets: layout.targets, routes: Object.fromEntries(layout.routes), bounds: layout.bounds, moved: layout.moved,
    },
  };
}
