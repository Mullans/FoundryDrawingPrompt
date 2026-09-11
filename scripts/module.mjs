import { MODULE_ID } from "./constants.mjs";
import { registerAPI } from "./api.mjs";
import { registerSettings, migrateLegacySettings } from "./settings.mjs";
import { initSocket } from "./socket.mjs";
import { getSocketHandlers, openPlayerPromptList, openPromptLibrary } from "./prompts/prompt-service.mjs";
import { loadAllPrompts } from "./prompts/persistence-service.mjs";
import { recoverInterruptedPromptDeliveries } from "./prompts/prompt-delivery.mjs";
import { renderTokenTransformHUD } from "./foundry/token-transform-service.mjs";

Hooks.once("init", () => {
  registerSettings();
});

Hooks.once("socketlib.ready", () => {
  initSocket(getSocketHandlers());
});

Hooks.once("ready", async () => {
  registerAPI();
  await migrateLegacySettings();
  if ( !globalThis.socketlib ) ui.notifications.error(game.i18n.localize("DRAWING-PROMPTS.errors.socketlibMissing"));
  if ( game.user.isGM ) {
    await recoverInterruptedPromptDeliveries();
    const activeCount = loadAllPrompts().filter(prompt => prompt.needsAttention).length;
    if ( activeCount ) ui.notifications.info(game.i18n.format("DRAWING-PROMPTS.notifications.activePrompts", { count: activeCount }));
  }
  console.log(`${MODULE_ID} | ready`);
});

Hooks.on("userConnected", (user, connected) => {
  if ( connected && game.user.isGM ) {
    import("./prompts/prompt-service.mjs").then(async s => {
      await s.processRecoveryTombstonesForUser(user.id);
      await s.redeliverAssignmentsForUser(user.id);
    });
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
    onChange: () => game.user.isGM ? openPromptLibrary() : openPlayerPromptList()
  };
});

Hooks.on("renderTokenHUD", renderTokenTransformHUD);

/**
 * Refresh open Drawing Prompts applications after external user state changes.
 * @returns {Promise<void>}
 */
async function refreshOpenApplications() {
  const [{ DrawingPromptManager }, { PlayerPromptList }, { PromptLibrary }] = await Promise.all([
    import("./apps/drawing-prompt-manager.mjs"),
    import("./apps/player-prompt-list.mjs"),
    import("./apps/prompt-library.mjs")
  ]);
  DrawingPromptManager.refreshOpen();
  PlayerPromptList.refreshOpen();
  PromptLibrary.refreshOpen();
}
