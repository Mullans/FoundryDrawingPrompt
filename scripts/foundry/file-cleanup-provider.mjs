/** Exact file identities keep Forge account boundaries intact. */
let inFlight = 0;

async function withProviderSlot(task) {
  if ( inFlight >= 2 ) throw new Error("File provider is busy with unresolved requests");
  inFlight++;
  try { return await task(); }
  finally { inFlight--; }
}

export function cleanupFileIdentity(path) {
  if ( typeof path !== "string" || !path || /\\|%(?:2e|2f|5c)/i.test(path) ) return null;
  if ( path.startsWith("https://") ) {
    // Inspect before URL normalization (which otherwise erases traversal).
    if ( path.split("/").some(part => part === "." || part === "..") ) return null;
    let url;
    try { url = new URL(path); } catch (_error) { return null; }
    if ( url.origin !== "https://assets.forge-vtt.com" || url.search || url.hash || url.username || url.password ) return null;
    let parts;
    try { parts = url.pathname.slice(1).split("/").map(decodeURIComponent); } catch (_error) { return null; }
    if ( parts.length < 2 || parts.some(part => !part || part === "." || part === ".." || /[\\/]/.test(part)) ) return null;
    const account = parts.shift();
    const relativePath = parts.join("/");
    const canonicalPath = `${url.origin}/${[account, ...parts].map(encodeURIComponent).join("/")}`;
    return { source: "forgevtt", account, relativePath, path: canonicalPath, folder: canonicalPath.slice(0, canonicalPath.lastIndexOf("/")) };
  }
  if ( /[:?#]/.test(path) || path.startsWith("/") || path.split("/").some(part => !part || part === "." || part === "..") ) return null;
  return { source: "data", account: "", relativePath: path, path, folder: path.slice(0, Math.max(0, path.lastIndexOf("/"))) };
}

function picker() {
  const base = globalThis.foundry?.applications?.apps?.FilePicker;
  return base?.implementation ?? base;
}

async function authorize(identity) {
  if ( identity.source !== "forgevtt" ) return;
  if ( !globalThis.ForgeVTT?.usingTheForge || typeof globalThis.ForgeAPI?.getUserId !== "function" ) throw new Error("Forge integration unavailable");
  if ( String(await globalThis.ForgeAPI.getUserId()) !== identity.account ) throw new Error("Forge account does not own this library");
}

/** Return an authoritative folder listing, never an empty list after errors. */
export async function browseCleanupFolder(identity) {
  return withProviderSlot(() => browseFolder(identity));
}

async function browseFolder(identity) {
  await authorize(identity);
  if ( typeof picker()?.browse !== "function" ) throw new Error("File browsing unavailable");
  return new Set((await browse(identity.folder)).files);
  async function browse(folder) {
    let listing;
    try { listing = await picker().browse(identity.source, folder); }
    catch (error) {
    const relativeFolder = identity.source === "forgevtt" ? folder.replace(`https://assets.forge-vtt.com/${identity.account}/`, "") : folder;
    if ( !relativeFolder || folder === `https://assets.forge-vtt.com/${identity.account}` ) throw error;
    const parentRelative = relativeFolder.includes("/") ? relativeFolder.slice(0, relativeFolder.lastIndexOf("/")) : "";
    const parent = identity.source === "forgevtt" ? `https://assets.forge-vtt.com/${identity.account}${parentRelative ? `/${parentRelative}` : "/"}` : parentRelative;
    const parentListing = await browse(parent);
    if ( parentListing.dirs.some(dir => dir.replace(/\/$/, "") === folder.replace(/\/$/, "") || dir.replace(/^\/+|\/+$/g, "") === relativeFolder) ) throw error;
    return { files: [], dirs: [] };
  }
  if ( !listing || !Array.isArray(listing.files) || !Array.isArray(listing.dirs) ) throw new Error("Invalid file listing");
  if ( listing.source && listing.source !== identity.source ) throw new Error("Unexpected storage source");
  const canonical = value => String(value).replace(/^\/+|\/+$/g, "");
  const relative = identity.source === "forgevtt" ? folder.replace(`https://assets.forge-vtt.com/${identity.account}/`, "") : folder;
  if ( typeof listing.target !== "string" || ![canonical(folder), canonical(relative)].includes(canonical(listing.target)) ) throw new Error("Listing did not verify the requested folder");
  if ( listing.dirs.some(dir => typeof dir !== "string" || (dir.startsWith("https://") && !dir.startsWith(`https://assets.forge-vtt.com/${identity.account}/`))) ) throw new Error("Directory listing has an unverifiable account");
  const files = listing.files.map(cleanupFileIdentity);
  if ( files.some(file => !file || file.source !== identity.source || file.account !== identity.account || file.folder !== folder) ) throw new Error("File listing has an unverifiable account or folder");
  return { files: files.map(file => file.path), dirs: listing.dirs };
  }
}

/** Existing Forge credentials only; never keys, recursive requests, or core hacks. */
export async function deleteCleanupFile(path, { beforeDelete = null } = {}) {
  try { return await withProviderSlot(() => deleteFile(path, { beforeDelete })); }
  catch (_error) { return { status: "unavailable", error: "File provider is busy or unavailable" }; }
}

async function deleteFile(path, { beforeDelete }) {
  const identity = cleanupFileIdentity(path);
  if ( !identity ) return { status: "failed", error: "Invalid file identity" };
  if ( identity.source !== "forgevtt" ) {
    try { if ( !(await browseFolder(identity)).has(identity.path) ) return { status: "absent" }; } catch (_error) { /* Unsupported deletion remains a fallback even if browsing is unavailable. */ }
    return { status: "unsupported", error: "This host exposes no supported file deletion API" };
  }
  try {
    await authorize(identity);
    if ( beforeDelete && !await beforeDelete() ) return { status: "unavailable", error: "Cleanup record changed before deletion" };
    if ( typeof globalThis.ForgeAPI?.call !== "function" ) return { status: "unavailable", error: "Forge request helper unavailable" };
    const result = await globalThis.ForgeAPI.call("assets/delete", { path: identity.relativePath, recursive: false });
    if ( !result?.success ) {
      try { if ( !(await browseFolder(identity)).has(identity.path) ) return { status: "absent" }; } catch (_error) { /* Never infer absence from a failed check. */ }
      return { status: "denied", error: "Forge did not authorize or complete file deletion" };
    }
    try {
      const files = await browseFolder(identity);
      return files.has(identity.path) ? { status: "unconfirmed", error: "File still appears in its folder" } : { status: "absent" };
    } catch (_error) { return { status: "unconfirmed", error: "Deletion completed but absence could not be verified" }; }
  } catch (_error) { return { status: "unavailable", error: "File owner authentication or Forge service unavailable" }; }
}
