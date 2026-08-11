import { CANVAS_CHROME, FIT_MODE, INTERNAL, MODULE_ID, SETTINGS } from "./constants.mjs";
import { CloneSourceSettings } from "./apps/clone-source-settings.mjs";

const PREFIX = "DRAWING-PROMPTS.settings";

/**
 * Register Drawing Prompts world settings.
 * @returns {void}
 */
export function registerSettings() {
  const common = { scope: "world", config: true };

  game.settings.registerMenu(MODULE_ID, "cloneSource", {
    name: `${PREFIX}.cloneSource.menuName`,
    label: `${PREFIX}.cloneSource.menuLabel`,
    hint: `${PREFIX}.cloneSource.menuHint`,
    icon: "fa-solid fa-user-group",
    type: CloneSourceSettings,
    restricted: true
  });

  game.settings.register(MODULE_ID, SETTINGS.DEFAULT_CANVAS_WIDTH, {
    ...common,
    name: `${PREFIX}.defaultCanvasWidth.name`,
    hint: `${PREFIX}.defaultCanvasWidth.hint`,
    type: Number,
    default: 512,
    range: { min: 1, max: INTERNAL.MAX_CANVAS_DIM, step: 1 }
  });

  game.settings.register(MODULE_ID, SETTINGS.DEFAULT_CANVAS_HEIGHT, {
    ...common,
    name: `${PREFIX}.defaultCanvasHeight.name`,
    hint: `${PREFIX}.defaultCanvasHeight.hint`,
    type: Number,
    default: 512,
    range: { min: 1, max: INTERNAL.MAX_CANVAS_DIM, step: 1 }
  });

  game.settings.register(MODULE_ID, SETTINGS.DEFAULT_TIMER_SECONDS, {
    ...common,
    name: `${PREFIX}.defaultTimerSeconds.name`,
    hint: `${PREFIX}.defaultTimerSeconds.hint`,
    type: Number,
    default: 0,
    range: { min: 0, max: 3600, step: 30 }
  });

  game.settings.register(MODULE_ID, SETTINGS.TIMER_EXTEND_SHORT, {
    ...common,
    name: `${PREFIX}.timerExtendShort.name`,
    hint: `${PREFIX}.timerExtendShort.hint`,
    type: Number,
    default: 30,
    range: { min: 0, max: 3600, step: 1 }
  });

  game.settings.register(MODULE_ID, SETTINGS.TIMER_EXTEND_LONG, {
    ...common,
    name: `${PREFIX}.timerExtendLong.name`,
    hint: `${PREFIX}.timerExtendLong.hint`,
    type: Number,
    default: 120,
    range: { min: 0, max: 3600, step: 1 }
  });

  game.settings.register(MODULE_ID, SETTINGS.TIMER_REDUCE_SHORT, {
    ...common,
    name: `${PREFIX}.timerReduceShort.name`,
    hint: `${PREFIX}.timerReduceShort.hint`,
    type: Number,
    default: 30,
    range: { min: 0, max: 3600, step: 1 }
  });

  game.settings.register(MODULE_ID, SETTINGS.TIMER_REDUCE_LONG, {
    ...common,
    name: `${PREFIX}.timerReduceLong.name`,
    hint: `${PREFIX}.timerReduceLong.hint`,
    type: Number,
    default: 120,
    range: { min: 0, max: 3600, step: 1 }
  });

  game.settings.register(MODULE_ID, SETTINGS.DEFAULT_FIT_MODE, {
    ...common,
    name: `${PREFIX}.defaultFitMode.name`,
    hint: `${PREFIX}.defaultFitMode.hint`,
    type: String,
    choices: {
      [FIT_MODE.CENTER]: "DRAWING-PROMPTS.choices.fitMode.center",
      [FIT_MODE.FIT_WIDTH]: "DRAWING-PROMPTS.choices.fitMode.fitWidth",
      [FIT_MODE.FIT_HEIGHT]: "DRAWING-PROMPTS.choices.fitMode.fitHeight",
      [FIT_MODE.FIT_CANVAS]: "DRAWING-PROMPTS.choices.fitMode.fitCanvas",
      [FIT_MODE.STRETCH]: "DRAWING-PROMPTS.choices.fitMode.stretch"
    },
    default: FIT_MODE.FIT_WIDTH
  });

  game.settings.register(MODULE_ID, SETTINGS.EXPORT_FORMAT, {
    ...common,
    name: `${PREFIX}.exportFormat.name`,
    hint: `${PREFIX}.exportFormat.hint`,
    type: String,
    choices: {
      webp: "DRAWING-PROMPTS.choices.exportFormat.webp",
      png: "DRAWING-PROMPTS.choices.exportFormat.png"
    },
    default: "webp"
  });

  game.settings.register(MODULE_ID, SETTINGS.WEBP_QUALITY, {
    ...common,
    name: `${PREFIX}.webpQuality.name`,
    hint: `${PREFIX}.webpQuality.hint`,
    type: Number,
    default: INTERNAL.EXPORT_WEBP_QUALITY_DEFAULT,
    range: { min: 0, max: 1, step: 0.05 }
  });

  game.settings.register(MODULE_ID, SETTINGS.DEFAULT_PERMISSIONS, {
    ...common,
    // This becomes user-facing with the V2 gallery; keep the setting hidden in V1.
    config: false,
    name: `${PREFIX}.defaultPermissions.name`,
    hint: `${PREFIX}.defaultPermissions.hint`,
    type: String,
    choices: {
      "gm-only": "DRAWING-PROMPTS.choices.defaultPermissions.gmOnly"
    },
    default: "gm-only"
  });

  game.settings.register(MODULE_ID, SETTINGS.ASSET_FOLDER, {
    ...common,
    name: `${PREFIX}.assetFolder.name`,
    hint: `${PREFIX}.assetFolder.hint`,
    type: String,
    default: ""
  });

  game.settings.register(MODULE_ID, SETTINGS.DEFAULT_CLONE_SOURCE_ACTOR_UUID, {
    scope: "world",
    config: false,
    type: String,
    default: ""
  });

  game.settings.register(MODULE_ID, SETTINGS.LAST_SAVE_FOLDER, {
    scope: "world",
    config: false,
    type: String,
    default: ""
  });

  game.settings.register(MODULE_ID, SETTINGS.LAST_BRUSH_COLOR, {
    scope: "client",
    config: false,
    type: String,
    default: ""
  });

  game.settings.register(MODULE_ID, SETTINGS.CANVAS_CHROME, {
    scope: "client",
    config: true,
    name: `${PREFIX}.canvasChrome.name`,
    hint: `${PREFIX}.canvasChrome.hint`,
    type: String,
    choices: {
      [CANVAS_CHROME.BLACK]: "DRAWING-PROMPTS.choices.canvasChrome.black",
      [CANVAS_CHROME.WHITE]: "DRAWING-PROMPTS.choices.canvasChrome.white",
      [CANVAS_CHROME.CHECKERBOARD]: "DRAWING-PROMPTS.choices.canvasChrome.checkerboard"
    },
    default: CANVAS_CHROME.CHECKERBOARD
  });

  game.settings.register(MODULE_ID, SETTINGS.AUTO_OPEN_PLAYER_WINDOW, {
    ...common,
    name: `${PREFIX}.autoOpenPlayerWindow.name`,
    hint: `${PREFIX}.autoOpenPlayerWindow.hint`,
    type: Boolean,
    default: true
  });

  game.settings.register(MODULE_ID, SETTINGS.NOTIFY_PLAYER, {
    ...common,
    name: `${PREFIX}.notifyPlayer.name`,
    hint: `${PREFIX}.notifyPlayer.hint`,
    type: Boolean,
    default: true
  });

  game.settings.register(MODULE_ID, SETTINGS.LIVE_PREVIEW, {
    ...common,
    name: `${PREFIX}.livePreview.name`,
    hint: `${PREFIX}.livePreview.hint`,
    type: Boolean,
    default: true
  });
}
