/**
 * Serialize asynchronous timer mutations independently for each prompt.
 */
export class TimerUpdateQueue {
  #pending = new Map();

  /**
   * Run an update after earlier updates for the same prompt settle.
   * @template T
   * @param {string} promptId Prompt id.
   * @param {() => Promise<T>|T} update Update transaction.
   * @returns {Promise<T>}
   */
  enqueue(promptId, update) {
    const previous = this.#pending.get(promptId) ?? Promise.resolve();
    const operation = previous.catch(() => undefined).then(() => update());
    this.#pending.set(promptId, operation);
    return operation.finally(() => {
      if ( this.#pending.get(promptId) === operation ) this.#pending.delete(promptId);
    });
  }

  /** @returns {number} Number of prompt queues awaiting completion. */
  get size() {
    return this.#pending.size;
  }
}
