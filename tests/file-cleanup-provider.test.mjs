import assert from "node:assert/strict";
import { beforeEach, test } from "node:test";
import { cleanupFileIdentity, browseCleanupFolder, deleteCleanupFile } from "../scripts/foundry/file-cleanup-provider.mjs";

const path = "https://assets.forge-vtt.com/account/art/staging/a-overlay-upload-attempt.webp";
let calls, files;
beforeEach(() => {
  calls = [];
  files = [path];
  globalThis.ForgeVTT = { usingTheForge: true };
  globalThis.ForgeAPI = { getUserId: async () => "account", call: async (endpoint, body) => { calls.push({ endpoint, body }); files = []; return { success: true }; } };
  globalThis.foundry = { applications: { apps: { FilePicker: { implementation: { browse: async (source, target) => ({ source, target, files, dirs: [] }) } } } } };
});

test("identity rejects URL normalization traversal and ambiguous accounts", () => {
  for ( const invalid of ["https://assets.forge-vtt.com/account/art/../secret.webp", "https://assets.forge-vtt.com/account/a%2fb.webp", "https://other.com/account/a.webp", "../a.webp", "art//a.webp", "art/a.webp?x=1"] ) assert.equal(cleanupFileIdentity(invalid), null, invalid);
  assert.equal(cleanupFileIdentity(path).account, "account");
});
test("Forge deletes exactly one relative file with existing authentication and confirms absence", async () => {
  assert.deepEqual(await deleteCleanupFile(path), { status: "absent" });
  assert.deepEqual(calls, [{ endpoint: "assets/delete", body: { path: "art/staging/a-overlay-upload-attempt.webp", recursive: false } }]);
});
test("wrong account never sends deletion or treats empty listing as proof", async () => {
  ForgeAPI.getUserId = async () => "other";
  assert.equal((await deleteCleanupFile(path)).status, "unavailable");
  await assert.rejects(browseCleanupFolder(cleanupFileIdentity(path)), /account/);
  assert.equal(calls.length, 0);
});
test("response success without valid verification remains unconfirmed", async () => {
  foundry.applications.apps.FilePicker.implementation.browse = async () => { throw new Error("offline"); };
  assert.equal((await deleteCleanupFile(path)).status, "unconfirmed");
});
test("denied deletion and unsupported local hosts are fallback outcomes", async () => {
  ForgeAPI.call = async () => ({ success: false, error: "permission" });
  assert.equal((await deleteCleanupFile(path)).status, "denied");
  assert.equal((await deleteCleanupFile("art/a.webp")).status, "unsupported");
});
test("foreign account files invalidate listing", async () => {
  files = [path.replace("/account/", "/other/")];
  await assert.rejects(browseCleanupFolder(cleanupFileIdentity(path)), /unverifiable/);
});
test("missing folder is confirmed only by a trustworthy parent listing", async () => {
  foundry.applications.apps.FilePicker.implementation.browse = async (_source, target) => {
    if ( target.endsWith("/staging") ) throw new Error("missing");
    return { source: "forgevtt", target, files: [], dirs: [] };
  };
  assert.deepEqual([...await browseCleanupFolder(cleanupFileIdentity(path))], []);
  foundry.applications.apps.FilePicker.implementation.browse = async (_source, target) => {
    if ( target.endsWith("/staging") ) throw new Error("denied");
    return { source: "forgevtt", target, files: [], dirs: ["art/staging"] };
  };
  await assert.rejects(browseCleanupFolder(cleanupFileIdentity(path)), /denied/);
});
test("empty listing for the wrong folder never proves absence", async () => {
  files = [];
  foundry.applications.apps.FilePicker.implementation.browse = async () => ({ source: "forgevtt", target: "unrelated", files: [], dirs: [] });
  await assert.rejects(browseCleanupFolder(cleanupFileIdentity(path)), /requested folder/);
});
test("multiple missing ancestors can be proven through the library root", async () => {
  foundry.applications.apps.FilePicker.implementation.browse = async (source, target) => {
    if ( !target.endsWith("/account/") ) throw new Error("missing");
    return { source, target, files: [], dirs: [] };
  };
  assert.deepEqual([...await browseCleanupFolder(cleanupFileIdentity(path))], []);
});
test("a record becoming protected during authentication cancels the deletion", async () => {
  assert.equal((await deleteCleanupFile(path, { beforeDelete: () => false })).status, "unavailable");
  assert.equal(calls.length, 0);
});
test("two unresolved provider requests retain their slots and a third never starts", async () => {
  let starts = 0;
  foundry.applications.apps.FilePicker.implementation.browse = async () => { starts++; return new Promise(() => {}); };
  void browseCleanupFolder(cleanupFileIdentity(path));
  void browseCleanupFolder(cleanupFileIdentity(path));
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(starts, 2);
  await assert.rejects(browseCleanupFolder(cleanupFileIdentity(path)), /busy/);
  assert.equal((await deleteCleanupFile(path)).status, "unavailable");
  assert.equal(starts, 2);
  assert.equal(calls.length, 0);
});
