import { MODULE_ID } from "../constants.mjs";
import { emit } from "../socket.mjs";
import { cleanupFileIdentity, browseCleanupFolder, deleteCleanupFile } from "../foundry/file-cleanup-provider.mjs";
import { loadAllPrompts, loadPrompt, getPromptIdForAssignment } from "./persistence-service.mjs";
import { assertGmInitiator } from "./socket-auth.mjs";

const SETTING = "fileCleanupRegistry";
const FALLBACK = new Set(["unsupported", "unavailable", "denied", "unconfirmed", "unableToVerify", "failed"]);
let queue = Promise.resolve();
let cleanupQueue = Promise.resolve();
let refreshRun = null;
let scheduledCleanup = null;
let settlementDirty = false;
const sessionId = globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random()}`;
const activeAttempts = new Set();
const activeLeases = new Set();
const clone = value => JSON.parse(JSON.stringify(value));
const id = () => globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random()}`;
const users = () => Array.from(game.users?.values?.() ?? game.users ?? []);
const activeGM = () => game.users?.activeGM ?? users().filter(user => user.isGM && user.active).sort((a, b) => a.id.localeCompare(b.id))[0];
const isWriter = () => game.user?.isGM && activeGM()?.id === game.user.id;

function registry() {
  const value = game.settings.get(MODULE_ID, SETTING);
  if ( value == null ) return { version: 1, records: [], exports: [], pendingScans: [], readLeases: [] };
  if ( value.version !== 1 || !Array.isArray(value.records) || !Array.isArray(value.exports) ) throw new Error("Unsupported or damaged file cleanup registry");
  const state = clone(value);
  state.pendingScans ??= [];
  state.readLeases ??= [];
  return state;
}

async function persist(state) {
  if ( !isWriter() ) throw new Error("Active GM changed; retry file cleanup");
  await game.settings.set(MODULE_ID, SETTING, state);
}

function serialize(task) {
  const run = queue.then(task);
  queue = run.catch(() => {});
  return run;
}

function scheduleSettledCleanup() {
  settlementDirty = true;
  if ( scheduledCleanup ) return;
  scheduledCleanup = new Promise(resolve => {
    setTimeout(async () => {
      settlementDirty = false;
      try { if ( isWriter() ) await reconcileFileCleanup(); }
      catch (_error) { /* Persisted records remain recoverable after writer changes. */ }
      finally {
        scheduledCleanup = null;
        resolve();
        if ( settlementDirty ) scheduleSettledCleanup();
      }
    }, 0);
  });
}

/** Allows lifecycle fixtures to drain background work before replacing globals. */
export async function waitForFileCleanupIdle() {
  do {
    if ( scheduledCleanup ) await scheduledCleanup;
    await cleanupQueue;
    await queue;
  } while ( scheduledCleanup );
}

function cycleBudget(explicitRetry) {
  const deadline = explicitRetry ? Infinity : Date.now() + 10000;
  let remaining = explicitRetry ? Infinity : 10;
  const attempted = new Set();
  return {
    attempted: key => attempted.has(key),
    take(key = null) {
      if ( remaining <= 0 || Date.now() >= deadline ) return false;
      remaining--;
      if ( key ) attempted.add(key);
      return true;
    }
  };
}

/** socketlib can leave requests pending when a connected client has no handler. */
export async function requestCleanupClient(userId, payload, timeoutMs = 5000) {
  return withTimeout(emit.cleanupFile(userId, payload), timeoutMs);
}

async function withTimeout(request, timeoutMs = 5000) {
  let timer;
  try {
    return await Promise.race([
      request,
      new Promise((_resolve, reject) => { timer = setTimeout(() => reject(new Error("Cleanup client timed out")), timeoutMs); })
    ]);
  } finally { clearTimeout(timer); }
}

async function operation(payload) {
  if ( isWriter() ) return handleCleanupOperation(game.user.id, payload);
  if ( !activeGM() || typeof emit.cleanupOperation !== "function" ) throw new Error("No active GM can persist file tracking");
  return withTimeout(emit.cleanupOperation(payload));
}

function strings(value, result = new Set()) {
  if ( typeof value === "string" ) {
    // Cache-busting references protect the underlying file; upload/delete inputs
    // still use the strict identity parser and never accept query or fragments.
    const identity = cleanupFileIdentity(value.split(/[?#]/, 1)[0]);
    if ( identity ) result.add(identity.path);
  }
  else if ( value && typeof value === "object" ) for ( const child of Object.values(value) ) strings(child, result);
  return result;
}

/** Broad document reference collection intentionally errs toward preservation. */
function protectedPaths(state) {
  const paths = new Set(state.exports);
  // Preserve even malformed/legacy references that model hydration may drop.
  for ( const entry of game.journal ) strings(entry.getFlag(MODULE_ID, "prompt"), paths);
  for ( const prompt of loadAllPrompts() ) {
    strings(prompt.background, paths);
    strings(prompt.bg, paths);
    for ( const assignment of Object.values(prompt.assignments ?? {}) ) {
      strings(assignment.assets, paths);
      strings(assignment.pendingSubmission, paths);
      strings(assignment.retainedCapture, paths);
    }
  }
  for ( const document of [...Array.from(game.scenes ?? []), ...Array.from(game.actors ?? [])] ) {
    // Includes inactive Scenes, prototype Tokens and namespaced Revert flags.
    strings(document.toObject?.() ?? document, paths);
  }
  return paths;
}

function protectedRecord(record, state, paths) {
  return paths.has(record.path) || state.exports.includes(record.path) || (record.leases?.length > 0)
    || (state.readLeases ?? []).some(lease => lease.paths.includes(record.path))
    || ["uploading", "ready"].includes(record.state)
    || (record.purpose === "recovered" && loadPrompt(record.promptId)?.lifecycleStatus === "open");
}

async function context(assignmentId, initiatorId) {
  const prompt = loadPrompt(getPromptIdForAssignment(assignmentId));
  const assignment = Object.values(prompt?.assignments ?? {}).find(item => item.id === assignmentId);
  const user = users().find(item => item.id === initiatorId);
  if ( !prompt || !assignment || !user || (user.isGM ? prompt.gmUserId !== user.id : assignment.userId !== user.id) ) throw new Error("Unauthorized file upload registration");
  if ( !user.isGM && (prompt.lifecycleStatus !== "open" || assignment.status !== "opened") ) throw new Error("Assignment is not open for uploads");
  const { submissionValidationContext } = await import("./pending-submission.mjs");
  return { prompt, assignment, validation: submissionValidationContext(assignmentId) };
}

async function allowed(record, path) {
  const identity = cleanupFileIdentity(path);
  if ( !identity ) return false;
  const { isAllowedStagedPath, isAllowedPendingPath } = await import("./wire-validation.mjs");
  // Stored roots remain authoritative after configured folders change.
  const options = { forge: identity.source === "forgevtt", expectedKind: record.kind };
  return isAllowedStagedPath(record.assignmentId, path, record.stagingRoot, options)
    || isAllowedPendingPath(record.assignmentId, path, record.pendingRoot, options);
}

function row(record) {
  const identity = cleanupFileIdentity(record.path);
  return { ...record, account: identity?.account ?? "", folder: identity?.folder ?? "", filename: record.path.split("/").at(-1) };
}

/** Only unresolved eligible records are exposed to the fallback UI. */
export function getOrphanFiles() {
  if ( !game.user?.isGM ) return [];
  const state = registry();
  let paths;
  try { paths = protectedPaths(state); } catch (_error) { return []; }
  return state.records.filter(record => FALLBACK.has(record.status) && !protectedRecord(record, state, paths)).map(row);
}

export async function beginInternalUpload(data) {
  const identity = cleanupFileIdentity(data.expectedPath);
  if ( globalThis.ForgeVTT?.usingTheForge && identity?.source === "data" ) {
    const account = await globalThis.ForgeAPI?.getUserId?.();
    if ( !account || !/^[A-Za-z0-9_-]+$/.test(String(account)) ) throw new Error("Forge upload account unavailable");
    data = { ...data, expectedPath: `https://assets.forge-vtt.com/${account}/${identity.relativePath.split("/").map(encodeURIComponent).join("/")}` };
  }
  activeAttempts.add(data.attemptId);
  try { return await operation({ type: "begin", ...data, sessionId }); }
  catch (error) { activeAttempts.delete(data.attemptId); throw error; }
}
export async function completeInternalUpload(reservationId, data) { return operation({ type: "complete", reservationId, ...data }); }
export async function settleInternalUploads(pathsOrAttemptIds) {
  const values = Array.isArray(pathsOrAttemptIds) ? pathsOrAttemptIds : [pathsOrAttemptIds];
  const attempts = registry().records.filter(record => values.includes(record.path) || values.includes(record.attemptId)).map(record => record.attemptId);
  const result = await operation({ type: "settle", values });
  for ( const value of [...values, ...attempts] ) activeAttempts.delete(value);
  return result;
}
export async function protectExportedFiles(paths) { return operation({ type: "export", paths }); }
export async function preparePromptCleanup(prompt) { return operation({ type: "prepare", promptId: prompt.id }); }
export async function reconcileFileCleanup(options = {}) { return operation({ type: "reconcile", ...options }); }

/** Durable read leases avoid deleting source artwork while Save is copying it. */
export async function withFileCleanupProtection(paths, task) {
  const leaseId = id();
  activeLeases.add(leaseId);
  try {
    await operation({ type: "lease", paths: [...new Set(paths.filter(Boolean))], leaseId, sessionId });
    return await task();
  }
  finally { activeLeases.delete(leaseId); await operation({ type: "release", leaseId }); }
}

export async function refreshOrphanFiles() {
  if ( refreshRun ) return refreshRun;
  refreshRun = operation({ type: "refresh" }).finally(() => { refreshRun = null; });
  return refreshRun;
}

/** All world writes execute on the elected GM and authenticate the caller. */
export async function handleCleanupOperation(initiatorId, payload) {
  if ( !isWriter() ) throw new Error("Only the active GM may mutate file cleanup tracking");
  if ( !payload || typeof payload !== "object" ) throw new Error("Invalid cleanup operation");
  if ( ["reconcile", "refresh"].includes(payload.type) ) {
    assertGmInitiator(initiatorId, users());
    const job = cleanupQueue.then(() => runCleanupCycle(payload));
    cleanupQueue = job.catch(() => {});
    return job;
  }
  return serialize(async () => {
    const state = registry();
    const user = users().find(item => item.id === initiatorId);
    if ( !user ) throw new Error("Unknown cleanup initiator");
    if ( payload.type === "begin" ) {
      if ( !["overlay", "merged"].includes(payload.kind) || !/^[A-Za-z0-9_-]{1,64}$/.test(payload.attemptId ?? "") ) throw new Error("Invalid upload identity");
      const duplicate = state.records.find(item => item.assignmentId === payload.assignmentId && item.attemptId === payload.attemptId && item.kind === payload.kind);
      if ( duplicate ) {
        if ( duplicate.sourceUserId !== initiatorId || duplicate.path !== cleanupFileIdentity(payload.expectedPath)?.path ) throw new Error("Upload replay identity changed");
        return duplicate.id;
      }
      const { prompt, assignment, validation } = await context(payload.assignmentId, initiatorId);
      const record = {
        id: id(), assignmentId: assignment.id, promptId: prompt.id, promptName: prompt.promptName || prompt.promptText || "",
        playerName: assignment.userName, sourceUserId: initiatorId, attemptId: payload.attemptId, kind: payload.kind,
        purpose: ["staging", "retained-capture", "pending-submission", "pending", "capture", "submission"].includes(payload.purpose)
          ? payload.purpose : "submission", path: payload.expectedPath,
        stagingRoot: validation.stagingRoot, pendingRoot: validation.pendingRoot,
        createdAt: Date.now(), state: "uploading", status: "pending", revision: 1, leases: [], sessionId: payload.sessionId ?? null
      };
      if ( !await allowed(record, record.path) ) throw new Error("Upload path outside its Assignment");
      if ( !cleanupFileIdentity(record.path).relativePath.endsWith(`-upload-${record.attemptId}.${record.path.endsWith(".png") ? "png" : "webp"}`) ) throw new Error("Upload filename does not match its unique attempt");
      // An uploader cannot reserve a saved artwork path, even if its name matches.
      if ( protectedPaths(state).has(record.path) ) throw new Error("Upload would overwrite protected artwork");
      state.records.push(record);
      await persist(state);
      return record.id;
    }
    if ( payload.type === "complete" ) {
      const record = state.records.find(item => item.id === payload.reservationId);
      if ( !record || record.sourceUserId !== initiatorId ) throw new Error("Upload reservation belongs to another user");
      if ( payload.path ) {
        if ( !await allowed(record, payload.path) ) throw new Error("Returned file path outside its Assignment");
        const actual = cleanupFileIdentity(payload.path), expected = cleanupFileIdentity(record.path);
        if ( actual.relativePath !== expected.relativePath || actual.source !== expected.source || actual.account !== expected.account ) throw new Error("Returned upload path differs from its reservation");
        if ( ["ready", "settled"].includes(record.state) ) return record.id;
        record.path = actual.path;
        record.state = "ready";
      } else {
        if ( record.state === "settled" ) return record.id;
        record.state = "settled";
      }
      record.revision++;
      await persist(state);
      return record.id;
    }
    if ( payload.type === "settle" ) {
      const values = new Set(payload.values ?? []);
      let changed = false;
      for ( const record of state.records ) {
        if ( !values.has(record.path) && !values.has(record.attemptId) ) continue;
        if ( !user.isGM && record.sourceUserId !== initiatorId ) throw new Error("Cannot settle another user's upload");
        if ( record.state === "settled" ) continue;
        // Successful completion remains leased until adoption or explicit failure.
        record.state = "settled";
        record.revision++;
        changed = true;
      }
      if ( changed ) { await persist(state); scheduleSettledCleanup(); }
      return true;
    }
    assertGmInitiator(initiatorId, users());
    if ( payload.type === "export" ) {
      const paths = [...new Set([...state.exports, ...strings(payload.paths ?? [])])];
      if ( paths.length !== state.exports.length ) { state.exports = paths; await persist(state); }
      return true;
    }
    if ( payload.type === "lease" || payload.type === "release" ) {
      let changed = false;
      if ( payload.type === "lease" ) {
        // A legacy source may be discovered while Save is running. Its durable
        // path lease must exist even before there is a file registry record.
        const paths = [...strings(payload.paths ?? [])];
        if ( state.records.some(record => paths.includes(record.path) && record.deletionPending) ) throw new Error("File deletion is in progress or unconfirmed");
        if ( !state.readLeases.some(lease => lease.id === payload.leaseId) ) {
          state.readLeases.push({ id: payload.leaseId, userId: initiatorId, sessionId: payload.sessionId, paths });
          changed = true;
        }
      } else {
        const remaining = state.readLeases.filter(lease => lease.id !== payload.leaseId || lease.userId !== initiatorId);
        if ( remaining.length !== state.readLeases.length ) { state.readLeases = remaining; changed = true; }
      }
      for ( const record of state.records ) {
        if ( payload.type === "lease" && payload.paths?.includes(record.path) ) {
          if ( record.deletionPending ) throw new Error("File deletion is in progress or unconfirmed");
          record.leases ??= [];
          if ( !record.leases.some(item => item.id === payload.leaseId) ) {
            record.leases.push({ id: payload.leaseId, userId: initiatorId, sessionId: payload.sessionId });
            record.revision++;
            changed = true;
          }
        }
        if ( payload.type === "release" ) {
          const remaining = (record.leases ?? []).filter(item => item.id !== payload.leaseId || item.userId !== initiatorId);
          if ( remaining.length !== (record.leases ?? []).length ) { record.leases = remaining; record.revision++; changed = true; }
        }
      }
      if ( changed ) await persist(state);
      return true;
    }
    if ( payload.type === "prepare" ) {
      const prompt = loadPrompt(payload.promptId);
      if ( !prompt || prompt.gmUserId !== initiatorId ) throw new Error("Prompt belongs to another GM");
      await discoverPrompt(prompt, state, new Map(), { defer: true });
      // Existing in-flight reservations remain protected until explicitly settled.
      await persist(state);
      return true;
    }
    throw new Error("Unknown file cleanup operation");
  });
}

async function runCleanupCycle(payload) {
  if ( !isWriter() ) throw new Error("Active GM changed before cleanup started");
  if ( payload.type === "refresh" ) await verifyCandidates();
  else {
    const budget = cycleBudget(payload.manual === true);
    if ( payload.scan ) {
      // Registry writes are short; slow folder checks never hold the writer queue.
      const additions = registry();
      for ( const prompt of loadAllPrompts() ) await discoverPrompt(prompt, additions, new Map(), { defer: true });
      await mergeDiscoveries(additions);
    }
    // Known, unattempted candidates take precedence over maintenance requests.
    await cleanCandidates(payload, budget);
    if ( payload.scan ) await recoverSessions(registry(), budget);
    await retryDiscovery(registry(), payload, budget);
    await cleanCandidates(payload, budget);
  }
  return getOrphanFiles();
}

async function mergeDiscoveries(additions) {
  await serialize(async () => {
    const state = registry();
    state.exports = [...new Set([...state.exports, ...additions.exports])];
    for ( const record of additions.records ) if ( !state.records.some(item => item.path === record.path) ) state.records.push(record);
    for ( const scan of additions.pendingScans ?? [] ) if ( !state.pendingScans.some(item => item.assignmentId === scan.assignmentId && item.folder === scan.folder && item.sourceUserId === scan.sourceUserId) ) state.pendingScans.push(scan);
    if ( JSON.stringify(state) !== JSON.stringify(registry()) ) await persist(state);
  });
}

async function discoverPrompt(prompt, state, browsed = new Map(), { defer = false } = {}) {
  const { submissionValidationContext, getPendingSubmission } = await import("./pending-submission.mjs");
  const { browseFiles } = await import("./asset-service.mjs");
  for ( const assignment of Object.values(prompt.assignments ?? {}) ) {
    state.exports = [...new Set([...state.exports, ...strings(assignment.assets)])];
    const validation = submissionValidationContext(assignment.id);
    const references = new Set([...strings(assignment.pendingSubmission), ...strings(assignment.retainedCapture), ...strings(getPendingSubmission(assignment.id))]);
    const roots = new Set([validation.stagingRoot, validation.pendingRoot]);
    for ( const path of references ) {
      const identity = cleanupFileIdentity(path);
      if ( identity?.folder && await allowed({ assignmentId: assignment.id, ...validationForFolder(identity.folder, assignment.id, validation) }, path) ) roots.add(identity.folder);
    }
    for ( const record of state.records.filter(item => item.assignmentId === assignment.id) ) {
      const identity = cleanupFileIdentity(record.path);
      if ( identity ) roots.add(identity.folder);
    }
    for ( const root of roots ) {
      const originalValidation = validationForFolder(root, assignment.id, validation);
      const sourceUserId = root.includes("/pending/") ? prompt.gmUserId : assignment.userId;
      if ( !browsed.has(root) ) {
        // A successful empty listing in the GM's own library says nothing about
        // a player's identically named staging directory.
        try { browsed.set(root, defer || (globalThis.ForgeVTT?.usingTheForge && sourceUserId !== game.user.id)
          ? null : await withTimeout(browseFiles(root, { strict: true }))); }
        catch (_error) { browsed.set(root, null); }
      }
      if ( browsed.get(root) === null ) {
        state.pendingScans ??= [];
        if ( !state.pendingScans.some(scan => scan.assignmentId === assignment.id && scan.folder === root && scan.sourceUserId === sourceUserId) ) state.pendingScans.push({
          id: id(), revision: 1, assignmentId: assignment.id, promptId: prompt.id, promptName: prompt.promptName || prompt.promptText || "",
          playerName: assignment.userName, sourceUserId, folder: root, source: globalThis.ForgeVTT?.usingTheForge ? "forgevtt" : "data",
          stagingRoot: originalValidation.stagingRoot, pendingRoot: originalValidation.pendingRoot
        });
      }
      for ( const path of browsed.get(root) ?? [] ) references.add(path);
    }
    for ( const path of references ) {
      if ( state.exports.includes(path) || state.records.some(record => record.path === path) ) continue;
      for ( const kind of ["overlay", "merged"] ) {
        const pathValidation = validationForFolder(cleanupFileIdentity(path)?.folder ?? "", assignment.id, validation);
        const record = {
          id: id(), assignmentId: assignment.id, promptId: prompt.id, promptName: prompt.promptName || prompt.promptText || "",
          playerName: assignment.userName, sourceUserId: path.includes("/pending/") ? prompt.gmUserId : assignment.userId,
          kind, path, stagingRoot: pathValidation.stagingRoot, pendingRoot: pathValidation.pendingRoot,
          purpose: "recovered", state: "settled", status: "pending", revision: 1, createdAt: Date.now(), leases: []
        };
        if ( await allowed(record, path) ) { state.records.push(record); break; }
      }
    }
  }
}

function validationForFolder(folder, assignmentId, fallback) {
  const identity = cleanupFileIdentity(`${folder}/discovery.webp`);
  const relative = identity?.relativePath.slice(0, identity.relativePath.lastIndexOf("/"));
  if ( relative?.endsWith("/staging") || relative === "staging" ) return { ...fallback, stagingRoot: relative };
  if ( relative?.endsWith(`/pending/${assignmentId}`) || relative === `pending/${assignmentId}` ) return { ...fallback, pendingRoot: relative };
  return fallback;
}

async function retryDiscovery(state, { userId = null, retry = false, scan: startup = false } = {}, budget = cycleBudget(true)) {
  for ( const scan of [...(state.pendingScans ?? [])].sort((a, b) => (a.lastAttemptAt ?? 0) - (b.lastAttemptAt ?? 0)) ) {
    if ( userId && scan.sourceUserId !== userId ) continue;
    if ( scan.lastAttemptAt && !retry && !startup && !userId ) continue;
    const target = scan.source === "data" ? game.user : users().find(user => user.id === scan.sourceUserId && user.active);
    if ( !target ) continue;
    if ( !budget.take() ) break;
    let result;
    const payload = { action: "discover", scanId: scan.id, revision: scan.revision, targetUserId: target.id };
    try {
      result = target.id === game.user.id ? await withTimeout(handleCleanupFileRequest(game.user.id, payload)) : await requestCleanupClient(target.id, payload);
    } catch (_error) {
      await serialize(async () => {
        const latest = registry();
        const current = latest.pendingScans.find(item => item.id === scan.id);
        if ( current?.revision === scan.revision ) { current.lastAttemptAt = Date.now(); current.revision++; await persist(latest); }
      });
      continue;
    }
    if ( !Array.isArray(result?.files) ) continue;
    await serialize(async () => {
    const latest = registry();
    const current = latest.pendingScans.find(item => item.id === scan.id);
    if ( current?.revision !== scan.revision ) return;
    for ( const path of result.files ) {
      if ( latest.exports.includes(path) || latest.records.some(record => record.path === path) ) continue;
      for ( const kind of ["overlay", "merged"] ) {
        const record = { ...scan, id: id(), kind, path, purpose: "recovered", state: "settled", status: "pending", revision: 1, createdAt: Date.now(), leases: [] };
        if ( await allowed(record, path) ) { latest.records.push(record); break; }
      }
    }
    latest.pendingScans = latest.pendingScans.filter(item => item.id !== scan.id);
    await persist(latest);
    });
  }
}

async function recoverSessions(state, budget = cycleBudget(true)) {
  const byUser = new Map();
  const ownerIds = new Set([...state.records.flatMap(record => [record.sourceUserId, ...(record.leases ?? []).map(lease => lease.userId)]), ...(state.readLeases ?? []).map(lease => lease.userId)]);
  for ( const userId of ownerIds ) {
    const user = users().find(item => item.id === userId);
    if ( !user?.active ) { byUser.set(userId, { inactive: true }); continue; }
    if ( userId !== game.user.id && !budget.take() ) continue;
    try {
      const payload = { action: "sessions", targetUserId: userId };
      const result = userId === game.user.id ? await handleCleanupFileRequest(game.user.id, payload) : await requestCleanupClient(userId, payload);
      if ( typeof result?.sessionId === "string" && Array.isArray(result.attempts) && Array.isArray(result.leases) ) byUser.set(userId, result);
    } catch (_error) { /* A disconnected/unverifiable client remains protected. */ }
  }
  await serialize(async () => {
  const latest = registry();
  const before = JSON.stringify(latest);
  const observedLeaseIds = new Set((state.readLeases ?? []).map(lease => lease.id));
  latest.readLeases = latest.readLeases.filter(lease => {
    if ( !observedLeaseIds.has(lease.id) ) return true;
    const client = byUser.get(lease.userId);
    // Offline clients and a replacement browser cannot attest that an old HTTP
    // request finished. Only the issuing session can release an absent lease.
    return !client || client.inactive || client.sessionId !== lease.sessionId || client.leases.includes(lease.id);
  });
  const protectedFiles = protectedPaths(latest);
  for ( const record of latest.records ) {
    if ( state.records.find(item => item.id === record.id)?.revision !== record.revision ) continue;
    const prior = JSON.stringify(record);
    const owner = byUser.get(record.sourceUserId);
    // A completed upload cannot be adopted into a deleted Prompt, but a pending
    // upload may finish after disconnect and must never be inferred absent.
    const completedWithoutPrompt = record.state === "ready" && !loadPrompt(record.promptId)
      && !protectedFiles.has(record.path) && !(record.leases?.length)
      && !latest.readLeases.some(lease => lease.paths.includes(record.path));
    if ( ["uploading", "ready"].includes(record.state) && owner
      && record.sessionId && owner.sessionId === record.sessionId && !owner.attempts.includes(record.attemptId) ) record.state = "settled";
    if ( completedWithoutPrompt ) record.state = "settled";
    record.leases = (record.leases ?? []).filter(lease => {
      const client = byUser.get(lease.userId);
      return !client || client.inactive || client.sessionId !== lease.sessionId || client.leases.includes(lease.id);
    });
    if ( JSON.stringify(record) !== prior ) record.revision++;
  }
  if ( JSON.stringify(latest) !== before ) await persist(latest);
  });
}

function clientFor(record) {
  const identity = cleanupFileIdentity(record.path);
  if ( identity?.source === "data" ) return game.user.id;
  return users().find(user => user.id === record.sourceUserId && user.active)?.id ?? null;
}

async function request(record, action) {
  const clientId = clientFor(record);
  if ( !clientId ) return { status: "unavailable", error: "File-owning client is offline" };
  const payload = { recordId: record.id, revision: record.revision, action, targetUserId: clientId };
  if ( clientId === game.user.id ) {
    try { return await withTimeout(handleCleanupFileRequest(game.user.id, payload)); }
    catch (_error) { return { status: "unavailable", error: "File provider could not complete cleanup", uncertain: true }; }
  }
  if ( typeof emit.cleanupFile !== "function" ) return { status: "unavailable", error: "File-owning client is unavailable" };
  try { return await requestCleanupClient(clientId, payload); }
  catch (_error) { return { status: "unavailable", error: "File-owning client could not complete cleanup", uncertain: true }; }
}

/** A record id is resolved from persisted state, never a socket-supplied path. */
export async function handleCleanupFileRequest(initiatorId, payload) {
  assertGmInitiator(initiatorId, users());
  if ( activeGM()?.id !== initiatorId || payload?.targetUserId !== game.user.id ) throw new Error("Cleanup target or GM identity changed");
  if ( payload.action === "sessions" ) return { sessionId, attempts: [...activeAttempts], leases: [...activeLeases] };
  const state = registry();
  if ( payload.action === "checkBatch" ) {
    if ( !Array.isArray(payload.records) || !payload.records.length ) throw new Error("Empty verification batch");
    const records = [];
    const protectedFiles = protectedPaths(state);
    for ( const item of payload.records ) {
      const record = state.records.find(candidate => candidate.id === item.recordId);
      if ( !record || record.revision !== item.revision || record.sourceUserId !== game.user.id || !await allowed(record, record.path)
        || protectedRecord(record, state, protectedFiles) ) throw new Error("Unsafe verification batch");
      records.push(record);
    }
    const identity = cleanupFileIdentity(records[0].path);
    if ( records.some(record => {
      const other = cleanupFileIdentity(record.path);
      return other.source !== identity.source || other.account !== identity.account || other.folder !== identity.folder;
    }) ) throw new Error("Verification batch crosses folder or account boundary");
    try {
      const files = await browseCleanupFolder(identity);
      return records.map(record => ({ recordId: record.id, status: files.has(record.path) ? "exists" : "absent" }));
    } catch (_error) { return records.map(record => ({ recordId: record.id, status: "unableToVerify", error: "File existence could not be verified" })); }
  }
  if ( payload.action === "discover" ) {
    const scan = state.pendingScans.find(item => item.id === payload.scanId);
    if ( !scan || scan.revision !== payload.revision || (scan.source !== "data" && scan.sourceUserId !== game.user.id) ) throw new Error("Discovery context is missing, stale, or belongs to another client");
    let folder = scan.folder;
    let identity = cleanupFileIdentity(`${folder}/discovery.webp`);
    if ( globalThis.ForgeVTT?.usingTheForge && identity?.source === "data" ) {
      const account = await globalThis.ForgeAPI?.getUserId?.();
      if ( !account ) throw new Error("Forge identity unavailable");
      folder = `https://assets.forge-vtt.com/${account}/${folder}`;
      identity = cleanupFileIdentity(`${folder}/discovery.webp`);
    }
    if ( !identity ) throw new Error("Unsafe discovery folder");
    const files = await browseCleanupFolder(identity);
    const attributable = [];
    for ( const path of files ) for ( const kind of ["overlay", "merged"] ) {
      if ( await allowed({ ...scan, kind }, path) ) { attributable.push(path); break; }
    }
    return { files: attributable };
  }
  const record = state.records.find(item => item.id === payload.recordId);
  if ( !record || record.revision !== payload.revision || !await allowed(record, record.path) ) throw new Error("Cleanup record is missing, stale, or unsafe");
  if ( protectedRecord(record, state, protectedPaths(state)) ) throw new Error("File is still protected");
  if ( cleanupFileIdentity(record.path)?.source === "forgevtt" && record.sourceUserId !== game.user.id ) throw new Error("Cleanup belongs to another file owner");
  if ( payload.action === "delete" ) return deleteCleanupFile(record.path, { beforeDelete: () => {
    const latest = registry();
    const current = latest.records.find(item => item.id === record.id);
    return activeGM()?.id === initiatorId && current?.revision === payload.revision
      && !protectedRecord(current, latest, protectedPaths(latest));
  } });
  if ( payload.action !== "check" ) throw new Error("Unsupported file cleanup action");
  try {
    const files = await browseCleanupFolder(cleanupFileIdentity(record.path));
    return { status: files.has(record.path) ? "exists" : "absent" };
  } catch (_error) { return { status: "unableToVerify", error: "File existence could not be verified" }; }
}

async function cleanCandidates({ retry = false, userId = null } = {}, budget = cycleBudget(true)) {
  const deferredIds = [];
  const candidates = registry().records.sort((a, b) => Number(Boolean(a.lastCheckedAt)) - Number(Boolean(b.lastCheckedAt))
    || (a.lastCheckedAt ?? a.createdAt ?? 0) - (b.lastCheckedAt ?? b.createdAt ?? 0));
  for ( const candidate of candidates ) {
    const record = await serialize(async () => {
      const state = registry();
      const current = state.records.find(item => item.id === candidate.id);
      if ( !current || (userId && current.sourceUserId !== userId)
        || budget.attempted(current.id) || protectedRecord(current, state, protectedPaths(state)) || (!retry && FALLBACK.has(current.status) && !current.deferred) ) return null;
      if ( !budget.take(current.id) ) { deferredIds.push(current.id); return null; }
      current.orphanedAt ??= Date.now();
      current.status = "pending";
      current.deferred = false;
      current.deletionPending = true;
      current.revision++;
      await persist(state);
      return clone(current);
    });
    if ( !record ) continue;
    const result = await request(record, "delete");
    await serialize(async () => {
      const latest = registry();
      const current = latest.records.find(item => item.id === record.id);
      if ( current?.revision !== record.revision ) return;
      if ( result?.status === "absent" && !protectedRecord(current, latest, protectedPaths(latest)) ) latest.records = latest.records.filter(item => item.id !== record.id);
      else {
        current.status = FALLBACK.has(result?.status) ? result.status : "failed";
        current.error = result?.error || "File deletion failed";
        current.lastCheckedAt = Date.now();
        current.uncertainDeletion ||= Boolean(result?.uncertain);
        current.deletionPending = Boolean(current.uncertainDeletion);
        current.revision++;
      }
      await persist(latest);
    });
  }
  if ( deferredIds.length ) await serialize(async () => {
    const state = registry();
    const paths = protectedPaths(state);
    let changed = false;
    for ( const record of state.records ) {
      if ( !deferredIds.includes(record.id) || record.deferred || protectedRecord(record, state, paths) ) continue;
      record.deferred = true;
      record.status = "unavailable";
      record.error = "Cleanup deferred; use Retry Cleanup or the next startup";
      record.orphanedAt ??= Date.now();
      record.revision++;
      changed = true;
    }
    if ( changed ) await persist(state);
  });
}

async function verifyCandidates() {
  const state = registry();
  const groups = new Map();
  const paths = protectedPaths(state);
  for ( const record of state.records ) {
    if ( !FALLBACK.has(record.status) || protectedRecord(record, state, paths) ) continue;
    const identity = cleanupFileIdentity(record.path);
    if ( !identity ) continue;
    const key = `${identity.source}:${identity.account}:${identity.folder}:${clientFor(record)}`;
    if ( !groups.has(key) ) groups.set(key, []);
    groups.get(key).push(record);
  }
  // Remote clients receive one authenticated check batch per exact folder.
  for ( const records of groups.values() ) {
    const first = records[0];
    let results;
    if ( clientFor(first) === game.user.id ) {
      let files;
      try { files = await withTimeout(browseCleanupFolder(cleanupFileIdentity(first.path))); } catch (_error) { files = null; }
      results = records.map(record => ({ recordId: record.id, status: files ? (files.has(record.path) ? "exists" : "absent") : "unableToVerify" }));
    } else {
      try {
        const targetUserId = clientFor(first);
        results = targetUserId ? await requestCleanupClient(targetUserId, { action: "checkBatch", targetUserId,
          records: records.map(record => ({ recordId: record.id, revision: record.revision })) }) : null;
      } catch (_error) { results = null; }
    }
    await serialize(async () => {
      const latest = registry();
      const latestProtected = protectedPaths(latest);
      for ( const record of records ) {
        const current = latest.records.find(item => item.id === record.id);
        if ( current?.revision !== record.revision || protectedRecord(current, latest, latestProtected) ) continue;
        const result = Array.isArray(results) ? results.find(item => item.recordId === record.id) : null;
        if ( result?.status === "absent" ) latest.records = latest.records.filter(item => item.id !== record.id);
        else if ( result?.status !== "exists" ) { current.status = "unableToVerify"; current.error = result?.error || "File existence could not be verified"; }
        current.lastCheckedAt = Date.now();
        current.revision++;
      }
      await persist(latest);
    });
  }
}
