/**
 * Thin GM timer bridge — queue, persist, and broadcast timer transitions.
 * Pure timer math lives in {@link ./timer-service.mjs}.
 */

import { loadPrompt, savePrompt } from "./persistence-service.mjs";
import { assertPromptOwner } from "./prompt-context.mjs";
import { assertGM } from "./socket-auth.mjs";
import { adjustTimer, pauseTimer, resetTimer, resumeTimer, stopTimer } from "./timer-service.mjs";
import { TimerUpdateQueue } from "./timer-update-queue.mjs";
import { refreshManager } from "./ui-bridge.mjs";
import { emit } from "../socket.mjs";

const timerUpdateQueue = new TimerUpdateQueue();

/**
 * Pause a prompt timer at its current value, including overtime.
 * @param {string} promptId Prompt id.
 * @returns {Promise<import("./prompt-models.mjs").DrawingPrompt>}
 */
export function pausePromptTimer(promptId) {
  return updatePromptTimer(promptId, (state, prompt, now) => pauseTimer(state, now));
}

/**
 * Resume a paused prompt timer without counting paused time.
 * @param {string} promptId Prompt id.
 * @returns {Promise<import("./prompt-models.mjs").DrawingPrompt>}
 */
export function resumePromptTimer(promptId) {
  return updatePromptTimer(promptId, (state, prompt, now) => resumeTimer(state, now));
}

/**
 * Shift a prompt's running deadline or paused remaining time.
 * @param {string} promptId Prompt id.
 * @param {number} deltaMs Signed adjustment in milliseconds.
 * @returns {Promise<import("./prompt-models.mjs").DrawingPrompt>}
 */
export function adjustPromptTimer(promptId, deltaMs) {
  return updatePromptTimer(promptId, (state, prompt, now) => adjustTimer(state, deltaMs, now));
}

/**
 * Restart a prompt timer from its original configured duration.
 * @param {string} promptId Prompt id.
 * @returns {Promise<import("./prompt-models.mjs").DrawingPrompt>}
 */
export function resetPromptTimer(promptId) {
  return updatePromptTimer(promptId, (state, prompt, now) => resetTimer(state, prompt.timerSeconds, now));
}

/**
 * Stop a prompt timer and make the prompt untimed.
 * @param {string} promptId Prompt id.
 * @returns {Promise<import("./prompt-models.mjs").DrawingPrompt>}
 */
export function stopPromptTimer(promptId) {
  return updatePromptTimer(promptId, state => stopTimer(state));
}

/**
 * Apply, persist, and deliver one GM-owned timer transition.
 * @param {string} promptId Prompt id.
 * @param {Function} transition Pure timer transition.
 * @returns {Promise<import("./prompt-models.mjs").DrawingPrompt>}
 */
function updatePromptTimer(promptId, transition) {
  return timerUpdateQueue.enqueue(promptId, async () => {
    assertGM();
    const prompt = loadPrompt(promptId);
    if ( !prompt ) throw new Error(game.i18n.localize("DRAWING-PROMPTS.errors.promptNotFound"));
    assertPromptOwner(prompt);
    prompt.timerState = transition(prompt.timerState, prompt, Date.now());
    await savePrompt(prompt, { timerOnly: true });
    Hooks.callAll("drawing-prompts.timerUpdated", prompt, prompt.timerState);
    await broadcastTimerState(prompt);
    await refreshManager();
    return prompt;
  });
}

/**
 * Deliver the current timer state to every online assigned player.
 * @param {import("./prompt-models.mjs").DrawingPrompt} prompt Prompt.
 * @returns {Promise<void>}
 */
async function broadcastTimerState(prompt) {
  const deliveries = Object.values(prompt.assignments)
    .filter(assignment => game.users.get(assignment.userId)?.active)
    .map(assignment => emit.timerUpdated(assignment.userId, assignment.id, prompt.timerState));
  const results = await Promise.allSettled(deliveries);
  for ( const result of results ) {
    if ( result.status === "rejected" ) console.warn("drawing-prompts | timer update delivery failed", result.reason);
  }
}
