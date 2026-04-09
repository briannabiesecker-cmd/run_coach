// ══════════════════════════════════════════════════
// STORAGE — per-user Google Sheet files in /RunCoach/
// ══════════════════════════════════════════════════
//
// Layout:
//   /My Drive/RunCoach/                  ← folder, created on first save
//     RunCoach - Brianna  (sheet)        ← one file per user
//     RunCoach - Alex     (sheet)
//     RunCoach - Sam      (sheet)
//
// Each per-user sheet has a "data" tab:
//   Row 1: payload | updatedAt           (frozen header)
//   Row 2: <JSON>  | <ISO timestamp>     (the only data row)
//
// The folder ID is cached in script properties as RUNCOACH_FOLDER_ID.
// Each user's sheet ID is cached as USER_SHEET_<lowercased name>.
// First call creates, every subsequent call reuses cached ID.
// Stale-cache recovery: if a cached ID points to a deleted file, we
// look up by name before creating, so duplicates don't accumulate.
//
// CONCURRENCY: saveUserData uses LockService to prevent two simultaneous
// writes from interleaving. Without the lock, a race could lose data.

// CacheService caches the resolved folder ID across script invocations.
// PropertiesService is the slow source-of-truth (~50ms per get); cache
// is ~10ms. Drive search fallback (when properties miss) is ~600ms.
// On cache hit we skip both. On stale-cache (deleted folder) we
// invalidate and fall through to the slow path.
/**
 * Resolve (or create) the RunCoach folder in Drive. Caches the result
 * in CacheService for 6 hours. Falls through to PropertiesService and
 * Drive search on cache miss.
 *
 * @return {GoogleAppsScript.Drive.Folder} The RunCoach folder
 */
function getOrCreateRunCoachFolder() {
  var cache = CacheService.getScriptCache();
  var cachedId = cache.get('runcoach_folder_id');
  if (cachedId) {
    try { return DriveApp.getFolderById(cachedId); }
    catch (err) { cache.remove('runcoach_folder_id'); }
  }

  var props = PropertiesService.getScriptProperties();
  var folderId = props.getProperty('RUNCOACH_FOLDER_ID');
  if (folderId) {
    try {
      var f = DriveApp.getFolderById(folderId);
      cache.put('runcoach_folder_id', folderId, CACHE_TTL_FOLDER_SEC);
      return f;
    }
    catch (err) { /* fall through to create */ }
  }
  var existing = DriveApp.getFoldersByName('RunCoach');
  if (existing.hasNext()) {
    var existingFolder = existing.next();
    props.setProperty('RUNCOACH_FOLDER_ID', existingFolder.getId());
    cache.put('runcoach_folder_id', existingFolder.getId(), CACHE_TTL_FOLDER_SEC);
    return existingFolder;
  }
  var folder = DriveApp.createFolder('RunCoach');
  props.setProperty('RUNCOACH_FOLDER_ID', folder.getId());
  cache.put('runcoach_folder_id', folder.getId(), CACHE_TTL_FOLDER_SEC);
  return folder;
}

// Per-user sheet lookup with the same cache pattern. The cache key is
// derived from lowercased user name; values are sheet IDs (strings).
// Stale-cache recovery handled by catching openById errors.
/**
 * Resolve (or create) a per-user sheet inside the RunCoach folder.
 * The sheet is named "RunCoach - <userName>" and contains a "data" tab.
 * Cached in CacheService for 1 hour with stale-cache recovery.
 *
 * @param {string} userName - The user's display name (case-insensitive lookup)
 * @return {GoogleAppsScript.Spreadsheet.Sheet} The "data" tab of the user's sheet
 */
function getOrCreateUserSheet(userName) {
  var cache = CacheService.getScriptCache();
  var cacheKey = 'user_sheet_' + userName.toLowerCase();
  var ss;

  // Fast path: cache hit → openById and return
  var cachedId = cache.get(cacheKey);
  if (cachedId) {
    try {
      ss = SpreadsheetApp.openById(cachedId);
    } catch (err) {
      cache.remove(cacheKey);
      ss = null;
    }
  }

  // Slow path: PropertiesService → Drive search → create
  if (!ss) {
    var key = 'USER_SHEET_' + userName.toLowerCase();
    var props = PropertiesService.getScriptProperties();
    var sheetId = props.getProperty(key);
    if (sheetId) {
      try { ss = SpreadsheetApp.openById(sheetId); }
      catch (err) { ss = null; }
    }
    if (!ss) {
      var folder = getOrCreateRunCoachFolder();
      var fileName = 'RunCoach - ' + userName;
      var matches = folder.getFilesByName(fileName);
      if (matches.hasNext()) {
        var existingFile = matches.next();
        ss = SpreadsheetApp.openById(existingFile.getId());
      } else {
        ss = SpreadsheetApp.create(fileName);
        var file = DriveApp.getFileById(ss.getId());
        folder.addFile(file);
        DriveApp.getRootFolder().removeFile(file);
      }
      props.setProperty(key, ss.getId());
    }
    // Whatever path we took, cache the resolved ID
    cache.put(cacheKey, ss.getId(), CACHE_TTL_USER_SHEET_SEC);
  }

  var sheet = ss.getSheetByName('data');
  if (!sheet) {
    sheet = ss.insertSheet('data');
    sheet.appendRow(['payload', 'updatedAt']);
    sheet.setFrozenRows(1);
  }
  return sheet;
}

// Schema migration entrypoint. Today this is a no-op — we're at v1 and
// nothing to migrate. When the schema changes, add migration steps here.
// The function takes a parsed payload, mutates/returns it, and bumps
// the version. Loaders call this on every read.
/**
 * Schema migration entrypoint. Today this is a no-op (we're at v1).
 * When the payload schema changes, add migration steps here. Loaders
 * call this on every read so old payloads upgrade transparently.
 *
 * @param {Object} parsed - The JSON-parsed cloud payload
 * @return {Object} Migrated payload (same object, mutated)
 */
function migratePayload(parsed) {
  if (!parsed) return parsed;
  var v = parsed.payloadVersion || 0;
  // Future migrations:
  // if (v < 2) { /* upgrade v1 → v2 */ parsed.payloadVersion = 2; }
  // if (v < 3) { /* upgrade v2 → v3 */ parsed.payloadVersion = 3; }
  if (!parsed.payloadVersion) parsed.payloadVersion = PAYLOAD_VERSION;
  return parsed;
}

/**
 * Load a user's full payload from their per-user sheet's "data" tab.
 * Migrates old schema versions automatically via migratePayload().
 *
 * @param {{userName: string}} body
 * @return {{success: true, payload: Object|null, updatedAt?: string} | {error: string}}
 */
function loadUserData(body) {
  var userName = (body.userName || '').trim();
  if (!userName) return { error: 'userName is required' };
  try {
    var sheet = getOrCreateUserSheet(userName);
    if (sheet.getLastRow() < 2) return { success: true, payload: null };
    var payloadStr = sheet.getRange(2, 1).getValue();
    var updatedAt  = sheet.getRange(2, 2).getValue();
    if (!payloadStr) return { success: true, payload: null };
    var parsed;
    try { parsed = JSON.parse(payloadStr); }
    catch (e) { return { error: 'Stored payload was malformed JSON: ' + String(e).slice(0, 200) }; }
    parsed = migratePayload(parsed);
    return { success: true, payload: parsed, updatedAt: updatedAt };
  } catch (err) {
    return { error: 'loadUserData failed: ' + (err.message || String(err)) };
  }
}

/**
 * Save a user's full payload to their per-user sheet. Stamps payloadVersion,
 * acquires LockService to prevent concurrent-write races, validates against
 * SHEETS_CELL_LIMIT, writes to row 2 of the data tab.
 *
 * @param {{userName: string, payload: Object}} body
 * @return {{success: true, updatedAt: string} | {error: string}}
 */
function saveUserData(body) {
  var userName = (body.userName || '').trim();
  if (!userName) return { error: 'userName is required' };
  if (!body.payload) return { error: 'payload is required' };

  // Acquire a script-wide lock so concurrent saveUserData calls for the
  // same OR different users serialize. Sheets writes are not atomic at
  // the row level for our read-modify-write pattern, so this prevents
  // interleaved updates from clobbering each other.
  var lock = LockService.getScriptLock();
  if (!lock.tryLock(5000)) {
    return { error: 'Could not acquire write lock — another save in progress, try again' };
  }

  try {
    // Stamp the payload with the current schema version so future
    // migrations can detect what shape they're starting from.
    body.payload.payloadVersion = PAYLOAD_VERSION;

    var payloadStr = JSON.stringify(body.payload);
    if (payloadStr.length > SHEETS_CELL_LIMIT) {
      return {
        error: 'Payload too large for Sheets (' + payloadStr.length +
               ' chars > ' + SHEETS_CELL_LIMIT + ' limit). ' +
               'Trim check-in history or reduce plan size.'
      };
    }
    var sheet = getOrCreateUserSheet(userName);
    var nowIso = new Date().toISOString();
    if (sheet.getLastRow() < 2) {
      sheet.appendRow([payloadStr, nowIso]);
    } else {
      sheet.getRange(2, 1, 1, 2).setValues([[payloadStr, nowIso]]);
    }
    return { success: true, updatedAt: nowIso };
  } catch (err) {
    return { error: 'saveUserData failed: ' + (err.message || String(err)) };
  } finally {
    lock.releaseLock();
  }
}
