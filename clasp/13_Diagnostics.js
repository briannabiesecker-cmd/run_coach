// ══════════════════════════════════════════════════
// DIAGNOSTICS — quota tracking + cloud sync test
// ══════════════════════════════════════════════════
//
// Three concerns in this file:
//
// 1. trackGeminiCall() — increment a daily counter on every Gemini
//    fetch attempt. Called from fetchGeminiWithRetry. Lets us know
//    when we're approaching the free-tier ceiling instead of finding
//    out from a 429.
//
// 2. getQuotaUsed() — query helper for the frontend. Returns today's
//    counter so the app can display "X / 250 daily Gemini calls used"
//    in the Settings menu or boot splash.
//
// 3. testCloudSync() — runnable from the Apps Script editor. Verifies
//    folder lookup, sheet creation, write/read round-trip. Used to
//    diagnose cloud-sync issues without running the full app flow.

function trackGeminiCall() {
  var key = 'gemini_count_' + Utilities.formatDate(new Date(), Session.getScriptTimeZone(), 'yyyy-MM-dd');
  var props = PropertiesService.getScriptProperties();
  var count = parseInt(props.getProperty(key) || '0', 10) + 1;
  props.setProperty(key, String(count));
  return count;
}

function getQuotaUsed() {
  var today = Utilities.formatDate(new Date(), Session.getScriptTimeZone(), 'yyyy-MM-dd');
  var key = 'gemini_count_' + today;
  var count = parseInt(PropertiesService.getScriptProperties().getProperty(key) || '0', 10);
  return {
    success: true,
    date: today,
    geminiCalls: count,
    // Free tier limits (rough — Google adjusts these periodically)
    freeTierDailyLimit: 250,
    freeTierMinuteLimit: 20
  };
}

function testCloudSync() {
  var log = [];
  var ok = function(msg) { log.push('✅ ' + msg); Logger.log('✅ ' + msg); };
  var bad = function(msg) { log.push('❌ ' + msg); Logger.log('❌ ' + msg); };
  var info = function(msg) { log.push('   ' + msg); Logger.log('   ' + msg); };

  try {
    var folder = getOrCreateRunCoachFolder();
    ok('Folder OK: ' + folder.getName());
    info('Folder URL: ' + folder.getUrl());
    info('Folder ID:  ' + folder.getId());
  } catch (e) {
    bad('Folder lookup failed: ' + e.message);
    return log.join('\n');
  }

  var testUser = 'test_diagnostic';
  var sheet;
  try {
    sheet = getOrCreateUserSheet(testUser);
    ok('Sheet OK for user "' + testUser + '"');
    info('Sheet URL: ' + sheet.getParent().getUrl());
    info('Sheet ID:  ' + sheet.getParent().getId());
  } catch (e) {
    bad('Sheet creation failed: ' + e.message);
    return log.join('\n');
  }

  var samplePayload = {
    test: true,
    timestamp: new Date().toISOString(),
    note: 'If you see this in your sheet, cloud sync is working.'
  };
  try {
    var saveResult = saveUserData({ userName: testUser, payload: samplePayload });
    if (saveResult.error) { bad('Save failed: ' + saveResult.error); return log.join('\n'); }
    ok('Save round-trip succeeded');
    info('Saved at: ' + saveResult.updatedAt);
  } catch (e) {
    bad('Save threw: ' + e.message);
    return log.join('\n');
  }

  try {
    var loadResult = loadUserData({ userName: testUser });
    if (loadResult.error) { bad('Load failed: ' + loadResult.error); return log.join('\n'); }
    if (!loadResult.payload || !loadResult.payload.test) {
      bad('Load returned unexpected payload: ' + JSON.stringify(loadResult.payload));
      return log.join('\n');
    }
    ok('Load round-trip succeeded — payload matches');
    info('Loaded note: ' + loadResult.payload.note);
  } catch (e) {
    bad('Load threw: ' + e.message);
    return log.join('\n');
  }

  try {
    var folder2 = getOrCreateRunCoachFolder();
    var fileName = 'RunCoach - ' + testUser;
    var matches = folder2.getFilesByName(fileName);
    if (matches.hasNext()) {
      ok('File "' + fileName + '" is in the RunCoach folder ✓');
    } else {
      bad('File "' + fileName + '" was NOT found in the RunCoach folder. Sheet was created elsewhere.');
    }
  } catch (e) {
    bad('Folder verification failed: ' + e.message);
  }

  log.push('');
  log.push('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  log.push('DONE. To clean up the test sheet:');
  log.push('  1. Open the Sheet URL above');
  log.push('  2. File → Move to trash');
  log.push('  3. Project Settings → Script Properties → delete USER_SHEET_test_diagnostic');
  log.push('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  return log.join('\n');
}
