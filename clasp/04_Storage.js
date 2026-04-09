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

function getOrCreateRunCoachFolder() {
  var props = PropertiesService.getScriptProperties();
  var folderId = props.getProperty('RUNCOACH_FOLDER_ID');
  if (folderId) {
    try { return DriveApp.getFolderById(folderId); }
    catch (err) { /* fall through to create */ }
  }
  var existing = DriveApp.getFoldersByName('RunCoach');
  if (existing.hasNext()) {
    var f = existing.next();
    props.setProperty('RUNCOACH_FOLDER_ID', f.getId());
    return f;
  }
  var folder = DriveApp.createFolder('RunCoach');
  props.setProperty('RUNCOACH_FOLDER_ID', folder.getId());
  return folder;
}

function getOrCreateUserSheet(userName) {
  var key = 'USER_SHEET_' + userName.toLowerCase();
  var props = PropertiesService.getScriptProperties();
  var sheetId = props.getProperty(key);
  var ss;
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
function migratePayload(parsed) {
  if (!parsed) return parsed;
  var v = parsed.payloadVersion || 0;
  // Future migrations:
  // if (v < 2) { /* upgrade v1 → v2 */ parsed.payloadVersion = 2; }
  // if (v < 3) { /* upgrade v2 → v3 */ parsed.payloadVersion = 3; }
  if (!parsed.payloadVersion) parsed.payloadVersion = PAYLOAD_VERSION;
  return parsed;
}

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
