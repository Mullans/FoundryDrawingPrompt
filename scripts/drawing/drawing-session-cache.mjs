/** Player-local retained editing sessions, bounded by pixel-history bytes. */
export class DrawingSessionCache {
  #budgetBytes;
  #now;
  #sessions = new Map();

  constructor({ budgetBytes = 128 * 1024 * 1024, now = () => Date.now() } = {}) {
    this.#budgetBytes = positiveInteger(budgetBytes);
    this.#now = now;
  }

  take(identity) {
    const key = identityKey(identity);
    const session = this.#sessions.get(key) ?? null;
    if ( session ) this.#sessions.delete(key);
    return session?.engine ?? null;
  }

  retain(identity, engine) {
    if ( !engine ) throw new Error("A drawing engine is required");
    const key = identityKey(identity);
    const replaced = this.#sessions.get(key);
    if ( replaced?.engine !== engine ) replaced?.engine?.destroy?.();
    this.#sessions.set(key, { engine, lastUsed: this.#now() });
    this.#evict();
  }

  invalidate(identity) {
    const key = identityKey(identity);
    const session = this.#sessions.get(key);
    session?.engine?.destroy?.();
    this.#sessions.delete(key);
  }

  get size() { return this.#sessions.size; }
  get bytes() {
    return [...this.#sessions.values()].reduce((sum, item) => sum + engineBytes(item.engine), 0);
  }

  #evict() {
    let bytes = this.bytes;
    const oldest = [...this.#sessions.entries()].sort((left, right) => left[1].lastUsed - right[1].lastUsed);
    for ( const [key, session] of oldest ) {
      if ( bytes <= this.#budgetBytes ) break;
      this.#sessions.delete(key);
      bytes -= engineBytes(session.engine);
      session.engine.destroy?.();
    }
  }
}

export function drawingSessionIdentity(identity) {
  return {
    worldId: requiredText(identity?.worldId),
    gmUserId: requiredText(identity?.gmUserId),
    userId: requiredText(identity?.userId),
    promptId: requiredText(identity?.promptId),
    assignmentId: requiredText(identity?.assignmentId),
    width: positiveInteger(identity?.width),
    height: positiveInteger(identity?.height)
  };
}

function identityKey(identity) {
  const value = drawingSessionIdentity(identity);
  return [value.worldId, value.gmUserId, value.userId, value.promptId, value.assignmentId, value.width, value.height].join("\u001f");
}

function engineBytes(engine) {
  const bytes = Number(engine?.recoveryBytes);
  return Number.isFinite(bytes) && bytes > 0 ? bytes : 0;
}

function requiredText(value) {
  if ( typeof value !== "string" || !value || /\s/.test(value) ) throw new Error("Invalid drawing session identity");
  return value;
}

function positiveInteger(value) {
  const number = Number(value);
  if ( !Number.isSafeInteger(number) || number <= 0 ) throw new Error("Invalid drawing session value");
  return number;
}
