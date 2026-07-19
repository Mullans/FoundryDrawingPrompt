export const MODULE_ID = "drawing-prompts";
export const FLAG_PROMPT = "prompt";
export const FILES_UPLOAD_PERMISSION = "FILES_UPLOAD";

export const STATUS = Object.freeze({
  PENDING: "pending",
  OPENED: "opened",
  SUBMITTED: "submitted",
  REJECTED: "rejected",
  CANCELLED: "cancelled"
});

export const BG_SOURCE = Object.freeze({
  BLANK: "blank",
  FILE: "file",
  TOKEN: "token",
  TILE: "tile",
  SCENE: "scene"
});

export const FIT_MODE = Object.freeze({
  CENTER: "center",
  FIT_WIDTH: "fit-width",
  FIT_HEIGHT: "fit-height",
  STRETCH: "stretch"
});

export const INTERNAL = Object.freeze({
  SNAPSHOT_THROTTLE_MS: 1500,
  SNAPSHOT_MAX_EDGE: 512,
  SNAPSHOT_EVERY_OPS: 8,
  MAX_CHECKPOINTS: 6,
  SNAPSHOT_QUALITY: 0.5,
  MAX_SNAPSHOT_WIRE_BYTES: 512 * 1024,
  MAX_CANVAS_DIM: 4096,
  EXPORT_WEBP_QUALITY_DEFAULT: 0.9,
  MAX_SUBMISSION_BYTES: 4 * 1024 * 1024,
  MAX_OPLOG_BYTES: 512 * 1024,
  WIRE_QUALITY_STEPS: Object.freeze([0.8, 0.6, 0.45]),
  WIRE_DOWNSCALE_STEP: 0.75
});

export const SETTINGS = Object.freeze({
  DEFAULT_CANVAS_WIDTH: "defaultCanvasWidth",
  DEFAULT_CANVAS_HEIGHT: "defaultCanvasHeight",
  DEFAULT_TIMER_SECONDS: "defaultTimerSeconds",
  DEFAULT_FIT_MODE: "defaultFitMode",
  EXPORT_FORMAT: "exportFormat",
  WEBP_QUALITY: "webpQuality",
  DEFAULT_PERMISSIONS: "defaultPermissions",
  ASSET_FOLDER: "assetFolder",
  DEFAULT_CLONE_SOURCE_ACTOR_UUID: "defaultCloneSourceActorUuid",
  LAST_SAVE_FOLDER: "lastSaveFolder",
  LAST_BRUSH_COLOR: "lastBrushColor",
  AUTO_OPEN_PLAYER_WINDOW: "autoOpenPlayerWindow",
  NOTIFY_PLAYER: "notifyPlayer",
  LIVE_PREVIEW: "livePreview"
});
