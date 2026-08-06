import { BG_SOURCE, FIT_MODE, STATUS } from "../constants.mjs";
import { assertBackgroundUnlocked } from "./framed-delivery.mjs";
import { normalizeTimerState } from "./timer-service.mjs";

const TERMINAL_STATUSES = new Set([STATUS.SUBMITTED, STATUS.REJECTED, STATUS.CANCELLED]);

/**
 * Serializable per-player drawing assignment state.
 */
export class DrawingAssignment {
  /**
   * @param {object} data Serialized assignment data.
   */
  constructor(data = {}) {
    this.id = data.id ?? null;
    this.promptId = data.promptId ?? null;
    this.userId = data.userId ?? null;
    this.userName = data.userName ?? "";
    this.status = data.status ?? STATUS.PENDING;
    this.openedAt = data.openedAt ?? null;
    this.submittedAt = data.submittedAt ?? null;
    this.rejectedAt = data.rejectedAt ?? null;
    this.cancelledAt = data.cancelledAt ?? null;
    this.late = Boolean(data.late);
    this.overtimeMs = data.overtimeMs ?? null;
    this.reopenedCount = Number(data.reopenedCount ?? 0);
    this.savedSubmissionTs = data.savedSubmissionTs ?? null;
    this.assets = {
      name: data.assets?.name ?? null,
      overlayPath: data.assets?.overlayPath ?? null,
      mergedPath: data.assets?.mergedPath ?? null,
      fullPath: data.assets?.fullPath ?? null,
      oplogPath: data.assets?.oplogPath ?? null,
      thumbPath: data.assets?.thumbPath ?? null,
      folder: data.assets?.folder ?? null,
      tileWidth: data.assets?.tileWidth ?? null,
      tileHeight: data.assets?.tileHeight ?? null
    };
    // Legacy saved assignments predate savedSubmissionTs; infer it from their persisted image.
    if ( this.status === STATUS.SUBMITTED && this.primaryImagePath && this.savedSubmissionTs == null ) {
      this.savedSubmissionTs = this.submittedAt;
    }
    this.placements = Array.isArray(data.placements) ? data.placements.map(placement => ({
      kind: placement?.kind ?? (placement?.tokenId ? "token" : "tile"),
      tileId: placement?.tileId ?? null,
      tokenId: placement?.tokenId ?? null,
      actorId: placement?.actorId ?? null,
      sceneId: placement?.sceneId ?? null,
      hidden: Boolean(placement?.hidden),
      placedAt: placement?.placedAt ?? null
    })) : [];
    this.pendingSubmission = data.pendingSubmission ?? null;
  }

  /**
   * Create a new pending assignment.
   * @param {object} data Assignment identity.
   * @param {string} data.promptId Parent prompt id.
   * @param {string} data.userId Assigned user id.
   * @param {string} data.userName Assigned user's display name.
   * @returns {DrawingAssignment}
   */
  static create({ promptId, userId, userName }) {
    return new this({
      id: foundry.utils.randomID(),
      promptId,
      userId,
      userName,
      status: STATUS.PENDING
    });
  }

  /**
   * Hydrate an assignment from plain data.
   * @param {object} obj Serialized assignment data.
   * @returns {DrawingAssignment}
   */
  static fromObject(obj = {}) {
    return new this(obj);
  }

  /**
   * Convert this assignment to JSON-serializable data.
   * @returns {object}
   */
  toObject() {
    return {
      id: this.id,
      promptId: this.promptId,
      userId: this.userId,
      userName: this.userName,
      status: this.status,
      openedAt: this.openedAt,
      submittedAt: this.submittedAt,
      rejectedAt: this.rejectedAt,
      cancelledAt: this.cancelledAt,
      late: this.late,
      overtimeMs: this.overtimeMs,
      reopenedCount: this.reopenedCount,
      savedSubmissionTs: this.savedSubmissionTs,
      assets: { ...this.assets },
      placements: this.placements.map(placement => ({ ...placement })),
      pendingSubmission: this.pendingSubmission ? JSON.parse(JSON.stringify(this.pendingSubmission)) : null
    };
  }

  /**
   * Mark the assignment as opened.
   * @param {number} ts Epoch milliseconds.
   * @returns {void}
   */
  markOpened(ts) {
    this.#assertStatus([STATUS.PENDING, STATUS.OPENED], STATUS.OPENED);
    this.status = STATUS.OPENED;
    this.openedAt ??= ts;
  }

  /**
   * Mark the assignment as submitted.
   * @param {object} data Submission timing.
   * @param {number} data.ts Epoch milliseconds.
   * @param {boolean} data.late Whether the submission was late.
   * @param {number|null} data.overtimeMs Overtime in milliseconds.
   * @returns {void}
   */
  markSubmitted({ ts, late, overtimeMs }) {
    this.#assertStatus([STATUS.OPENED], STATUS.SUBMITTED);
    this.status = STATUS.SUBMITTED;
    this.submittedAt = ts;
    this.late = Boolean(late);
    this.overtimeMs = overtimeMs ?? null;
  }

  /**
   * Mark the assignment as rejected.
   * @param {number} ts Epoch milliseconds.
   * @returns {void}
   */
  markRejected(ts) {
    this.#assertStatus([STATUS.PENDING, STATUS.OPENED], STATUS.REJECTED);
    this.status = STATUS.REJECTED;
    this.rejectedAt = ts;
  }

  /**
   * Mark the assignment as cancelled.
   * @param {number} ts Epoch milliseconds.
   * @returns {void}
   */
  markCancelled(ts) {
    if ( this.status === STATUS.CANCELLED ) return;
    if ( TERMINAL_STATUSES.has(this.status) ) throw new Error(`Illegal transition from ${this.status} to ${STATUS.CANCELLED}`);
    this.status = STATUS.CANCELLED;
    this.cancelledAt = ts;
  }

  /**
   * Reopen a submitted or rejected assignment.
   * @returns {void}
   */
  markReopened() {
    this.#assertStatus([STATUS.SUBMITTED, STATUS.REJECTED], STATUS.OPENED);
    this.status = STATUS.OPENED;
    this.reopenedCount += 1;
  }

  /**
   * Resend a cancelled assignment.
   * @returns {void}
   */
  markResent() {
    this.#assertStatus([STATUS.CANCELLED], STATUS.PENDING);
    this.status = STATUS.PENDING;
  }

  /**
   * Whether this assignment can still be acted on by the player.
   * @returns {boolean}
   */
  get isActive() {
    return [STATUS.PENDING, STATUS.OPENED].includes(this.status);
  }

  /**
   * Best image to show or place for this assignment.
   * @returns {string|null}
   */
  get primaryImagePath() {
    return this.assets.mergedPath ?? this.assets.overlayPath ?? null;
  }

  /**
   * Whether the assignment was submitted but its drawing has not been saved.
   * @returns {boolean}
   */
  get isSubmittedUnsaved() {
    return this.status === STATUS.SUBMITTED && !this.primaryImagePath;
  }

  /**
   * Test whether the assignment has passed its prompt deadline.
   * @param {number|null} deadlineAt Epoch milliseconds, or null for no deadline.
   * @param {number} now Current epoch milliseconds.
   * @returns {boolean}
   */
  isExpired(deadlineAt, now) {
    return this.isActive && Number.isFinite(deadlineAt) && now > deadlineAt;
  }

  /**
   * Assert a lifecycle transition is allowed.
   * @param {string[]} allowed Source statuses.
   * @param {string} target Target status.
   * @returns {void}
   */
  #assertStatus(allowed, target) {
    if ( !allowed.includes(this.status) ) throw new Error(`Illegal transition from ${this.status} to ${target}`);
  }
}

/**
 * Serializable drawing prompt state containing per-user assignments.
 */
export class DrawingPrompt {
  /**
   * @param {object} data Serialized prompt data.
   */
  constructor(data = {}) {
    this.id = data.id ?? null;
    this.gmUserId = data.gmUserId ?? globalThis.game?.user?.id ?? null;
    this.promptText = data.promptText ?? "";
    this.drawingName = data.drawingName ?? "";
    this.assetFolderName = data.assetFolderName ?? null;
    this.canvasWidth = Number(data.canvasWidth ?? 1024);
    this.canvasHeight = Number(data.canvasHeight ?? 768);
    this.background = {
      sourceType: data.background?.sourceType ?? BG_SOURCE.BLANK,
      path: data.background?.path ?? null,
      fitMode: data.background?.fitMode ?? FIT_MODE.FIT_WIDTH,
      naturalWidth: data.background?.naturalWidth ?? null,
      naturalHeight: data.background?.naturalHeight ?? null,
      framing: normalizeStoredFraming(data.background?.framing),
      framedPath: data.background?.framedPath ?? null
    };
    this.timerSeconds = data.timerSeconds ?? null;
    this.createdAt = data.createdAt ?? Date.now();
    this.sentAt = data.sentAt ?? null;
    this.timerState = data;
    this.assignments = {};

    for ( const [id, assignment] of Object.entries(data.assignments ?? {}) ) {
      const hydrated = assignment instanceof DrawingAssignment ? assignment : DrawingAssignment.fromObject(assignment);
      this.assignments[hydrated.id ?? id] = hydrated;
    }
  }

  /**
   * Create a new prompt and assignments for selected users.
   * @param {object} data Prompt data.
   * @param {string[]} userIds Target user ids.
   * @returns {DrawingPrompt}
   */
  static create(data = {}, userIds = []) {
    const prompt = new this({
      ...data,
      id: data.id ?? null,
      gmUserId: data.gmUserId ?? game.user.id,
      createdAt: data.createdAt ?? Date.now(),
      assignments: {}
    });

    for ( const userId of userIds ) {
      const user = game.users.get(userId);
      const assignment = DrawingAssignment.create({
        promptId: prompt.id,
        userId,
        userName: user?.name ?? userId
      });
      prompt.assignments[assignment.id] = assignment;
    }

    return prompt;
  }

  /**
   * Hydrate a prompt from plain data.
   * @param {object} obj Serialized prompt data.
   * @returns {DrawingPrompt}
   */
  static fromObject(obj = {}) {
    return new this(obj);
  }

  /**
   * Convert this prompt to JSON-serializable data.
   * @returns {object}
   */
  toObject() {
    return {
      id: this.id,
      gmUserId: this.gmUserId,
      promptText: this.promptText,
      drawingName: this.drawingName,
      assetFolderName: this.assetFolderName,
      canvasWidth: this.canvasWidth,
      canvasHeight: this.canvasHeight,
      background: { ...this.background },
      timerSeconds: this.timerSeconds,
      createdAt: this.createdAt,
      sentAt: this.sentAt,
      timerStatus: this.timerStatus,
      deadlineAt: this.deadlineAt,
      remainingMs: this.remainingMs,
      assignments: Object.fromEntries(Object.entries(this.assignments).map(([id, assignment]) => [id, assignment.toObject()]))
    };
  }

  /**
   * Canonical timer state for transitions and wire payloads.
   * @returns {{timerStatus: "none"|"running"|"paused", deadlineAt: number|null, remainingMs: number|null}}
   */
  get timerState() {
    return {
      timerStatus: this.timerStatus,
      deadlineAt: this.deadlineAt,
      remainingMs: this.remainingMs
    };
  }

  /**
   * Replace the canonical timer state.
   * @param {object} state Timer state.
   */
  set timerState(state) {
    const timer = normalizeTimerState(state);
    this.timerStatus = timer.timerStatus;
    this.deadlineAt = timer.deadlineAt;
    this.remainingMs = timer.remainingMs;
  }

  /**
   * Whether Prompt Framing and Fit mode are locked after first send.
   * @returns {boolean}
   */
  get isBackgroundLocked() {
    return this.sentAt != null;
  }

  /**
   * Apply background changes, rejecting locked Prompt Framing and Fit mode edits.
   * @param {object} changes Partial background update.
   * @returns {void}
   */
  applyBackgroundUpdate(changes = {}) {
    assertBackgroundUnlocked(changes, this.background, this);
    Object.assign(this.background, changes);
  }

  /**
   * Whether any assignment is still active.
   * @returns {boolean}
   */
  get isActive() {
    return Object.values(this.assignments).some(assignment => assignment.isActive);
  }

  /**
   * Whether the prompt still needs GM attention: players are drawing, or a
   * submitted drawing has not been saved yet.
   * @returns {boolean}
   */
  get needsAttention() {
    return this.isActive || Object.values(this.assignments).some(assignment => assignment.isSubmittedUnsaved);
  }

  /**
   * Find an assignment by id.
   * @param {string} assignmentId Assignment id.
   * @returns {DrawingAssignment|null}
   */
  getAssignment(assignmentId) {
    return this.assignments[assignmentId] ?? null;
  }

  /**
   * Find the assignment addressed to a user.
   * @param {string} userId User id.
   * @returns {DrawingAssignment|null}
   */
  assignmentForUser(userId) {
    return Object.values(this.assignments).find(assignment => assignment.userId === userId) ?? null;
  }
}

/**
 * @param {{x?: number, y?: number, width?: number, height?: number}|null|undefined} framing
 * @returns {{x: number, y: number, width: number, height: number}|null}
 */
function normalizeStoredFraming(framing) {
  if ( framing == null ) return null;
  if ( typeof framing !== "object" ) return null;
  return {
    x: Number(framing.x) || 0,
    y: Number(framing.y) || 0,
    width: Number(framing.width) || 0,
    height: Number(framing.height) || 0
  };
}
