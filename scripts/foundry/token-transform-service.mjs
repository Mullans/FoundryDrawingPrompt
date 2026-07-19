import { FLAG_ORIGINAL_TEXTURE, MODULE_ID } from "../constants.mjs";
import { isSaveGateOpen } from "../prompts/transitions.mjs";

/**
 * Decide whether applying a transform requires multi-target confirmation.
 * @param {number} targetCount Number of controlled token targets.
 * @returns {boolean} Whether confirmation is required.
 */
export function isTransformConfirmationNeeded(targetCount) {
  return Number(targetCount) > 1;
}

/**
 * Plan which controlled tokens need their current texture persisted as the true original.
 * @param {{token: object, currentTexture: string, originalTexture: unknown}[]} tokens Token transform inputs.
 * @returns {{token: object, originalTexture: unknown, shouldStoreOriginal: boolean}[]} Transform plan.
 */
export function buildTokenTransformPlan(tokens) {
  return Array.from(tokens ?? [], entry => {
    const shouldStoreOriginal = entry.originalTexture === undefined;
    return {
      token: entry.token,
      originalTexture: shouldStoreOriginal ? entry.currentTexture : entry.originalTexture,
      shouldStoreOriginal
    };
  });
}

/**
 * Apply a saved assignment drawing to all currently controlled tokens.
 * @param {import("../prompts/prompt-models.mjs").DrawingAssignment} assignment Saved assignment.
 * @returns {Promise<object[]>} Token placeables that received the drawing.
 */
export async function applyTransformToControlledTokens(assignment) {
  assertGM();
  if ( !assignment?.primaryImagePath || !isSaveGateOpen(assignment) ) {
    throw new Error(game.i18n.localize("DRAWING-PROMPTS.transform.saveFirst"));
  }

  const targets = Array.from(globalThis.canvas?.tokens?.controlled ?? []);
  if ( !targets.length ) {
    ui.notifications.warn(game.i18n.localize("DRAWING-PROMPTS.transform.noTargets"));
    return [];
  }

  if ( isTransformConfirmationNeeded(targets.length) ) {
    const { DialogV2 } = foundry.applications.api;
    const confirmed = await DialogV2.confirm({
      window: { title: "DRAWING-PROMPTS.transform.confirm.title", icon: "fa-solid fa-paintbrush" },
      content: game.i18n.format("DRAWING-PROMPTS.transform.confirm.content", { count: targets.length }),
      yes: { label: "DRAWING-PROMPTS.transform.confirm.yes", icon: "fa-solid fa-paintbrush" },
      rejectClose: false,
      modal: true
    });
    if ( !confirmed ) return [];
  }

  const plan = buildTokenTransformPlan(targets.map(token => ({
    token,
    currentTexture: token.document.texture?.src,
    originalTexture: token.document.getFlag(MODULE_ID, FLAG_ORIGINAL_TEXTURE)
  })));
  for ( const item of plan ) {
    if ( item.shouldStoreOriginal ) {
      await item.token.document.setFlag(MODULE_ID, FLAG_ORIGINAL_TEXTURE, item.originalTexture);
    }
    await item.token.document.update({ "texture.src": assignment.primaryImagePath });
  }
  return targets;
}

/**
 * Restore one token's original texture and clear its persisted transform flag.
 * @param {object} tokenDocument TokenDocument to restore.
 * @returns {Promise<boolean>} Whether a stored transform was reverted.
 */
export async function revertTokenTransform(tokenDocument) {
  assertGM();
  const originalTexture = tokenDocument?.getFlag(MODULE_ID, FLAG_ORIGINAL_TEXTURE);
  if ( originalTexture === undefined ) return false;
  await tokenDocument.update({ "texture.src": originalTexture });
  await tokenDocument.unsetFlag(MODULE_ID, FLAG_ORIGINAL_TEXTURE);
  return true;
}

/**
 * Add a revert control to a transformed token's HUD for GM users.
 * @param {object} hud TokenHUD application.
 * @param {HTMLElement} html Rendered TokenHUD element.
 * @returns {void}
 */
export function renderTokenTransformHUD(hud, html) {
  if ( !globalThis.game?.user?.isGM ) return;
  const tokenDocument = hud?.document ?? hud?.object?.document;
  if ( tokenDocument?.getFlag(MODULE_ID, FLAG_ORIGINAL_TEXTURE) === undefined ) return;
  const column = html?.querySelector?.(".col.left");
  if ( !column || column.querySelector(".dp-token-transform-revert") ) return;

  const button = html.ownerDocument.createElement("button");
  button.type = "button";
  button.className = "control-icon dp-token-transform-revert";
  button.dataset.tooltip = "";
  button.setAttribute("aria-label", game.i18n.localize("DRAWING-PROMPTS.transform.revertTooltip"));
  button.innerHTML = '<i class="fa-solid fa-rotate-left" inert></i>';
  button.addEventListener("click", async event => {
    event.preventDefault();
    event.stopPropagation();
    button.disabled = true;
    try {
      if ( await revertTokenTransform(tokenDocument) ) button.remove();
    } catch (err) {
      console.error(`${MODULE_ID} | failed to revert token transform`, err);
      ui.notifications.warn(err.message);
      button.disabled = false;
    }
  });
  column.append(button);
}

/**
 * Throw a localized GM-only error when the current user is not a GM.
 * @returns {void}
 */
function assertGM() {
  if ( !globalThis.game?.user?.isGM ) {
    throw new Error(game.i18n.localize("DRAWING-PROMPTS.errors.gmOnly"));
  }
}
