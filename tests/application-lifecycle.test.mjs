import assert from "node:assert/strict";
import { afterEach, test } from "node:test";

const applications = [];
let failNextRender = false;
let nextRenderGate = null;
let liveFixedIdCount = 0;
let maxLiveFixedIdCount = 0;

class ApplicationV2 {
  constructor(options = {}) {
    this.options = options;
    this.closeCalls = 0;
    this.renderCalls = 0;
    this.closeGate = null;
    applications.push(this);
  }

  async render() {
    this.renderCalls += 1;
    this.hasLiveElement = true;
    liveFixedIdCount += 1;
    maxLiveFixedIdCount = Math.max(maxLiveFixedIdCount, liveFixedIdCount);
    const renderGate = nextRenderGate;
    nextRenderGate = null;
    if ( renderGate ) await renderGate;
    if ( failNextRender ) {
      failNextRender = false;
      throw new Error("render failed");
    }
    return this;
  }

  async close(options) {
    this.closeCalls += 1;
    if ( this.closeGate ) await this.closeGate;
    if ( this.hasLiveElement ) {
      this.hasLiveElement = false;
      liveFixedIdCount -= 1;
    }
    this._onClose(options);
  }

  bringToFront() {}
  async _onRender() {}
  _onClose() {}
}

globalThis.foundry = {
  applications: {
    api: {
      ApplicationV2,
      HandlebarsApplicationMixin: Base => Base
    }
  }
};
globalThis.game = {
  actors: [],
  i18n: { localize: key => key },
  settings: { get: () => "" },
  user: { isGM: true }
};
globalThis.FormData = class {
  constructor(form) {
    this.form = form;
  }

  get(name) {
    return name === "mode" ? this.form.mode : null;
  }
};

const { PlaceDialog } = await import("../scripts/apps/place-dialog.mjs");
const { CloneSourceSettings } = await import("../scripts/apps/clone-source-settings.mjs");

function assignment(id) {
  return {
    id,
    primaryImagePath: `${id}.webp`,
    savedSubmissionTs: 2,
    status: "submitted",
    submittedAt: 1
  };
}

function deferred() {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
}

function listenerTarget() {
  const listeners = new Map();
  return {
    listeners,
    addEventListener(type, handler) {
      const handlers = listeners.get(type) ?? [];
      handlers.push(handler);
      listeners.set(type, handlers);
    }
  };
}

function placeForm() {
  const form = listenerTarget();
  const copySearch = listenerTarget();
  const existingSearch = listenerTarget();
  const selectors = new Map([
    ['[name="copyActorSearch"]', copySearch],
    ['select[name="copyActorUuid"]', { options: [] }],
    ['[name="existingActorSearch"]', existingSearch],
    ['select[name="existingActorUuid"]', { options: [] }],
    ["input[name='name']", { disabled: false }]
  ]);
  form.mode = "tile";
  form.matches = selector => selector === "form";
  form.querySelector = selector => selectors.get(selector) ?? null;
  form.querySelectorAll = () => [];
  return {
    form,
    copySearch,
    existingSearch,
    replaceActorControls(nextCopySearch, nextExistingSearch) {
      selectors.set('[name="copyActorSearch"]', nextCopySearch);
      selectors.set('select[name="copyActorUuid"]', { options: [] });
      selectors.set('[name="existingActorSearch"]', nextExistingSearch);
      selectors.set('select[name="existingActorUuid"]', { options: [] });
    }
  };
}

afterEach(async () => {
  failNextRender = false;
  nextRenderGate = null;
  for ( const app of applications.toReversed() ) {
    app.closeGate = null;
    await app.close().catch(() => {});
  }
  applications.length = 0;
  liveFixedIdCount = 0;
  maxLiveFixedIdCount = 0;
});

test("PlaceDialog serializes concurrent close, render, and publish transactions", async () => {
  const first = await PlaceDialog.open(assignment("first"));
  const closeGate = deferred();
  const renderGate = deferred();
  first.closeGate = closeGate.promise;
  nextRenderGate = renderGate.promise;
  maxLiveFixedIdCount = liveFixedIdCount;
  const applicationCount = applications.filter(app => app instanceof PlaceDialog).length;

  const openingSecond = PlaceDialog.open(assignment("second"));
  const openingThird = PlaceDialog.open(assignment("third"));
  try {
    await Promise.resolve();

    const closeCallsWhileBlocked = first.closeCalls;
    const applicationCountWhileBlocked = applications.filter(app => app instanceof PlaceDialog).length;

    closeGate.resolve();
    await new Promise(resolve => setImmediate(resolve));
    const applicationCountDuringPendingRender = applications.filter(app => app instanceof PlaceDialog).length;

    renderGate.resolve();
    const [second] = await Promise.all([openingSecond, openingThird]);
    assert.equal(closeCallsWhileBlocked, 1);
    assert.equal(applicationCountWhileBlocked, applicationCount);
    assert.equal(applicationCountDuringPendingRender, applicationCount + 1,
      "the third application must not be constructed while the second render is pending");
    assert.equal(second.closeCalls, 1);
    assert.equal(maxLiveFixedIdCount, 1, "the fixed application id must never exist twice");
    assert.equal(liveFixedIdCount, 1);
  } finally {
    closeGate.resolve();
    renderGate.resolve();
    await Promise.allSettled([openingSecond, openingThird]);
  }
});

test("PlaceDialog clears its live reference by identity and never retains a failed render", async () => {
  const first = await PlaceDialog.open(assignment("identity-first"));
  const second = await PlaceDialog.open(assignment("identity-second"));

  await first.close();
  const third = await PlaceDialog.open(assignment("identity-third"));
  assert.equal(second.closeCalls, 1, "a stale close must not clear the newer live instance");

  failNextRender = true;
  await assert.rejects(PlaceDialog.open(assignment("failed")), /render failed/);
  const failed = applications.at(-1);
  assert.equal(failed.closeCalls, 1, "a failed render must be closed to remove partial DOM");
  assert.equal(liveFixedIdCount, 0);
  const next = await PlaceDialog.open(assignment("after-failure"));
  assert.equal(failed.closeCalls, 1, "a failed render must not remain queued as the live instance");
  await next.close();
  assert.equal(third.closeCalls, 1);
});

test("repeated renders attach application listeners only once per instance", async () => {
  const place = new PlaceDialog(assignment("listeners"));
  const { form, copySearch, existingSearch, replaceActorControls } = placeForm();
  place.element = form;

  await place._onRender({}, {});
  await place._onRender({}, {});

  assert.equal(form.listeners.get("change")?.length, 1);
  assert.equal(copySearch.listeners.get("input")?.length, 1);
  assert.equal(existingSearch.listeners.get("input")?.length, 1);

  const replacementCopySearch = listenerTarget();
  const replacementExistingSearch = listenerTarget();
  replaceActorControls(replacementCopySearch, replacementExistingSearch);
  await place._onRender({}, {});
  await place._onRender({}, {});

  assert.equal(form.listeners.get("change")?.length, 1);
  assert.equal(replacementCopySearch.listeners.get("input")?.length, 1);
  assert.equal(replacementExistingSearch.listeners.get("input")?.length, 1);

  const replacementRoot = placeForm();
  place.element = replacementRoot.form;
  await place._onRender({}, {});
  await place._onRender({}, {});

  assert.equal(form.listeners.get("change")?.length, 1);
  assert.equal(replacementRoot.form.listeners.get("change")?.length, 1);
  assert.equal(replacementRoot.copySearch.listeners.get("input")?.length, 1);
  assert.equal(replacementRoot.existingSearch.listeners.get("input")?.length, 1);

  const cloneSearch = listenerTarget();
  const clone = new CloneSourceSettings();
  let cloneControls = { search: cloneSearch, select: { options: [] } };
  clone.element = {
    querySelector: selector => selector === '[name="cloneSourceSearch"]'
      ? cloneControls.search
      : selector === 'select[name="actorUuid"]' ? cloneControls.select : null
  };

  await clone._onRender({}, {});
  await clone._onRender({}, {});

  assert.equal(cloneSearch.listeners.get("input")?.length, 1);

  const replacementCloneSearch = listenerTarget();
  cloneControls = { search: replacementCloneSearch, select: { options: [] } };
  await clone._onRender({}, {});
  await clone._onRender({}, {});

  assert.equal(replacementCloneSearch.listeners.get("input")?.length, 1);
});
