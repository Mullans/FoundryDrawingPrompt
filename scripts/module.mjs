import { MODULE_ID } from "./constants.mjs";
import { registerAPI } from "./api.mjs";
import { registerSettings } from "./settings.mjs";
import { initSocket } from "./socket.mjs";
import { getSocketHandlers, openPlayerPromptList, openPromptManager } from "./prompts/prompt-service.mjs";
import { loadAllPrompts } from "./prompts/persistence-service.mjs";

Hooks.once("init", () => {
  registerSettings();
});

Hooks.once("socketlib.ready", () => {
  initSocket(getSocketHandlers());
});

Hooks.once("ready", () => {
  registerAPI();
  if ( !globalThis.socketlib ) ui.notifications.error(game.i18n.localize("DRAWING-PROMPTS.errors.socketlibMissing"));
  if ( game.user.isGM ) {
    const activeCount = loadAllPrompts().filter(prompt => prompt.needsAttention).length;
    if ( activeCount ) ui.notifications.info(game.i18n.format("DRAWING-PROMPTS.notifications.activePrompts", { count: activeCount }));
  }
  console.log(`${MODULE_ID} | ready`);
});

Hooks.on("userConnected", (user, connected) => {
  if ( connected && game.user.isGM ) {
    import("./prompts/prompt-service.mjs").then(s => s.redeliverAssignmentsForUser(user.id));
  }
  void refreshOpenApplications();
});

Hooks.on("getSceneControlButtons", controls => {
  const tokenControls = controls.tokens;
  if ( !tokenControls?.tools ) return;
  tokenControls.tools.drawingPrompts = {
    name: "drawingPrompts",
    title: "DRAWING-PROMPTS.control.title",
    icon: "fa-solid fa-palette",
    order: Object.keys(tokenControls.tools).length + 50,
    button: true,
    visible: true,
    onChange: () => game.user.isGM ? openPromptManager() : openPlayerPromptList()
  };
});

/**
 * Refresh open Drawing Prompts applications after external user state changes.
 * @returns {Promise<void>}
 */
async function refreshOpenApplications() {
  const [{ DrawingPromptManager }, { PlayerPromptList }] = await Promise.all([
    import("./apps/drawing-prompt-manager.mjs"),
    import("./apps/player-prompt-list.mjs")
  ]);
  DrawingPromptManager.refreshOpen();
  PlayerPromptList.refreshOpen();
}
