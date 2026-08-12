import { FRAMING_VIEW, MODULE_ID, SETTINGS } from "../constants.mjs";
import { attachActorFilter, worldActorOptions } from "../foundry/actor-picker.mjs";
import { PLACE_MODES, validatePlaceSelection } from "../foundry/token-placement-service.mjs";
import { isSaveGateOpen } from "../prompts/transitions.mjs";

const { ApplicationV2, HandlebarsApplicationMixin } = foundry.applications.api;

/**
 * GM placement window for one saved drawing assignment.
 */
export class PlaceDialog extends HandlebarsApplicationMixin(ApplicationV2) {
  /** @type {PlaceDialog|null} The currently live placement window. */
  static #instance = null;

  /** @type {Promise<void>} Serializes fixed-id application replacement transactions. */
  static #openQueue = Promise.resolve();

  static DEFAULT_OPTIONS = {
    id: "drawing-prompts-place-dialog",
    classes: ["drawing-prompts", "drawing-prompts-place-dialog", "standard-form"],
    tag: "form",
    window: {
      title: "DRAWING-PROMPTS.placeDialog.title",
      icon: "fa-solid fa-map-pin",
      resizable: false,
      positioned: true
    },
    position: { width: 560, height: "auto" },
    actions: {
      place: PlaceDialog.#onPlace,
      placeHidden: PlaceDialog.#onPlaceHidden,
      cancel: PlaceDialog.#onCancel
    }
  };

  static PARTS = {
    body: {
      template: "modules/drawing-prompts/templates/place-dialog.hbs"
    }
  };

  /**
   * Open a placement window for an assignment.
   * @param {import("../prompts/prompt-models.mjs").DrawingAssignment} assignment Assignment to place.
   * @param {{framingView?: string, imagePath?: string|null}} [options] Framing View / resolved asset path.
   * @returns {Promise<PlaceDialog>}
   */
  static async open(assignment, { framingView = FRAMING_VIEW.PROMPT_CANVAS, imagePath = null } = {}) {
    if ( !game.user.isGM ) throw new Error(game.i18n.localize("DRAWING-PROMPTS.errors.gmOnly"));
    const src = imagePath || assignment?.primaryImagePath;
    if ( !src || !isSaveGateOpen(assignment) ) {
      throw new Error(game.i18n.localize("DRAWING-PROMPTS.errors.saveBeforePlace"));
    }
    const transaction = PlaceDialog.#openQueue.then(async () => {
      if ( PlaceDialog.#instance ) await PlaceDialog.#instance.close();
      const app = new this(assignment, { framingView, imagePath: src });
      PlaceDialog.#instance = app;
      try {
        await app.render({ force: true });
        app.bringToFront();
        return app;
      } catch (err) {
        try {
          await app.close();
        } catch (_closeError) {
          // Best effort: preserve the render failure while still clearing our live reference.
        }
        if ( PlaceDialog.#instance === app ) PlaceDialog.#instance = null;
        throw err;
      }
    });
    PlaceDialog.#openQueue = transaction.then(() => undefined, () => undefined);
    return transaction;
  }

  /**
   * @param {import("../prompts/prompt-models.mjs").DrawingAssignment} assignment Assignment to place.
   * @param {object} [options] Application options.
   * @param {string} [options.framingView] Framing View for the placed raster.
   * @param {string|null} [options.imagePath] Resolved saved asset path for that view.
   */
  constructor(assignment, options = {}) {
    const { framingView, imagePath, ...appOptions } = options;
    super(appOptions);
    this.assignment = assignment;
    this.framingView = framingView || FRAMING_VIEW.PROMPT_CANVAS;
    this.imagePath = imagePath || assignment?.primaryImagePath || null;
  }

  /** @type {boolean} Whether a placement commit is in flight. */
  #placing = false;

  /** @type {WeakSet<HTMLElement>} Form roots which already have the mode change listener. */
  #formListenerRoots = new WeakSet();

  /** @type {WeakSet<HTMLElement>} Search inputs which already have actor filters attached. */
  #actorFilterInputs = new WeakSet();

  /** @override */
  async _prepareContext(options) {
    const defaultCopyUuid = String(game.settings.get(MODULE_ID, SETTINGS.DEFAULT_CLONE_SOURCE_ACTOR_UUID) || "");
    return {
      name: this.assignment.assets?.name || "",
      copyActors: worldActorOptions(defaultCopyUuid),
      existingActors: worldActorOptions("")
    };
  }

  /** @override */
  async _onRender(context, options) {
    await super._onRender(context, options);
    const form = this.#formElement();
    if ( form && !this.#formListenerRoots.has(form) ) {
      form.addEventListener("change", event => {
        if ( event.target?.name === "mode" ) this.#syncModeState();
      });
      this.#formListenerRoots.add(form);
    }
    this.#attachActorFilter(form, "copyActorSearch", "copyActorUuid");
    this.#attachActorFilter(form, "existingActorSearch", "existingActorUuid");
    this.#syncModeState();
  }

  /** @override */
  _onClose(options) {
    super._onClose(options);
    if ( PlaceDialog.#instance === this ) PlaceDialog.#instance = null;
  }

  /**
   * Attach an actor filter once to the current rendered search input.
   * @param {HTMLElement|null} root Application form root.
   * @param {string} searchName Search input name.
   * @param {string} selectName Actor select name.
   * @returns {void}
   */
  #attachActorFilter(root, searchName, selectName) {
    const search = root?.querySelector(`[name="${searchName}"]`);
    if ( !search || this.#actorFilterInputs.has(search) ) return;
    attachActorFilter(root, searchName, selectName);
    this.#actorFilterInputs.add(search);
  }

  /** @this {PlaceDialog} */
  static async #onPlace() {
    await this.#commit(false);
  }

  /** @this {PlaceDialog} */
  static async #onPlaceHidden() {
    await this.#commit(true);
  }

  /** @this {PlaceDialog} */
  static async #onCancel() {
    await this.close();
  }

  /**
   * Place the assignment in the selected mode.
   * @param {boolean} hidden Whether the created document is hidden.
   * @returns {Promise<void>}
   */
  async #commit(hidden) {
    if ( this.#placing ) return;
    const form = this.#formElement();
    if ( !form ) return;
    const mode = String(new FormData(form).get("mode") || "");
    const name = String(form.querySelector("input[name='name']")?.value || "").trim();
    const actorUuid = mode === PLACE_MODES.COPY_ACTOR
      ? String(form.querySelector("select[name='copyActorUuid']")?.value || "")
      : mode === PLACE_MODES.EXISTING_ACTOR
        ? String(form.querySelector("select[name='existingActorUuid']")?.value || "")
        : "";
    const validationError = validatePlaceSelection({ mode, name, actorUuid });
    if ( validationError ) {
      ui.notifications.warn(game.i18n.localize(`DRAWING-PROMPTS.placeDialog.validation.${validationError}`));
      return;
    }

    this.#placing = true;
    this.#setPlacementActionsDisabled(true);
    try {
      const service = await import("../prompts/prompt-service.mjs");
      const { DrawingPromptManager } = await import("./drawing-prompt-manager.mjs");
      const framingView = this.framingView;
      const modeSnapshot = mode;
      const nameSnapshot = name;
      const actorUuidSnapshot = actorUuid;
      const hiddenSnapshot = hidden;
      await this.close();
      await DrawingPromptManager.withCanvasYield(async () => {
        if ( modeSnapshot === PLACE_MODES.TILE ) {
          await service.placeAssignmentAsTile(this.assignment.id, {
            hidden: hiddenSnapshot,
            name: nameSnapshot,
            framingView,
            interactive: true
          });
        } else {
          await service.placeAssignmentAsToken(this.assignment.id, {
            mode: modeSnapshot,
            name: nameSnapshot,
            actorUuid: actorUuidSnapshot,
            hidden: hiddenSnapshot,
            framingView,
            interactive: true
          });
        }
      });
    } catch (err) {
      ui.notifications.warn(err.message);
      this.#placing = false;
      this.#setPlacementActionsDisabled(false);
    }
  }

  /**
   * Toggle the placement commit buttons.
   * @param {boolean} disabled Whether placement actions are disabled.
   * @returns {void}
   */
  #setPlacementActionsDisabled(disabled) {
    for ( const button of this.#formElement()?.querySelectorAll("[data-action='place'], [data-action='placeHidden']") ?? [] ) {
      button.disabled = disabled;
    }
  }

  /**
   * Enable only the selected mode's controls and disable Name for Existing Actor.
   * @returns {void}
   */
  #syncModeState() {
    const form = this.#formElement();
    const mode = String(new FormData(form).get("mode") || PLACE_MODES.TILE);
    for ( const card of form.querySelectorAll("[data-dp-place-mode]") ) {
      const selected = card.dataset.dpPlaceMode === mode;
      card.classList.toggle("is-selected", selected);
      card.classList.toggle("is-disabled", !selected);
      for ( const control of card.querySelectorAll("input:not([type='radio']), select") ) control.disabled = !selected;
    }
    const name = form.querySelector("input[name='name']");
    if ( name ) name.disabled = mode === PLACE_MODES.EXISTING_ACTOR;
  }

  /**
   * Resolve the application form element.
   * @returns {HTMLFormElement|null}
   */
  #formElement() {
    if ( this.element?.matches?.("form") ) return this.element;
    return this.element?.querySelector?.("form") ?? null;
  }
}
