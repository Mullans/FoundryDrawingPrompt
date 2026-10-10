const { ApplicationV2, HandlebarsApplicationMixin } = foundry.applications.api;
const PREFIX = "DRAWING-PROMPTS.orphans.";

function assertGM() {
  if ( !game.user?.isGM ) throw new Error(game.i18n.localize("DRAWING-PROMPTS.errors.gmOnly"));
}

function displayDate(value) {
  const time = typeof value === "number" ? value : Date.parse(value);
  return Number.isFinite(time) ? new Intl.DateTimeFormat(game.i18n.lang, { dateStyle: "medium", timeStyle: "short" }).format(time)
    : game.i18n.localize(`${PREFIX}unknown`);
}

function localizedReason(record) {
  const supported = new Set(["unsupported", "unavailable", "denied", "unconfirmed", "unableToVerify", "failed"]);
  const reason = record.uncertainDeletion ? "uncertainDeletion" : record.deferred ? "deferred"
    : supported.has(record.status) ? record.status : "failed";
  return game.i18n.localize(`${PREFIX}reason.${reason}`);
}

/** GM reference window. All verification/deletion decisions belong to the cleanup service. */
export class OrphanFiles extends HandlebarsApplicationMixin(ApplicationV2) {
  static #instance = null;
  #busy = null;
  #closed = false;
  #renderQueue = Promise.resolve();

  constructor(options = {}, dependencies = {}) {
    super(options);
    this.service = dependencies.service ?? (() => import("../prompts/file-cleanup-service.mjs"));
    this.copy = dependencies.copy ?? (path => navigator.clipboard.writeText(path));
  }

  static DEFAULT_OPTIONS = {
    id: "drawing-prompts-orphan-files",
    classes: ["drawing-prompts", "drawing-prompts-orphan-files", "standard-form"],
    window: { title: `${PREFIX}title`, icon: "fa-solid fa-file-circle-exclamation", resizable: true },
    position: { width: 780, height: 560 },
    actions: { refresh: OrphanFiles.#onRefresh, retry: OrphanFiles.#onRetry, copyPath: OrphanFiles.#onCopy }
  };

  static PARTS = { body: { template: "modules/drawing-prompts/templates/orphan-files.hbs" } };

  static async open(dependencies = {}) {
    assertGM();
    const app = this.#instance ??= new this({}, dependencies);
    await app.#paint();
    app.bringToFront();
    void app.refresh().catch(error => ui.notifications?.error(error.message));
    return app;
  }

  static refreshOpen() { return this.#instance?.#paint(); }

  #paint() {
    this.#renderQueue = this.#renderQueue.catch(() => {}).then(() => {
      if ( !this.#closed ) return this.render({ force: true, parts: ["body"] });
    });
    return this.#renderQueue;
  }

  _onClose(options) {
    this.#closed = true;
    if ( OrphanFiles.#instance === this ) OrphanFiles.#instance = null;
    return super._onClose(options);
  }

  async _prepareContext() {
    assertGM();
    const service = await this.service();
    const files = service.getOrphanFiles();
    const scans = service.getPendingCleanupScans?.() ?? [];
    const rows = files.map(record => ({
      id: record.id,
      path: record.path,
      filename: record.path.split(/[\\/]/).at(-1),
      promptName: record.promptName || game.i18n.localize(`${PREFIX}unknown`),
      playerName: record.playerName || game.i18n.localize(`${PREFIX}unknown`),
      account: record.account || game.i18n.localize(`${PREFIX}localAccount`),
      folder: record.folder,
      orphanedDate: displayDate(record.orphanedAt),
      status: game.i18n.localize(`${PREFIX}status.${record.status}`),
      error: localizedReason(record),
      isFolder: false
    }));
    rows.push(...scans.map(scan => ({
      id: scan.id,
      path: scan.folder,
      filename: game.i18n.localize(`${PREFIX}folderCheck`),
      promptName: scan.promptName || game.i18n.localize(`${PREFIX}unknown`),
      playerName: scan.playerName || game.i18n.localize(`${PREFIX}unknown`),
      account: scan.account || game.i18n.localize(`${PREFIX}${scan.source === "data" ? "localAccount" : "unknown"}`),
      folder: scan.folder,
      status: game.i18n.localize(`${PREFIX}status.folderCheck`),
      error: game.i18n.localize(`${PREFIX}reason.folderCheck`),
      isFolder: true
    })));
    return { rows, hasRows: rows.length > 0, busy: Boolean(this.#busy), count: rows.length };
  }

  async refresh({ retry = false } = {}) {
    assertGM();
    // A retry requested during verification runs afterwards rather than being dropped.
    if ( this.#busy ) {
      await this.#busy;
      if ( retry && !this.#closed ) return this.refresh({ retry: true });
      return;
    }
    if ( this.#closed ) return;
    this.#busy = (async () => {
      const service = await this.service();
      if ( retry ) await service.reconcileFileCleanup({ retry: true, manual: true });
      else await service.refreshOrphanFiles();
    })();
    // Rendering may take longer than a rejected provider request; handle it immediately.
    this.#busy.catch(() => {});
    try { await this.#paint(); await this.#busy; }
    finally { this.#busy = null; await this.#paint(); }
  }

  static async #onRefresh() { await this.refresh(); }
  static async #onRetry() { await this.refresh({ retry: true }); }
  static async #onCopy(_event, target) {
    assertGM();
    const service = await this.service();
    const folder = target.dataset.recordKind === "folder";
    const records = folder ? service.getPendingCleanupScans?.() ?? [] : service.getOrphanFiles();
    const record = records.find(row => row.id === target.dataset.fileId);
    if ( record ) await this.copy(folder ? record.folder : record.path);
  }
}
