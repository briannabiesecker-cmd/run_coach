// ══════════════════════════════════════════════════
// OBSERVABILITY — per-call activity log + nightly backups
// ══════════════════════════════════════════════════
//
// Two related concerns, both writing to a single global "RunCoach Meta"
// sheet inside the RunCoach folder. The sheet is created on first
// write and reused thereafter.
//
// Tabs:
//   activity — one row per significant call:
//              [timestamp, action, identity, status, latencyMs, note]
//              Lets us answer "who did what when" without per-user
//              snooping. Capped at ~5000 rows (oldest pruned monthly
//              by the trigger). For ~3 friends this lasts months.
//
//   backups  — one row per user per day from the nightly trigger:
//              [date, user, payloadSize, payload]
//              Acts as a rolling backup of the user's data tab. If
//              someone trashes their plan, we restore from here.
//              Kept for 30 days, oldest pruned by the trigger.
//
// Trigger: nightlyBackup() runs at 03:00 script-timezone via a
// time-based trigger. Set up by calling installNightlyBackupTrigger()
// once from the editor.

var META_SHEET_NAME = 'RunCoach Meta';
var META_BACKUP_RETENTION_DAYS = 30;
var META_ACTIVITY_MAX_ROWS = 5000;

function getOrCreateMetaSheet() {
  var folder = getOrCreateRunCoachFolder();
  var matches = folder.getFilesByName(META_SHEET_NAME);
  var ss;
  if (matches.hasNext()) {
    ss = SpreadsheetApp.openById(matches.next().getId());
  } else {
    ss = SpreadsheetApp.create(META_SHEET_NAME);
    var file = DriveApp.getFileById(ss.getId());
    folder.addFile(file);
    DriveApp.getRootFolder().removeFile(file);
  }
  return ss;
}

function getOrCreateActivityTab() {
  var ss = getOrCreateMetaSheet();
  var sheet = ss.getSheetByName('activity');
  if (!sheet) {
    sheet = ss.insertSheet('activity');
    sheet.appendRow(['timestamp', 'action', 'identity', 'status', 'latencyMs', 'note']);
    sheet.setFrozenRows(1);
  }
  return sheet;
}

function getOrCreateBackupsTab() {
  var ss = getOrCreateMetaSheet();
  var sheet = ss.getSheetByName('backups');
  if (!sheet) {
    sheet = ss.insertSheet('backups');
    sheet.appendRow(['date', 'user', 'payloadSize', 'payload']);
    sheet.setFrozenRows(1);
  }
  return sheet;
}

// Append a single activity row. Best-effort: failures are swallowed
// so logging never breaks a real action. Called from doPost wrapper.
/**
 * Append a row to the activity log. Best-effort — failures are
 * swallowed so logging never breaks a real action. Metadata only,
 * no payload contents or PII.
 *
 * @param {string} action - Action name (e.g. 'coach', 'saveUserData')
 * @param {string} identity - Rate-limit identity (user:name or pc:hash)
 * @param {'ok'|'error'|'auth_fail'|'rate_limited'} status
 * @param {number} latencyMs - Wall-clock time the action took
 * @param {string} [note] - Optional context (error message, etc.)
 */
function logActivity(action, identity, status, latencyMs, note) {
  try {
    var sheet = getOrCreateActivityTab();
    sheet.appendRow([
      new Date().toISOString(),
      action || '',
      identity || '',
      status || '',
      latencyMs || 0,
      note || ''
    ]);
  } catch (e) {
    // Don't let logging failures break the user request
    console.warn('logActivity failed:', e.message);
  }
}

// ──────────────────────────────────────────────────
// NIGHTLY BACKUPS — time-based trigger
// ──────────────────────────────────────────────────

// Iterate every USER_SHEET_* script property, open the user's sheet,
// snapshot row 2 of the data tab, and append to the backups tab.
// Then prune backups older than META_BACKUP_RETENTION_DAYS and
// activity older than META_ACTIVITY_MAX_ROWS.
/**
 * Snapshot every user's data tab to the backups tab. Triggered nightly
 * by installNightlyBackupTrigger(). Iterates USER_SHEET_* script
 * properties; one row per user per day. Prunes >30 days afterward.
 *
 * @return {string} Status message (also Logger.log'd)
 */
function nightlyBackup() {
  var props = PropertiesService.getScriptProperties();
  var allProps = props.getProperties();
  var userKeys = Object.keys(allProps).filter(function(k) {
    return k.indexOf('USER_SHEET_') === 0;
  });
  if (!userKeys.length) {
    Logger.log('nightlyBackup: no users to back up');
    return 'no users';
  }

  var backupsSheet = getOrCreateBackupsTab();
  var today = Utilities.formatDate(new Date(), Session.getScriptTimeZone(), 'yyyy-MM-dd');
  var rowsAdded = 0;
  var errors = [];

  userKeys.forEach(function(key) {
    var userName = key.replace('USER_SHEET_', '');
    var sheetId = allProps[key];
    try {
      var ss = SpreadsheetApp.openById(sheetId);
      var dataSheet = ss.getSheetByName('data');
      if (!dataSheet || dataSheet.getLastRow() < 2) return;
      var payload = dataSheet.getRange(2, 1).getValue();
      if (!payload) return;
      backupsSheet.appendRow([today, userName, String(payload).length, payload]);
      rowsAdded++;
    } catch (e) {
      errors.push(userName + ': ' + e.message);
    }
  });

  // Prune old backups (>30 days)
  pruneOldBackups(backupsSheet);

  // Prune activity log (>5000 rows)
  pruneOldActivity();

  var msg = 'nightlyBackup: backed up ' + rowsAdded + ' users, ' + errors.length + ' errors';
  if (errors.length) msg += ' [' + errors.join('; ') + ']';
  Logger.log(msg);
  return msg;
}

function pruneOldBackups(sheet) {
  var lastRow = sheet.getLastRow();
  if (lastRow < 2) return;
  var dates = sheet.getRange(2, 1, lastRow - 1, 1).getValues();
  var cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - META_BACKUP_RETENTION_DAYS);
  var cutoffStr = Utilities.formatDate(cutoff, Session.getScriptTimeZone(), 'yyyy-MM-dd');

  // Find the highest row index where date < cutoff. All rows up to
  // that index get deleted in one batch (rows are append-only so
  // dates are roughly sorted, but we scan to be safe).
  var deleteCount = 0;
  for (var i = 0; i < dates.length; i++) {
    if (String(dates[i][0]) < cutoffStr) deleteCount++;
    else break;
  }
  if (deleteCount > 0) {
    sheet.deleteRows(2, deleteCount);
    Logger.log('pruned ' + deleteCount + ' backup rows older than ' + cutoffStr);
  }
}

function pruneOldActivity() {
  var sheet = getOrCreateActivityTab();
  var lastRow = sheet.getLastRow();
  var excess = lastRow - 1 - META_ACTIVITY_MAX_ROWS;
  if (excess > 0) {
    sheet.deleteRows(2, excess);
    Logger.log('pruned ' + excess + ' oldest activity rows');
  }
}

// One-time setup: install the time-based trigger so nightlyBackup
// runs daily at 03:00 in the script's timezone. Run this from the
// Apps Script editor once after deploying. Idempotent — checks for
// an existing trigger first.
/**
 * One-time setup: install the time-based trigger so nightlyBackup
 * runs daily at 03:00 in the script's timezone. Run from the Apps
 * Script editor once after deploying. Idempotent.
 *
 * @return {string} 'Installed' or 'Already installed'
 */
function installNightlyBackupTrigger() {
  var existing = ScriptApp.getProjectTriggers();
  var alreadyInstalled = existing.some(function(t) {
    return t.getHandlerFunction() === 'nightlyBackup';
  });
  if (alreadyInstalled) {
    return 'Already installed.';
  }
  ScriptApp.newTrigger('nightlyBackup')
    .timeBased()
    .atHour(3)
    .everyDays(1)
    .create();
  return 'Installed: nightlyBackup will run daily at 03:00 (script timezone).';
}

// Helper for restoring a user's plan from a backup row. Run from the
// editor: restoreUserFromBackup('brianna', '2026-04-09') copies that
// day's backed-up payload back into the user's data tab.
/**
 * Restore a user's plan from a backup row. Run from the Apps Script
 * editor when a user accidentally trashes their data. Reads the
 * payload from the backups tab and writes it back via saveUserData.
 *
 * @param {string} userName - The user to restore (case-insensitive)
 * @param {string} dateISO - YYYY-MM-DD of the backup to restore from
 * @return {string} Status message
 */
function restoreUserFromBackup(userName, dateISO) {
  var backupsSheet = getOrCreateBackupsTab();
  var lastRow = backupsSheet.getLastRow();
  if (lastRow < 2) return 'No backups in sheet.';
  var rows = backupsSheet.getRange(2, 1, lastRow - 1, 4).getValues();
  // Find the matching row (last match wins if multiple per day)
  var matchPayload = null;
  for (var i = rows.length - 1; i >= 0; i--) {
    if (rows[i][0] === dateISO && String(rows[i][1]).toLowerCase() === userName.toLowerCase()) {
      matchPayload = rows[i][3];
      break;
    }
  }
  if (!matchPayload) return 'No backup found for ' + userName + ' on ' + dateISO;
  var saveResult = saveUserData({
    userName: userName,
    payload: JSON.parse(matchPayload)
  });
  if (saveResult.error) return 'Restore failed: ' + saveResult.error;
  return 'Restored ' + userName + ' from ' + dateISO + ' (saved at ' + saveResult.updatedAt + ')';
}
