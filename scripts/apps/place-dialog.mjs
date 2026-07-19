import { MODULE_ID, SETTINGS } from "../constants.mjs";
import { PLACE_MODES, validatePlaceSelection } from "../foundry/token-placement-service.mjs";
import { isSaveGateOpen } from "../prompts/transitions.mjs";

const { ApplicationV2, HandlebarsApplicationMixin } = foundry.applications.api;

/**
 * GM placement window for one saved drawing assignment.
 */
export class PlaceDialog extends HandlebarsApplicationMixin(ApplicationV2) {
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
   * @returns {Promise<PlaceDialog>}
   */
  static async open(assignment) {
    if ( !game.user.isGM ) throw new Error(game.i18n.localize("DRAWING-PROMPTS.errors.gmOnly"));
    if ( !assignment?.primaryImagePath || !isSaveGateOpen(assignment) ) {
      throw new Error(game.i18n.localize("DRAWING-PROMPTS.errors.saveBeforePlace"));
    }
    const app = new this(assignment);
    await app.render({ force: true });
    app.bringToFront();
    return app;
  }

  /**
   * @param {import("../prompts/prompt-models.mjs").DrawingAssignment} assignment Assignment to place.
   * @param {object} [options] Application options.
   */
  constructor(assignment, options = {}) {
    super(options);
    this.assignment = assignment;
  }

  /** @type {boolean} Whether a placement commit is in flight. */
  #placing = false;

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
    form?.addEventListener("change", event => {
      if ( event.target?.name === "mode" ) this.#syncModeState();
    });
    attachActorFilter(form, "copyActorSearch", "copyActorUuid");
    attachActorFilter(form, "existingActorSearch", "existingActorUuid");
    this.#syncModeState();
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
      if ( mode === PLACE_MODES.TILE ) {
        await service.placeAssignmentAsTile(this.assignment.id, { hidden, name });
      } else {
        await service.placeAssignmentAsToken(this.assignment.id, { mode, name, actorUuid, hidden });
      }
      await this.close();
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

/**
 * Build sorted world Actor options.
 * @param {string} selectedUuid Selected Actor UUID.
 * @returns {Array<{uuid: string, name: string, selected: boolean}>}
 */
function worldActorOptions(selectedUuid) {
  return Array.from(game.actors ?? [])
    .sort((a, b) => String(a.name).localeCompare(String(b.name)))
    .map(actor => ({ uuid: actor.uuid, name: actor.name, selected: actor.uuid === selectedUuid }));
}

/**
 * Attach a simple text filter to an Actor select.
 * @param {HTMLElement} root Application root.
 * @param {string} searchName Search input name.
 * @param {string} selectName Select name.
 * @returns {void}
 */
function attachActorFilter(root, searchName, selectName) {
  const search = root?.querySelector(`[name="${searchName}"]`);
  const select = root?.querySelector(`select[name="${selectName}"]`);
  search?.addEventListener("input", () => {
    const query = String(search.value || "").trim().toLocaleLowerCase();
    for ( const option of select?.options ?? [] ) {
      if ( !option.value ) continue;
      option.hidden = Boolean(query) && !option.text.toLocaleLowerCase().includes(query);
    }
  });
}
