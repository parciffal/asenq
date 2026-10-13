import { createApi } from "./api.js";
import { CityStore } from "./store.js";
import { CityHud } from "./hud.js";
import { CityScene } from "./scene.js";
import { streetLayout, streetRoute } from "./mapkit.js";

async function main() {
  const api = createApi();
  if (!api.token) {
    const message = document.createElement("main");
    message.className = "full-page-error";
    message.textContent = "Open the URL printed by asenq city";
    document.body.replaceChildren(message);
    return;
  }

  await Promise.all([
    document.fonts.load("8px Silkscreen"),
    document.fonts.load("12px Share Tech Mono"),
  ]);

  const store = new CityStore();
  const hud = new CityHud(store, api);
  let scene;
  let resolveScene;
  const sceneReady = new Promise((resolve) => { resolveScene = resolve; });
  const BoundCityScene = class extends CityScene {
    constructor() {
      super(store, hud);
      scene = this;
      resolveScene(this);
    }
  };
  const game = new Phaser.Game({
    type: Phaser.AUTO,
    parent: "city",
    backgroundColor: "#100609",
    pixelArt: true,
    roundPixels: true,
    scale: { mode: Phaser.Scale.RESIZE, parent: "city" },
    scene: [BoundCityScene],
  });
  if (!scene) scene = await sceneReady;
  hud.setScene(scene);

  const closeEvents = api.events({
    state: (wire) => hud.handleState({ ...wire, layout: streetLayout(wire.layout) }),
    packet: (packet) => scene.handlePacket({ ...packet, path: streetRoute(packet.path) }),
    message: (data) => hud.handleMessage(data),
    read: (data) => hud.handleRead(data),
    connection: (open) => {
      store.setConnectionState(open ? "open" : "reconnecting");
      if (open) {
        hud.refreshConversations();
        if (store.ui.chat) hud.loadHistory(store.ui.chat);
      }
    },
  });
  hud.refreshConversations();
  const close = () => {
    closeEvents();
    hud.destroy();
    game.destroy(true);
  };
  window.addEventListener("pagehide", close, { once: true });
}

main().catch((error) => {
  const message = document.createElement("main");
  message.className = "full-page-error";
  message.textContent = `Unable to start city map: ${error.message}`;
  document.body.replaceChildren(message);
});
