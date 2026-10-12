import { sample, orderedTargets, cycle, targetKey, walkPath, poseFor, px, fnv1a } from "./logic.js";
import { clampView, plateText } from "./mapkit.js";
import { paintVenue } from "./art/buildings.js";
import { paintStreetTile, paintWorkstation } from "./art/street.js";
import { textureFor, loadCharacterTextures } from "./art/characters.js";
import { PAL } from "./art/palette.js";

const color = (name) => Number.parseInt(PAL[name].slice(1), 16);
const COLORS = {
  burgundy: color("void"), border: color("border"), cream: color("white"),
  cyan: color("cyan"), yellow: color("yellow"), alert: color("alert"),
};
const HARNESS_FILTERS = [null, "claude", "omp", "opencode", "codex"];
const PACKET_COLORS = { chat: COLORS.cream, task: COLORS.cyan, result: COLORS.yellow, status: 0xbdb1a4, control: COLORS.alert };
const clamp = (value, low, high) => Math.max(low, Math.min(high, value));
const keyOf = (target) => target ? targetKey(target) : null;
const isTextEntry = (target) => target?.tagName === "INPUT" || target?.tagName === "TEXTAREA" || target?.tagName === "SELECT" || target?.isContentEditable;

export class CityScene extends Phaser.Scene {
  constructor(store, hud) {
    super({ key: "CityScene" });
    this.store = store;
    this.hud = hud;
    this.state = store.snapshot();
    this.lastWire = null;
    this.walks = new Map();
    this.packets = [];
    this.lastPointer = null;
    this.lastClickAt = 0;
    this.characterReady = false;
    this.cameraZooms = [1, 2, 3, 4];
    this.wheelZoomDelta = 0;
    this.clock = performance.now();
    this.lastViewportRefresh = 0;
    this.keyListener = (event) => this.onKeyDown(event);
  }

  create() {
    const original = this.cameras.main;
    this.cameras.remove(original);
    const width = this.scale.width;
    const height = this.scale.height;
    this.bgCamera = this.cameras.add(0, 0, width, height);
    this.mainCamera = this.cameras.add(0, 0, width, height, true);
    this.fxCamera = this.cameras.add(0, 0, width, height);
    this.mainCamera.setOrigin(0, 0);

    this.bgLayer = this.add.layer();
    this.streetLayer = this.add.layer();
    this.venueLayer = this.add.layer();
    this.signLayer = this.add.layer();
    this.conduitLayer = this.add.layer();
    this.stationLayer = this.add.layer();
    this.characterLayer = this.add.layer();
    this.hologramLayer = this.add.layer();
    this.labelLayer = this.add.layer();
    this.packetLayer = this.add.layer();
    this.selectionLayer = this.add.layer();
    this.offlineLayer = this.add.layer();
    this.fxLayer = this.add.layer();
    this.worldLayers = [this.streetLayer, this.venueLayer, this.signLayer, this.conduitLayer, this.stationLayer,
      this.characterLayer, this.hologramLayer, this.labelLayer, this.packetLayer, this.selectionLayer, this.offlineLayer];
    this.mainCamera.ignore([this.bgLayer, this.fxLayer]);
    this.bgCamera.ignore([...this.worldLayers, this.fxLayer]);
    this.fxCamera.ignore([...this.worldLayers, this.bgLayer]);

    this.conduits = this.add.graphics(); this.conduitLayer.add(this.conduits);
    this.packetGraphics = this.add.graphics(); this.packetLayer.add(this.packetGraphics);
    this.selectionGraphics = this.add.graphics(); this.selectionLayer.add(this.selectionGraphics);
    this.rainGraphics = this.add.graphics(); this.fxLayer.add(this.rainGraphics);
    this.offlineOverlay = this.add.graphics(); this.offlineLayer.add(this.offlineOverlay);
    this.streetSprite = null;
    this.venueImages = new Map();
    this.stationImages = new Map();
    this.stationTextures = new Set();
    this.characterSprites = new Map();
    this.characterLabels = new Map();
    this.signs = new Map();
    this.holograms = new Map();
    this.proceduralSkyline("skyline-far", false);
    this.proceduralSkyline("skyline-mid", true);
    this.createBackdropTiles(width, height);
    this.loadBackdrop("skyline-far", "/assets/skyline-far.png");
    this.loadBackdrop("skyline-mid", "/assets/skyline-mid.png");
    this.seedRain();

    window.addEventListener("keydown", this.keyListener);
    this.input.on("pointerdown", this.onPointerDown, this);
    this.input.on("pointermove", this.onPointerMove, this);
    this.input.on("pointerup", this.onPointerUp, this);
    this.input.on("pointerupoutside", this.endDrag, this);
    this.input.on("wheel", this.onWheel, this);
    this.scale.on("resize", (size) => this.resize(size.width, size.height));
    this.unsubscribe = this.store.subscribe((state) => this.onStoreChange(state));
    loadCharacterTextures(this).then(() => {
      this.characterReady = true;
      this.onStoreChange(this.store.snapshot());
      this.hud?.render?.(this.store.snapshot());
    }).catch((error) => {
      this.hud?.setFatal?.(error.message);
    });
    this.setView(0, 0, 2);
    this.onStoreChange(this.store.snapshot());
  }

  shutdown() {
    this.unsubscribe?.();
    window.removeEventListener("keydown", this.keyListener);
  }

  onStoreChange(state) {
    this.state = state;
    if (state.wire && state.wire !== this.lastWire) this.applyWire(state);
    if (state.ui.tab !== "map" && this.packets.length) {
      this.packets.length = 0;
      this.packetGraphics?.clear();
    }
    if (!this.characterReady || !state.wire) return;
    this.drawScene(state);
    const paused = this.scene.isPaused();
    if (state.ui.tab === "map") {
      if (paused) this.scene.resume();
    } else if (this.scene.isActive() && !paused) this.scene.pause();
  }

  applyWire(state) {
    const wire = state.wire;
    const initial = this.lastWire === null;
    const wasOffline = this.lastWire?.connection === "offline";
    const offline = wire.connection === "offline";
    this.lastWire = wire;
    this.vacantX = Math.max(this.vacantX ?? 0, this.nextVacantX(wire));
    if (offline) {
      this.packets.length = 0;
      this.walks.clear();
      this.store.animations.clear();
    } else {
      if (wasOffline) {
        this.walks.clear();
        this.store.animations.clear();
      }
      if (!wasOffline && state.previousWire && !wire.reducedMotion && Date.now() - state.previousAt <= 5000) {
        this.startWalks(wire.layout.moved ?? [], state.previousWire, wire);
      }
    }
    this.applyOfflineEffect(offline);
    if (initial) this.centerInitialView(state);
  }
  centerInitialView(state) {
    let first = null;
    let second = null;
    for (const venue of state.wire.layout.venues) {
      if (!first || venue.rect.x < first.rect.x) {
        second = first;
        first = venue;
      } else if (!second || venue.rect.x < second.rect.x) second = venue;
    }
    if (first) {
      const last = second ?? first;
      const left = first.rect.x * 8;
      const right = (last.rect.x + last.rect.width) * 8;
      this.centerAt((left + right) / 2, 0);
      return;
    }
    const operator = state.wire.layout.characters.find((item) => state.charactersById.get(item.id)?.source === "human");
    if (operator) this.centerAt((operator.rect.x + operator.rect.width / 2) * 8,
      (operator.rect.y + operator.rect.height / 2) * 8);
  }


  startWalks(moves, previousWire, nextWire) {
    const now = performance.now();
    const alive = new Set(nextWire.layout.characters.map((item) => item.id));
    for (const id of this.walks.keys()) if (!alive.has(id)) this.walks.delete(id);
    for (const move of moves) {
      const points = walkPath(move.from, move.to);
      let length = 0;
      for (let i = 1; i < points.length; i++) length += Math.abs(points[i].x - points[i - 1].x) + Math.abs(points[i].y - points[i - 1].y);
      const oldPlace = previousWire.layout.characters.find((item) => item.id === move.id);
      const newPlace = nextWire.layout.characters.find((item) => item.id === move.id);
      const duration = clamp(length * 8 / 160 * 1000, 600, 3000);
      this.walks.set(move.id, {
        points, length, start: now, duration,
        xOffset: oldPlace?.home === null ? 8 : 0,
        toXOffset: newPlace?.home === null ? 8 : 0,
        yOffset: 54,
      });
      const animation = this.store.animations.get(move.id) ?? {};
      this.store.animations.set(move.id, { ...animation, walk: now });
    }
  }

  applyOfflineEffect(offline) {
    if (!this.mainCamera) return;
    if (this.offlineEffect) {
      this.offlineEffect.destroy();
      this.offlineEffect = null;
    }
    if (!offline) {
      this.offlineOverlay.clear();
      return;
    }
    if (this.game.renderer.type === Phaser.WEBGL && this.mainCamera.postFX?.addColorMatrix) {
      this.offlineEffect = this.mainCamera.postFX.addColorMatrix();
      this.offlineEffect.grayscale(0.6);
      this.offlineOverlay.clear();
    } else {
      this.offlineOverlay.clear();
      this.offlineOverlay.fillStyle(COLORS.burgundy, 0.5);
      this.offlineOverlay.fillRect(0, -10000, this.scale.width, 20000);
      this.offlineOverlay.setScrollFactor(0);
    }
  }

  drawScene(state) {
    const wire = state.wire;
    if (!wire) return;
    this.drawStreet(wire);
    this.drawVenues(state);
    this.drawSigns(state);
    this.drawConduits(state.routesByKey);
    this.drawStations(state);
    this.drawCharacters(state);
    this.drawHolograms(state);
    this.drawSelection(state);
    this.drawPackets();
  }

  drawStreet(wire) {
    const bounds = wire.layout.bounds;
    const pixelWidth = Math.max(320, Math.ceil(bounds.width * 8));
    const x = bounds.x * 8;
    const signature = `${x}:${pixelWidth}`;
    if (this.streetSignature !== signature) {
      const canvas = document.createElement("canvas");
      canvas.width = pixelWidth;
      canvas.height = 80;
      paintStreetTile(canvas, x, pixelWidth);
      this.streetSprite?.destroy();
      this.replaceCanvasTexture("city-street", canvas);
      this.streetSprite = this.add.image(x, -32, "city-street").setOrigin(0, 0);
      this.streetLayer.add(this.streetSprite);
      this.streetSignature = signature;
    }
    this.streetSprite?.setPosition(x, -32);
    this.drawVacant(this.vacantX);
  }

  drawVacant(x) {
    if (this.vacantPosition === x) return;
    this.vacantPosition = x;
    this.vacantGraphics ??= this.add.graphics();
    this.vacantGraphics.clear();
    this.vacantGraphics.fillStyle(COLORS.burgundy, 0.75);
    this.vacantGraphics.fillRect(x, -32, 320, 80);
    this.vacantGraphics.lineStyle(1, COLORS.border, 0.9);
    dashedRect(this.vacantGraphics, x, -32, 320, 80, 7, 5);
    this.streetLayer.add(this.vacantGraphics);
    this.vacantText ??= this.add.text(0, 0, "VACANT LOT", { fontFamily: "Silkscreen", fontSize: "8px", color: "#a52b3a" });
    this.vacantText.setPosition(x + 16, 0);
    this.vacantText.setOrigin(0, 0.5);
    this.streetLayer.add(this.vacantText);
  }

  drawVenues(state) {
    const wire = state.wire;
    const live = new Set();
    for (const venue of wire.layout.venues) {
      const data = state.venuesByKey.get(venue.key);
      if (!data) continue;
      live.add(venue.key);
      const signature = `${data.appearance}:${venue.floors}`;
      let entry = this.venueImages.get(venue.key);
      if (!entry || entry.signature !== signature) {
        if (entry) {
          entry.image.destroy();
          this.textures.remove(entry.texture);
        }
        const canvas = document.createElement("canvas");
        canvas.width = 320;
        canvas.height = venue.floors * 80 + 48;
        paintVenue(canvas, { appearance: data.appearance, floors: venue.floors, roomsPerFloor: 2, seed: fnv1a(venue.key) });
        const texture = `venue:${venue.key}:${signature}`;
        this.replaceCanvasTexture(texture, canvas);
        const image = this.add.image(venue.rect.x * 8, venue.rect.y * 8 - 48, texture).setOrigin(0, 0);
        this.venueLayer.add(image);
        entry = { image, signature, texture };
        this.venueImages.set(venue.key, entry);
      } else entry.image.setPosition(venue.rect.x * 8, venue.rect.y * 8 - 48);
    }
    for (const [key, entry] of this.venueImages) {
      if (live.has(key)) continue;
      entry.image.destroy();
      this.textures.remove(entry.texture);
      this.venueImages.delete(key);
    }
  }

  drawSigns(state) {
    const live = new Set();
    for (const venue of state.wire.layout.venues) {
      const data = state.venuesByKey.get(venue.key);
      if (!data) continue;
      live.add(venue.key);
      let plate = this.signs.get(venue.key);
      if (!plate) {
        plate = this.createPlate(this.signLayer, true);
        plate.text.preFX?.addGlow?.(COLORS.cyan, 1, 0, false, 8, 1);
        this.signs.set(venue.key, plate);
      }
      this.updatePlate(plate, `#${plateText(data.name)}`, `#${data.name}`, COLORS.cyan,
        state.unreadByKey?.get(`v:${venue.key}`) ?? 0);
      plate.container.setPosition(venue.rect.x * 8 + 8, venue.rect.y * 8 - 54);
    }
    for (const [key, plate] of this.signs) {
      if (live.has(key)) continue;
      plate.container.destroy();
      this.signs.delete(key);
    }
  }

  drawConduits(routes) {
    const signature = JSON.stringify([...routes]);
    if (signature === this.conduitSignature) return;
    this.conduitSignature = signature;
    this.conduits.clear();
    this.conduits.lineStyle(1, COLORS.cyan, 0.6);
    for (const path of routes.values()) {
      for (const segment of path.segments) {
        this.conduits.beginPath();
        this.conduits.moveTo(segment.from.x * 8, segment.from.y * 8);
        this.conduits.lineTo(segment.to.x * 8, segment.to.y * 8);
        this.conduits.strokePath();
        this.conduits.fillStyle(COLORS.yellow, 0.9);
        this.conduits.fillRect(segment.to.x * 8 - 1, segment.to.y * 8 - 1, 2, 2);
      }
    }
  }

  drawStations(state) {
    const wire = state.wire;
    const live = new Set();
    for (const placed of wire.layout.characters) {
      const character = state.charactersById.get(placed.id);
      if (!character || placed.home !== null || (character.source === "process" && !state.ui.showProcesses)) continue;
      live.add(placed.id);
      const kind = character.source === "human" ? "operator" : character.source === "process" ? "process" : "session";
      const signature = `station:${kind}`;
      const texture = signature;
      if (!this.stationTextures.has(kind)) {
        const canvas = document.createElement("canvas"); canvas.width = 128; canvas.height = 64;
        paintWorkstation(canvas, kind);
        this.replaceCanvasTexture(texture, canvas);
        this.stationTextures.add(kind);
      }
      let entry = this.stationImages.get(placed.id);
      if (!entry || entry.signature !== signature) {
        entry?.image.destroy();
        const image = this.add.image(placed.rect.x * 8, placed.rect.y * 8, texture).setOrigin(0, 0);
        this.stationLayer.add(image);
        entry = { image, signature };
        this.stationImages.set(placed.id, entry);
      } else entry.image.setPosition(placed.rect.x * 8, placed.rect.y * 8);
    }
    for (const [id, entry] of this.stationImages) if (!live.has(id)) { entry.image.destroy(); this.stationImages.delete(id); }
  }

  drawCharacters(state) {
    const live = new Set();
    for (const placed of state.wire.layout.characters) {
      const character = state.charactersById.get(placed.id);
      if (!character || (character.source === "process" && !state.ui.showProcesses)) continue;
      const key = textureFor(character.appearance, "idle_a");
      if (!this.textures.exists(key)) continue;
      live.add(character.id);
      let entry = this.characterSprites.get(character.id);
      if (!entry) {
        const sprite = this.add.image(0, 0, key).setOrigin(0.5, 1);
        this.characterLayer.add(sprite);
        entry = { sprite, placed, character };
        this.characterSprites.set(character.id, entry);
        const plate = this.createPlate(this.labelLayer);
        const badges = this.add.text(0, 0, "", { fontFamily: "Silkscreen", fontSize: "8px", color: "#55ced1", stroke: "#100609", strokeThickness: 1, lineSpacing: -1 }).setOrigin(0, 0);
        this.labelLayer.add(badges);
        this.characterLabels.set(character.id, { plate, badges });
      }
      entry.placed = placed;
      entry.character = character;
    }
    for (const [id, entry] of this.characterSprites) {
      if (live.has(id)) continue;
      entry.sprite.destroy();
      const labels = this.characterLabels.get(id);
      labels.plate.container.destroy();
      labels.badges.destroy();
      this.characterSprites.delete(id);
      this.characterLabels.delete(id);
    }
    this.drawCharactersFrame(state, performance.now());
  }

  drawCharactersFrame(state, now) {
    const wire = state.wire;
    if (!wire) return;
    const reduced = wire.reducedMotion;
    for (const [id, item] of this.characterSprites) {
      const { sprite, placed, character } = item;
      const anim = state.animations.get(id);
      const activity = poseFor(character, anim, now, wire.connection, reduced);
      const key = textureFor(character.appearance, activity.pose);
      if (this.textures.exists(key) && sprite.texture.key !== key) sprite.setTexture(key);
      const selected = keyOf(state.ui.selected) === `c:${id}`;
      const filtered = state.ui.filter !== null && character.source !== "human" && character.harness !== state.ui.filter;
      const dim = activity.tone === "dim" || (state.ui.focus ? !selected : filtered || (character.source === "process" && !state.ui.showProcesses));
      let x = placed.rect.x * 8 + 40;
      let y = (placed.rect.y + placed.rect.height) * 8 - 2;
      const walk = this.walks.get(id);
      if (walk && !reduced) {
        const progress = clamp((now - walk.start) / walk.duration, 0, 1);
        const position = samplePolyline(walk.points, walk.length * progress);
        x = position.x * 8 + walk.xOffset + (walk.toXOffset - walk.xOffset) * progress;
        y = position.y * 8 + walk.yOffset;
      }
      sprite.setPosition(x, y);
      sprite.setAlpha(activity.tone === "lost" ? 0.6 : activity.tone === "gone" ? 0.4 : dim ? 0.3 : 1);
      if (activity.tone === "offline") sprite.setTint(0x8c8c8c); else sprite.clearTint();
      const labels = this.characterLabels.get(id);
      if (!labels) continue;
      this.updatePlate(labels.plate, plateText(character.name), character.name, this.plateBorder(character, activity),
        state.unreadByKey?.get(`c:${id}`) ?? 0, character.source === "process" ? "UNREGISTERED" : "");
      labels.plate.container.setPosition(x, y - 54);
      const harness = character.harness === "claude" ? "CC" : character.harness === "codex" ? "CX" : character.harness === "omp" ? "OMP" : character.harness === "opencode" ? "OC" : "—";
      const role = character.source === "human" ? "[H]" : character.role === "orchestrator" ? "[O]" : character.role === "worker" ? "[W]" : "[-]";
      labels.badges.setText(`${harness}\n${role}\n${activity.label}${activity.badge ? ` ${activity.badge}` : ""}`);
      labels.badges.setPosition(x + 20, y - 48);
      labels.badges.setColor(activity.tone === "offline" || activity.tone === "lost" || activity.tone === "gone" ? "#bdb1a4" : activity.tone === "dim" ? "#8b7577" : "#55ced1");
      labels.plate.container.setAlpha(dim ? 0.5 : activity.tone === "lost" || activity.tone === "gone" ? 0.6 : 1);
    }
  }

  drawHolograms(state) {
    const live = new Set();
    for (const venue of state.wire.layout.venues) {
      for (const room of venue.rooms) {
        if (room.canonical) continue;
        const character = state.charactersById.get(room.id);
        if (!character || (character.source === "process" && !state.ui.showProcesses)) continue;
        const texture = textureFor(character.appearance, "idle_a");
        if (!this.textures.exists(texture)) continue;
        const key = `${venue.key}:${room.id}`;
        live.add(key);
        let entry = this.holograms.get(key);
        if (!entry) {
          const sprite = this.add.image(0, 0, texture).setOrigin(0.5, 1).setTint(COLORS.cyan).setAlpha(0.35);
          this.hologramLayer.add(sprite);
          entry = { sprite, plate: this.createPlate(this.hologramLayer) };
          entry.plate.container.setAlpha(0.75);
          this.holograms.set(key, entry);
        }
        const x = room.rect.x * 8 + 40;
        const y = (room.rect.y + room.rect.height) * 8 - 2;
        if (entry.sprite.texture.key !== texture) entry.sprite.setTexture(texture);
        entry.sprite.setPosition(x, y);
        const activity = poseFor(character, state.animations.get(room.id), performance.now(), state.wire.connection, state.wire.reducedMotion);
        this.updatePlate(entry.plate, `@${plateText(character.name)}`, character.name, this.plateBorder(character, activity),
          state.unreadByKey?.get(`c:${room.id}`) ?? 0);
        entry.plate.container.setPosition(x, y - 54);
      }
    }
    for (const [key, entry] of this.holograms) {
      if (live.has(key)) continue;
      entry.sprite.destroy();
      entry.plate.container.destroy();
      this.holograms.delete(key);
    }
  }

  plateBorder(character, activity) {
    if (["offline", "lost", "gone"].includes(activity.tone)) return 0x8b7577;
    return character.role === "orchestrator" ? COLORS.yellow : character.role === "worker" ? COLORS.cyan : COLORS.cream;
  }

  createPlate(layer, decorative = false) {
    const panel = this.add.graphics();
    const text = this.add.text(0, 0, "", {
      fontFamily: decorative ? "Silkscreen" : "Share Tech Mono",
      fontSize: decorative ? "16px" : "10px", color: decorative ? "#55ced1" : "#e8dec8",
    }).setOrigin(0, 0);
    const subtitle = this.add.text(0, 0, "", { fontFamily: "Share Tech Mono", fontSize: "9px", color: "#8b7577" });
    const pill = this.add.graphics();
    const unread = this.add.text(0, 0, "", { fontFamily: "Share Tech Mono", fontSize: "9px", color: "#100609" });
    const container = this.add.container(0, 0, [panel, text, subtitle, pill, unread]);
    layer.add(container);
    const plate = { container, panel, text, subtitle, pill, unread, decorative };
    text.setInteractive();
    text.on("pointerover", () => this.hud?.setHover?.(plate.fullName));
    text.on("pointerout", () => this.hud?.setHover?.(""));
    return plate;
  }

  updatePlate(plate, label, fullName, border, count, subtitle = "") {
    plate.fullName = fullName;
    const zoom = this.mainCamera.zoom;
    const signature = `${label}:${border}:${count}:${subtitle}:${zoom}`;
    if (signature === plate.signature) return;
    plate.signature = signature;
    plate.text.setResolution(zoom).setText(label);
    plate.subtitle.setResolution(zoom).setText(subtitle).setVisible(Boolean(subtitle));
    plate.unread.setResolution(zoom).setText(count > 0 ? String(count) : "").setVisible(count > 0);
    const width = Math.ceil(Math.max(plate.text.width, plate.subtitle.width)) + 8;
    const height = Math.ceil(plate.text.height + (subtitle ? plate.subtitle.height : 0)) + 4;
    const left = plate.decorative ? 0 : -Math.floor(width / 2);
    plate.text.setPosition(left + 4, -height + 2);
    plate.subtitle.setPosition(left + 4, -height + 2 + plate.text.height);
    plate.panel.clear().fillStyle(COLORS.burgundy, 0.85).fillRect(left, -height, width, height);
    plate.panel.lineStyle(1, border, 1).strokeRect(left + 0.5, -height + 0.5, width - 1, height - 1);
    plate.pill.clear();
    if (count > 0) {
      const pillWidth = Math.ceil(plate.unread.width) + 6;
      const pillHeight = Math.ceil(plate.unread.height) + 2;
      plate.pill.fillStyle(COLORS.yellow, 1).fillRoundedRect(left + width, -height, pillWidth, pillHeight, 3);
      plate.unread.setPosition(left + width + 3, -height + 1);
    }
  }

  drawSelection(state) {
    this.selectionGraphics.clear();
    if (!state.ui.selected) return;
    const target = state.targetsByKey.get(targetKey(state.ui.selected));
    if (!target) return;
    const rect = target.rect;
    const x = rect.x * 8, y = rect.y * 8, w = rect.width * 8, h = rect.height * 8;
    const color = COLORS.yellow;
    this.selectionGraphics.lineStyle(2, color, 1);
    const arm = Math.min(12, Math.floor(Math.min(w, h) / 3));
    this.bracket(x, y, 1, 1, arm);
    this.bracket(x + w, y, -1, 1, arm);
    this.bracket(x, y + h, 1, -1, arm);
    this.bracket(x + w, y + h, -1, -1, arm);
  }

  bracket(x, y, sx, sy, arm) {
    this.selectionGraphics.beginPath();
    this.selectionGraphics.moveTo(x, y + sy * arm);
    this.selectionGraphics.lineTo(x, y);
    this.selectionGraphics.lineTo(x + sx * arm, y);
    this.selectionGraphics.strokePath();
  }

  drawPackets() {
    this.packetGraphics.clear();
    const now = performance.now();
    this.packets = this.packets.filter((packet) => now - packet.born < packet.duration);
    for (const packet of this.packets) {
      const progress = clamp((now - packet.born) / packet.duration, 0, 1);
      const point = sample(packet.path, packet.path.length * progress);
      const pixel = { x: point.x * 8, y: point.y * 8 };
      const last = packet.trail[packet.trail.length - 1];
      if (!last || Math.abs(last.x - pixel.x) + Math.abs(last.y - pixel.y) >= 3) packet.trail.push(pixel);
      if (packet.trail.length > 6) packet.trail.shift();
      const color = PACKET_COLORS[packet.kind] ?? COLORS.cream;
      for (let i = 0; i < packet.trail.length; i++) {
        const trail = packet.trail[i];
        const alpha = (i + 1) / packet.trail.length * 0.55;
        this.packetGraphics.fillStyle(color, alpha);
        this.packetGraphics.fillRect(trail.x - 1, trail.y - 1, 3, 3);
      }
      this.packetGraphics.fillStyle(color, 0.2);
      this.packetGraphics.fillCircle(pixel.x, pixel.y, 7);
      this.packetGraphics.fillStyle(color, 1);
      this.packetGraphics.fillRect(Math.round(pixel.x - 1), Math.round(pixel.y - 1), 3, 3);
    }
  }

  handlePacket(packet) {
    const state = this.store.snapshot();
    if (!this.packetGraphics || !state.wire || state.ui.tab !== "map" || document.visibilityState !== "visible" || state.wire.connection !== "connected") return;
    const now = performance.now();
    const lengthPx = packet.path.length * 8;
    const duration = clamp(lengthPx / 480 * 1000, 800, 3000);
    this.packets.push({ ...packet, born: now, duration, trail: [] });
    if (this.packets.length > 100) this.packets.shift();
    this.store.setAnimation(packet.senderId, "send", now);
    this.drawPackets();
  }

  update(time, delta) {
    if (!this.state.wire || this.state.ui.tab !== "map") return;
    this.clock = performance.now();
    this.setView(this.mainCamera.scrollX, this.mainCamera.scrollY);
    this.drawCharactersFrame(this.state, this.clock);
    const done = [];
    for (const [id, walk] of this.walks) if (this.clock - walk.start >= walk.duration) done.push(id);
    for (const id of done) {
      this.walks.delete(id);
      clearAnimation(this.store.animations, id, "walk");
    }
    for (const [id, animation] of this.state.animations) {
      if (typeof animation.send === "number" && this.clock - animation.send >= 800) clearAnimation(this.store.animations, id, "send");
    }
    this.drawPackets();
    this.drawRain(time);
    this.updateFollow(delta);
    if (this.clock - this.lastViewportRefresh >= 100) {
      this.lastViewportRefresh = this.clock;
      this.hud?.refreshViewport?.();
    }
  }

  updateFollow(delta) {
    const state = this.state;
    if (!state.ui.follow || !state.ui.selected) return;
    const selected = state.ui.selected;
    const followTarget = state.ui.follow === "session" && selected.kind === "membership"
      ? { kind: "character", id: selected.id } : selected;
    const target = state.targetsByKey.get(targetKey(followTarget));
    if (!target) return;
    if (state.ui.follow === "traffic") {
      const selected = state.ui.selected;
      let recent = null;
      for (let i = this.packets.length - 1; i >= 0; i--) {
        const packet = this.packets[i];
        const destination = selected.kind === "venue"
          ? packet.to?.kind === "venue" && packet.to.venueKey === selected.venueKey
          : packet.to?.kind === "character" && packet.to.id === selected.id;
        if (packet.senderId === selected.id || destination) {
          recent = packet;
          break;
        }
      }
      if (recent) {
        const progress = clamp((performance.now() - recent.born) / recent.duration, 0, 1);
        const point = px(sample(recent.path, recent.path.length * progress));
        this.lerpTo(point.x, point.y, delta);
        return;
      }
    }
    this.lerpTo(target.anchor.x * 8, target.anchor.y * 8, delta);
  }


  lerpTo(x, y, delta) {
    const zoom = this.mainCamera.zoom;
    const tx = x - this.scale.width / (2 * zoom);
    const ty = y - this.scale.height / (2 * zoom);
    const f = 1 - Math.pow(0.9, Math.max(1, delta / 16.67));
    this.setView(this.mainCamera.scrollX + (tx - this.mainCamera.scrollX) * f, this.mainCamera.scrollY + (ty - this.mainCamera.scrollY) * f);
  }

  createBackdropTiles(width, height) {
    this.skyFill = this.add.graphics();
    this.bgLayer.add(this.skyFill);
    this.farTile = this.add.tileSprite(0, 0, width, 270, "skyline-far").setOrigin(0, 0);
    this.midTile = this.add.tileSprite(0, 0, width, 270, "skyline-mid").setOrigin(0, 0);
    this.bgLayer.add([this.farTile, this.midTile]);
    this.groundFill = this.add.graphics();
    this.bgLayer.add(this.groundFill);
    this.resizeBackdrop(width, height);
  }

  resizeBackdrop(width, height) {
    this.bgCamera.setSize(width, height);
    this.fxCamera.setSize(width, height);
    this.mainCamera.setSize(width, height);
    this.backdropSignature = null;
    this.updateBackdrop();
  }

  updateBackdrop() {
    if (!this.farTile) return;
    const camera = this.mainCamera;
    const width = camera.width, height = camera.height;
    const signature = `${width}:${height}:${camera.scrollX}:${camera.scrollY}:${camera.zoom}`;
    if (signature === this.backdropSignature) return;
    this.backdropSignature = signature;
    this.tileScale = camera.zoom;
    const tileWidth = Math.ceil(width / this.tileScale) + 2;
    const farBottom = (8 - camera.scrollY) * camera.zoom;
    const midBottom = (48 - camera.scrollY) * camera.zoom;
    this.farTile.setScale(this.tileScale).setSize(tileWidth, 270).setPosition(0, farBottom - 270 * this.tileScale);
    this.midTile.setScale(this.tileScale).setSize(tileWidth, 270).setPosition(0, midBottom - 270 * this.tileScale);
    this.farTile.tilePositionX = camera.scrollX * 0.15 / this.tileScale;
    this.midTile.tilePositionX = camera.scrollX * 0.35 / this.tileScale;
    this.skyFill.clear().fillStyle(0x100609, 1).fillRect(0, 0, width, height);
    this.groundFill.clear();
    const groundTop = clamp(midBottom, 0, height);
    this.groundFill.fillStyle(0x0b0407, 1).fillRect(0, groundTop, width, height - groundTop);
    if (midBottom >= 0 && midBottom < height) {
      this.groundFill.fillStyle(0xa52b3a, 1).fillRect(0, midBottom, width, 1);
    }
  }

  nextVacantX(wire) {
    return Math.floor((Math.max(...wire.layout.venues.map((venue) => venue.rect.x / 48), -1) + 1) * 48) * 8;
  }

  worldBounds() {
    const bounds = this.state.wire?.layout.bounds;
    const lotX = this.vacantX ?? (this.state.wire ? this.nextVacantX(this.state.wire) : 0);
    const left = Math.min(bounds ? bounds.x * 8 : 0, lotX);
    const top = Math.min(bounds ? bounds.y * 8 : -32, -32);
    const right = Math.max(bounds ? (bounds.x + bounds.width) * 8 : 320, lotX + 320);
    const bottom = Math.max(bounds ? (bounds.y + bounds.height) * 8 : 48, 48);
    return { x: left - 320, y: top - 96, width: right - left + 640, height: bottom - top + 192 };
  }

  setView(scrollX, scrollY, zoom = this.mainCamera.zoom) {
    const camera = this.mainCamera;
    const view = clampView({ scrollX, scrollY, zoom }, { width: camera.width, height: camera.height }, this.worldBounds());
    const zoomChanged = camera.zoom !== zoom;
    camera.setZoom(zoom).setScroll(view.scrollX, view.scrollY);
    this.updateBackdrop();
    if (zoomChanged && this.characterReady && this.state.wire) {
      this.drawSigns(this.state);
      this.drawCharactersFrame(this.state, performance.now());
      this.drawHolograms(this.state);
    }
  }

  proceduralSkyline(key, mid) {
    const canvas = document.createElement("canvas");
    canvas.width = 960; canvas.height = 270;
    const context = canvas.getContext("2d");
    context.clearRect(0, 0, canvas.width, canvas.height);
    if (!mid) {
      context.fillStyle = "#100609";
      context.fillRect(0, 0, 960, 270);
      for (let y = 0; y < 270; y += 3) {
        context.fillStyle = y % 9 === 0 ? "rgba(85,206,209,.025)" : "rgba(244,228,90,.018)";
        context.fillRect(0, y, 960, 1);
      }
    }
    let seed = fnv1a(key);
    const rand = () => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed / 0x100000000; };
    let x = 0;
    while (x < 960) {
      const width = 24 + Math.floor(rand() * 72);
      const height = 48 + Math.floor(rand() * (mid ? 130 : 150));
      const top = 270 - height;
      context.fillStyle = mid ? ["#281018", "#32111c", "#3d1420"][Math.floor(rand() * 3)] : ["#180a10", "#200c14", "#281018"][Math.floor(rand() * 3)];
      context.fillRect(x, top, width, height);
      context.fillStyle = mid ? "#a52b3a" : "#38202a";
      context.fillRect(x, top, width, 2);
      for (let wy = top + 8; wy < 264; wy += 12) for (let wx = x + 5; wx < x + width - 4; wx += 10) {
        const chance = rand();
        if (chance > 0.78) {
          context.fillStyle = chance > 0.95 ? "#55ced1" : chance > 0.88 ? "#f4e45a" : "#a52b3a";
          context.fillRect(wx, wy, 3, 4);
        }
      }
      if (mid && rand() > 0.55) {
        context.fillStyle = "#a52b3a";
        context.fillRect(x + width / 2, top - 16, 2, 16);
        context.fillRect(x + width / 2 - 10, top - 10, 20, 2);
      }
      x += width + 4;
    }
    if (this.textures.exists(key)) this.textures.remove(key);
    this.textures.addCanvas(key, canvas);
  }

  async loadBackdrop(key, url) {
    try {
      const response = await fetch(url, { cache: "force-cache" });
      if (!response.ok) return;
      const bitmap = await createImageBitmap(await response.blob());
      const canvas = document.createElement("canvas"); canvas.width = bitmap.width; canvas.height = bitmap.height;
      canvas.getContext("2d").drawImage(bitmap, 0, 0);
      bitmap.close?.();
      const loadedKey = `${key}:provided`;
      this.replaceCanvasTexture(loadedKey, canvas);
      (key === "skyline-far" ? this.farTile : this.midTile).setTexture(loadedKey);
    } catch { /* The deterministic procedural skyline remains in place. */ }
  }

  seedRain() {
    let seed = 0x5eed1234;
    const rand = () => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed / 0x100000000; };
    this.rain = Array.from({ length: 120 }, () => ({ x: rand(), y: rand(), speed: 40 + rand() * 100, drift: -12 + rand() * 24 }));
  }

  drawRain(time) {
    this.rainGraphics.clear();
    if (!this.state.wire || this.state.wire.reducedMotion || document.visibilityState !== "visible") return;
    const width = this.scale.width, height = this.scale.height;
    this.rainGraphics.lineStyle(1, COLORS.cyan, 0.25);
    for (const drop of this.rain) {
      const y = ((drop.y * height + time * drop.speed / 1000) % height);
      const x = ((drop.x * width + time * drop.drift / 1000) % width + width) % width;
      this.rainGraphics.beginPath();
      this.rainGraphics.moveTo(Math.round(x), Math.round(y));
      this.rainGraphics.lineTo(Math.round(x + 1), Math.round(y + 4));
      this.rainGraphics.strokePath();
    }
  }

  resize(width, height) {
    this.resizeBackdrop(width, height);
    this.setView(this.mainCamera.scrollX, this.mainCamera.scrollY);
    if (this.state.wire) this.applyOfflineEffect(this.state.wire.connection === "offline");
    this.drawRain(performance.now());
    this.hud?.refreshViewport?.();
  }

  replaceCanvasTexture(key, canvas) {
    if (this.textures.exists(key)) this.textures.remove(key);
    this.textures.addCanvas(key, canvas);
  }

  onPointerDown(pointer) {
    if (pointer.button !== 0) return;
    this.lastPointer = { x: pointer.x, y: pointer.y, scrollX: this.mainCamera.scrollX, scrollY: this.mainCamera.scrollY, dragged: false };
    this.game.canvas.style.cursor = "grabbing";
  }

  onPointerMove(pointer) {
    if (!this.lastPointer || !pointer.isDown) return;
    const dx = pointer.x - this.lastPointer.x, dy = pointer.y - this.lastPointer.y;
    if (Math.abs(dx) + Math.abs(dy) > 3) this.lastPointer.dragged = true;
    if (!this.lastPointer.dragged) return;
    this.store.setFollow(false);
    this.setView(this.lastPointer.scrollX - dx / this.mainCamera.zoom, this.lastPointer.scrollY - dy / this.mainCamera.zoom);
  }

  onPointerUp(pointer) {
    if (!this.lastPointer) return;
    const pointerState = this.lastPointer;
    this.endDrag();
    if (pointerState.dragged) return;
    const now = performance.now();
    const worldX = this.mainCamera.scrollX + pointer.x / this.mainCamera.zoom;
    const worldY = this.mainCamera.scrollY + pointer.y / this.mainCamera.zoom;
    const target = this.hitTarget(worldX, worldY);
    if (!target) { this.lastClickAt = 0; this.lastClickKey = null; return; }
    const selectedKey = targetKey(target);
    this.store.setSelected(target);
    if (this.lastClickKey === selectedKey && now - this.lastClickAt < 350) this.openChat(target);
    this.lastClickAt = now;
    this.lastClickKey = selectedKey;
  }

  endDrag() {
    this.lastPointer = null;
    this.game.canvas.style.cursor = "grab";
  }

  hitTarget(x, y) {
    const state = this.store.snapshot();
    const positions = state.wire.layout.targets;
    const hits = positions.filter(({ target, rect }) => {
      if (target.kind !== "venue") {
        const character = state.charactersById.get(target.id);
        if (character?.source === "process" && !state.ui.showProcesses) return false;
      }
      return x >= rect.x * 8 && x < (rect.x + rect.width) * 8 && y >= rect.y * 8 && y < (rect.y + rect.height) * 8;
    }).sort((a, b) => priority(b.target) - priority(a.target));
    return hits[0]?.target ?? null;
  }

  onWheel(pointer, objects, dx, dy) {
    if (!this.state.wire) return;
    if (!pointer.event.ctrlKey) {
      this.wheelZoomDelta = 0;
      this.pan(dx, dy);
      return;
    }
    if (dy === 0) return;
    this.wheelZoomDelta += dy;
    while (Math.abs(this.wheelZoomDelta) >= 80) {
      const direction = this.wheelZoomDelta < 0 ? 1 : -1;
      this.wheelZoomDelta += direction * 80;
      this.zoomStep(direction, pointer.x, pointer.y);
    }
  }

  onKeyDown(event) {
    if (event.defaultPrevented || isTextEntry(event.target) || isTextEntry(document.activeElement)) return;
    const key = event.key;
    if (this.state.ui.tab !== "map") {
      if (key === "Escape") {
        if (this.state.ui.searchOpen) this.hud?.closeSearch();
        else if (this.state.ui.chat) this.hud?.closeChat();
        else return;
        event.preventDefault();
      }
      return;
    }
    let handled = true;
    const selected = this.state.ui.selected;
    switch (key) {
      case "ArrowUp": case "w": case "W": this.pan(0, -64); break;
      case "ArrowDown": case "s": case "S": this.pan(0, 64); break;
      case "ArrowLeft": case "a": case "A": this.pan(-64, 0); break;
      case "ArrowRight": case "d": case "D": this.pan(64, 0); break;
      case "Tab": {
        const targets = orderedTargets(this.state, this.state.ui.filter, this.state.ui.showProcesses);
        const item = cycle(targets, keyOf(selected), event.shiftKey ? -1 : 1);
        if (item) { this.store.setSelected(item.target); this.centerTarget(item.target); }
        break;
      }
      case "Enter": if (selected) this.openChat(selected); else handled = false; break;
      case "Escape":
        if (this.state.ui.searchOpen) this.hud?.closeSearch();
        else if (this.state.ui.chat) this.hud?.closeChat();
        else if (selected) this.store.setSelected(null);
        else handled = false;
        break;
      case " ": this.store.setFocus(!this.state.ui.focus); break;
      case "+": case "=": this.zoomStep(1); break;
      case "-": this.zoomStep(-1); break;
      case "0": this.fitSelection(); break;
      case "Home": this.fitCity(); break;
      case "c": case "C":
        if (selected && this.hud?.scopeFor?.(selected)) this.openChat(selected);
        else this.hud?.openChat(null);
        break;
      case "m": case "M": this.hud?.openManage(selected); break;
      case "/": this.hud?.openSearch(); break;
      case "f": case "F": {
        const character = selected?.kind !== "venue" ? this.state.charactersById.get(selected?.id) : null;
        this.store.setFollow(this.state.ui.follow === "session" ? false : character?.source === "registered" ? "session" : false);
        break;
      }
      case "t": case "T": this.store.setFollow(this.state.ui.follow === "traffic" ? false : "traffic"); break;
      case "h": case "H": {
        const at = HARNESS_FILTERS.indexOf(this.state.ui.filter);
        this.store.setFilter(HARNESS_FILTERS[(at + 1) % HARNESS_FILTERS.length]);
        break;
      }
      case "p": case "P": this.store.setShowProcesses(!this.state.ui.showProcesses); break;
      case "i": case "I": this.store.setInspectorOpen(!this.state.ui.inspectorOpen); break;
      default: handled = false;
    }
    if (handled) event.preventDefault();
  }

  pan(dx, dy) {
    const zoom = this.mainCamera.zoom;
    this.setView(this.mainCamera.scrollX + dx / zoom, this.mainCamera.scrollY + dy / zoom);
    this.store.setFollow(false);
  }

  zoomStep(direction, screenX = this.mainCamera.width / 2, screenY = this.mainCamera.height / 2) {
    const camera = this.mainCamera;
    const current = camera.zoom;
    const at = this.cameraZooms.indexOf(current);
    const next = this.cameraZooms[clamp(at + direction, 0, this.cameraZooms.length - 1)];
    const worldX = camera.scrollX + screenX / current;
    const worldY = camera.scrollY + screenY / current;
    this.setView(worldX - screenX / next, worldY - screenY / next, next);
    this.store.setFollow(false);
  }

  centerTarget(target) {
    if (!this.mainCamera) return;
    const position = this.state.targetsByKey.get(targetKey(target));
    if (!position) return;
    this.setView(position.anchor.x * 8 - this.mainCamera.width / (2 * this.mainCamera.zoom),
      position.anchor.y * 8 - this.mainCamera.height / (2 * this.mainCamera.zoom));
    this.hud?.refreshViewport?.();
  }
  centerAt(x, y) {
    if (!this.mainCamera) return;
    this.setView(x - this.mainCamera.width / (2 * this.mainCamera.zoom),
      y - this.mainCamera.height / (2 * this.mainCamera.zoom));
    this.store.setFollow(false);
    this.hud?.refreshViewport?.();
  }

  fitSelection() {
    if (!this.mainCamera) return;
    const target = this.state.ui.selected;
    if (!target) { this.fitCity(); return; }
    const position = this.state.targetsByKey.get(targetKey(target));
    if (!position) return;
    const width = position.rect.width * 8, height = position.rect.height * 8;
    const zoom = [...this.cameraZooms].reverse().find((value) => width * value <= this.scale.width * 0.82 && height * value <= this.scale.height * 0.82) ?? 1;
    this.setView((position.rect.x + position.rect.width / 2) * 8 - this.mainCamera.width / (2 * zoom),
      (position.rect.y + position.rect.height / 2) * 8 - this.mainCamera.height / (2 * zoom), zoom);
    this.store.setFollow(false);
  }

  fitCity() {
    if (!this.mainCamera || !this.state.wire) return;
    const venues = this.state.wire.layout.venues;
    const world = this.worldBounds();
    const left = venues.length ? Math.min(...venues.map((venue) => venue.rect.x * 8)) : world.x + 320;
    const top = venues.length ? Math.min(...venues.map((venue) => venue.rect.y * 8 - 54)) : world.y + 96;
    const right = venues.length ? Math.max(...venues.map((venue) => (venue.rect.x + venue.rect.width) * 8)) : world.x + world.width - 320;
    const bottom = venues.length ? Math.max(...venues.map((venue) => (venue.rect.y + venue.rect.height) * 8)) : world.y + world.height - 96;
    const bounds = { x: left, y: top, width: right - left, height: bottom - top };
    const zoom = [...this.cameraZooms].reverse().find((value) =>
      bounds.width * value <= this.mainCamera.width && bounds.height * value <= this.mainCamera.height) ?? 1;
    this.setView(bounds.x + bounds.width / 2 - this.mainCamera.width / (2 * zoom),
      bounds.y + bounds.height / 2 - this.mainCamera.height / (2 * zoom), zoom);
    this.store.setFollow(false);
  }

  openChat(target) {
    const scope = this.hud?.scopeFor?.(target);
    if (scope) this.hud.openChat(scope);
  }

  viewportCells() {
    const camera = this.mainCamera;
    if (!camera) return null;
    return { x: camera.scrollX / 8, y: camera.scrollY / 8, width: this.scale.width / camera.zoom / 8, height: this.scale.height / camera.zoom / 8 };
  }

  getViewportRect() { return this.viewportCells(); }
}

function samplePolyline(points, distance) {
  let left = distance;
  for (let i = 1; i < points.length; i++) {
    const from = points[i - 1], to = points[i];
    const length = Math.abs(to.x - from.x) + Math.abs(to.y - from.y);
    if (left <= length) {
      const p = length ? left / length : 0;
      return { x: from.x + (to.x - from.x) * p, y: from.y + (to.y - from.y) * p };
    }
    left -= length;
  }
  return points[points.length - 1];
}

function clearAnimation(animations, id, name) {
  const current = animations.get(id);
  if (!current || !(name in current)) return;
  const next = { ...current };
  delete next[name];
  if (Object.keys(next).length) animations.set(id, next);
  else animations.delete(id);
}

function priority(target) { return target.kind === "character" ? 3 : target.kind === "membership" ? 2 : 1; }
function dashedRect(graphics, x, y, width, height, dash, gap) {
  const line = (x1, y1, x2, y2) => {
    const length = Math.abs(x2 - x1) + Math.abs(y2 - y1);
    const dx = Math.sign(x2 - x1), dy = Math.sign(y2 - y1);
    for (let offset = 0; offset < length; offset += dash + gap) {
      const end = Math.min(length, offset + dash);
      graphics.beginPath();
      graphics.moveTo(x1 + dx * offset, y1 + dy * offset);
      graphics.lineTo(x1 + dx * end, y1 + dy * end);
      graphics.strokePath();
    }
  };
  line(x, y, x + width, y);
  line(x + width, y, x + width, y + height);
  line(x + width, y + height, x, y + height);
  line(x, y + height, x, y);
}
