/**
 * Player-local drawing operation log with undo/redo pointer semantics.
 */
export class OperationLog {
  #ops = [];
  #pointer = 0;

  /**
   * Append an operation and discard any redo tail.
   * @param {object} op Drawing operation.
   * @returns {number} New active pointer.
   */
  append(op) {
    if ( this.#pointer < this.#ops.length ) this.#ops.splice(this.#pointer);
    this.#ops.push(op);
    this.#pointer = this.#ops.length;
    return this.#pointer;
  }

  /**
   * Move one operation into the redo tail.
   * @returns {number|null} New pointer, or null when no undo is available.
   */
  undo() {
    if ( this.#pointer <= 0 ) return null;
    this.#pointer -= 1;
    return this.#pointer;
  }

  /**
   * Restore one operation from the redo tail.
   * @returns {number|null} New pointer, or null when no redo is available.
   */
  redo() {
    if ( this.#pointer >= this.#ops.length ) return null;
    this.#pointer += 1;
    return this.#pointer;
  }

  /**
   * Active operations up to the current pointer.
   * @returns {object[]}
   */
  get activeOps() {
    return this.#ops.slice(0, this.#pointer);
  }

  /**
   * All stored operations, including redo tail.
   * @returns {object[]}
   */
  get ops() {
    return this.#ops.slice();
  }

  /**
   * Current active pointer.
   * @returns {number}
   */
  get pointer() {
    return this.#pointer;
  }

  /**
   * Whether redo operations exist.
   * @returns {boolean}
   */
  get canRedo() {
    return this.#pointer < this.#ops.length;
  }

  /**
   * JSON-serializable representation.
   * @returns {{ops: object[], pointer: number}}
   */
  toJSON() {
    return {
      ops: this.#ops.map(op => cloneJson(op)),
      pointer: this.#pointer
    };
  }
}

/**
 * Clone a plain JSON-compatible value.
 * @param {*} value Value.
 * @returns {*}
 */
function cloneJson(value) {
  return JSON.parse(JSON.stringify(value));
}
