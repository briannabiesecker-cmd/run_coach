// ══════════════════════════════════════════════════
// RUN COACH — Apps Script Proxy for Gemini API
// ══════════════════════════════════════════════════
//
// Setup:
//   Project Settings → Script Properties → Add:
//     GEMINI_API_KEY = your_api_key_from_aistudio.google.com
//
// Deploy as Web App (Execute as: Me, Access: Anyone)

var GEMINI_MODEL = 'gemini-2.5-flash';

// Fetch Gemini with automatic retry on transient infrastructure errors.
// Gemini regularly returns 503 ("UNAVAILABLE - high demand"), 429
// (rate limit), and occasionally 500 — these are not bugs in our code,
// just Google's free tier under load. We retry up to 3 times with
// exponential backoff (2s, 4s, 8s) before surfacing the error.
function fetchGeminiWithRetry(url, payload) {
  var maxAttempts = 3;
  var lastResponse = null;
  for (var attempt = 1; attempt <= maxAttempts; attempt++) {
    var response = UrlFetchApp.fetch(url, {
      method: 'post',
      contentType: 'application/json',
      payload: JSON.stringify(payload),
      muteHttpExceptions: true
    });
    var code = response.getResponseCode();
    if (code === 200) return response;
    lastResponse = response;
    // Retry only on transient infrastructure errors
    if (code !== 503 && code !== 429 && code !== 500) return response;
    if (attempt < maxAttempts) {
      // Exponential backoff: 2s, 4s, 8s
      Utilities.sleep(Math.pow(2, attempt) * 1000);
    }
  }
  return lastResponse;
}

// ──────────────────────────────────────────────────
// Auth: shared passcode required for all non-public actions.
// Set APP_PASSCODE in Project Settings → Script Properties.
// 'ping' and 'verifyPasscode' are exempt (used for connectivity + login).
// ──────────────────────────────────────────────────
function checkPasscode(supplied) {
  var expected = PropertiesService.getScriptProperties().getProperty('APP_PASSCODE');
  if (!expected) return { ok: false, error: 'APP_PASSCODE not set in script properties.' };
  if (!supplied || supplied !== expected) return { ok: false, error: 'Unauthorized' };
  return { ok: true };
}

function doGet(e) {
  var callback = e.parameter.callback || 'callback';
  var action   = e.parameter.action || '';
  var result;

  try {
    if (action === 'ping') {
      result = { ok: true, version: 'v2', ts: new Date().toISOString() };
    } else if (action === 'verifyPasscode') {
      result = checkPasscode(e.parameter.passcode);
    } else if (action === 'coach') {
      var auth = checkPasscode(e.parameter.passcode);
      if (!auth.ok) { result = { error: auth.error }; }
      else { result = coach(e.parameter); }
    } else {
      result = { error: 'Unknown action: ' + action };
    }
  } catch (err) {
    result = { error: err.message || String(err) };
  }

  return ContentService
    .createTextOutput(callback + '(' + JSON.stringify(result) + ')')
    .setMimeType(ContentService.MimeType.JAVASCRIPT);
}

// POST endpoint for large payloads (screenshots).
// Body is JSON sent as text/plain (avoids CORS preflight).
function doPost(e) {
  var result;
  try {
    var body = JSON.parse(e.postData.contents || '{}');
    var action = body.action || '';
    if (action === 'verifyPasscode') {
      result = checkPasscode(body.passcode);
    } else if (action === 'coach') {
      var auth = checkPasscode(body.passcode);
      if (!auth.ok) { result = { error: auth.error }; }
      else { result = coach(body); }
    } else if (action === 'lookupRace') {
      var auth2 = checkPasscode(body.passcode);
      if (!auth2.ok) { result = { error: auth2.error }; }
      else { result = lookupRace(body); }
    } else if (action === 'weeklyReview') {
      var auth3 = checkPasscode(body.passcode);
      if (!auth3.ok) { result = { error: auth3.error }; }
      else { result = weeklyReview(body); }
    } else if (action === 'parseRunScreenshot') {
      var auth4 = checkPasscode(body.passcode);
      if (!auth4.ok) { result = { error: auth4.error }; }
      else { result = parseRunScreenshot(body); }
    } else if (action === 'loadUserData') {
      var auth5 = checkPasscode(body.passcode);
      if (!auth5.ok) { result = { error: auth5.error }; }
      else { result = loadUserData(body); }
    } else if (action === 'saveUserData') {
      var auth6 = checkPasscode(body.passcode);
      if (!auth6.ok) { result = { error: auth6.error }; }
      else { result = saveUserData(body); }
    } else {
      result = { error: 'Unknown action: ' + action };
    }
  } catch (err) {
    result = { error: err.message || String(err) };
  }

  return ContentService
    .createTextOutput(JSON.stringify(result))
    .setMimeType(ContentService.MimeType.JSON);
}

// ══════════════════════════════════════════════════
// CLOUD STORAGE — one Google Sheet per user, in a RunCoach folder
// ══════════════════════════════════════════════════
//
// Layout:
//   /My Drive/RunCoach/                 ← folder, created on first save
//     RunCoach - Brianna  (sheet)       ← one file per user
//     RunCoach - Alex     (sheet)
//     RunCoach - Sam      (sheet)
//
// Each per-user sheet has a single tab "data" with:
//   Row 1: payload | updatedAt          (frozen header)
//   Row 2: <JSON>  | <ISO timestamp>    (the only data row)
//
// Lookups: the per-user sheet ID is cached in Script Properties as
// USER_SHEET_<lowercased name>. The folder ID is cached as
// RUNCOACH_FOLDER_ID. Both caches mean repeat calls don't spam Drive
// — first call creates, every subsequent call reuses the cached ID.
// If a cached ID points to a deleted file, we recreate cleanly.

function getOrCreateRunCoachFolder() {
  var props = PropertiesService.getScriptProperties();
  var folderId = props.getProperty('RUNCOACH_FOLDER_ID');
  if (folderId) {
    try { return DriveApp.getFolderById(folderId); }
    catch (err) { /* fall through to create */ }
  }
  // Look for an existing "RunCoach" folder at the root before creating
  // (handles the case where the user manually made one or restored a
  // previous deployment).
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
    catch (err) { ss = null; /* deleted or unshared — recreate */ }
  }
  if (!ss) {
    var folder = getOrCreateRunCoachFolder();
    var fileName = 'RunCoach - ' + userName;
    // Check if a file with this name already exists in the folder
    // (recovery path: cached ID was lost but the file is still there).
    var matches = folder.getFilesByName(fileName);
    if (matches.hasNext()) {
      var existingFile = matches.next();
      ss = SpreadsheetApp.openById(existingFile.getId());
    } else {
      ss = SpreadsheetApp.create(fileName);
      // Move the freshly-created file from My Drive root into RunCoach
      var file = DriveApp.getFileById(ss.getId());
      folder.addFile(file);
      DriveApp.getRootFolder().removeFile(file);
    }
    props.setProperty(key, ss.getId());
  }
  // Ensure the "data" tab exists with the right header
  var sheet = ss.getSheetByName('data');
  if (!sheet) {
    sheet = ss.insertSheet('data');
    sheet.appendRow(['payload', 'updatedAt']);
    sheet.setFrozenRows(1);
  }
  return sheet;
}

// ──────────────────────────────────────────────────
// DIAGNOSTIC: run this from the Apps Script editor to verify cloud
// storage is wired correctly. Pick "testCloudSync" from the function
// dropdown, click Run, then check the execution log (View → Logs or
// the bottom panel). It will tell you exactly what worked and what
// didn't, with URLs you can click to inspect the resulting sheet.
//
// No version bump needed — running from the editor uses the latest
// clasp-pushed code directly.
function testCloudSync() {
  var log = [];
  var ok = function(msg) { log.push('✅ ' + msg); Logger.log('✅ ' + msg); };
  var bad = function(msg) { log.push('❌ ' + msg); Logger.log('❌ ' + msg); };
  var info = function(msg) { log.push('   ' + msg); Logger.log('   ' + msg); };

  // 1. Folder lookup
  try {
    var folder = getOrCreateRunCoachFolder();
    ok('Folder OK: ' + folder.getName());
    info('Folder URL: ' + folder.getUrl());
    info('Folder ID:  ' + folder.getId());
  } catch (e) {
    bad('Folder lookup failed: ' + e.message);
    return log.join('\n');
  }

  // 2. Per-user sheet creation
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

  // 3. Round-trip write → read
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

  // 4. Verify the sheet appears in the right folder
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

function loadUserData(body) {
  var userName = (body.userName || '').trim();
  if (!userName) return { error: 'userName is required' };
  try {
    var sheet = getOrCreateUserSheet(userName);
    if (sheet.getLastRow() < 2) return { success: true, payload: null }; // new user, empty sheet
    var payloadStr = sheet.getRange(2, 1).getValue();
    var updatedAt  = sheet.getRange(2, 2).getValue();
    if (!payloadStr) return { success: true, payload: null };
    var parsed;
    try { parsed = JSON.parse(payloadStr); }
    catch (e) { return { error: 'Stored payload was malformed JSON: ' + String(e).slice(0, 200) }; }
    return { success: true, payload: parsed, updatedAt: updatedAt };
  } catch (err) {
    return { error: 'loadUserData failed: ' + (err.message || String(err)) };
  }
}

function saveUserData(body) {
  var userName = (body.userName || '').trim();
  if (!userName) return { error: 'userName is required' };
  if (!body.payload) return { error: 'payload is required' };
  try {
    var payloadStr = JSON.stringify(body.payload);
    if (payloadStr.length > 49500) {
      return { error: 'Payload too large for Sheets (' + payloadStr.length + ' chars > 49500 limit). Trim check-in history or reduce plan size.' };
    }
    var sheet = getOrCreateUserSheet(userName);
    var nowIso = new Date().toISOString();
    // Always write to row 2 (overwrite the single data row)
    if (sheet.getLastRow() < 2) {
      sheet.appendRow([payloadStr, nowIso]);
    } else {
      sheet.getRange(2, 1, 1, 2).setValues([[payloadStr, nowIso]]);
    }
    return { success: true, updatedAt: nowIso };
  } catch (err) {
    return { error: 'saveUserData failed: ' + (err.message || String(err)) };
  }
}

// ──────────────────────────────────────────────────
// Coach: send race goal + screenshots to Gemini
// ──────────────────────────────────────────────────
//
// params:
//   raceDate          — "2026-06-15"
//   raceDistance      — "10K", "Half Marathon", "Marathon", etc.
//   weeklyMileage     — current weekly miles
//   goalTime          — target finish time
//   coachingStyle     — "encouraging" | "data-driven" | "tough-love"
//   screenshotBase64  — comma-separated list of base64-encoded screenshots
//
function coach(params) {
  var apiKey = PropertiesService.getScriptProperties().getProperty('GEMINI_API_KEY');
  if (!apiKey) return { error: 'GEMINI_API_KEY not set in script properties.' };

  var raceDate         = params.raceDate || '';
  var raceDistance     = params.raceDistance || '';
  var weeklyMileage    = params.weeklyMileage || '';
  var goalTime         = params.goalTime || '';
  var coachingStyle    = params.coachingStyle || 'encouraging';
  var longestRecentRun = params.longestRecentRun || '';
  var daysPerWeek      = params.daysPerWeek || '';
  var longRunDay       = params.longRunDay || '';
  var injuryNotes      = params.injuryNotes || '';
  // strengthSchedule arrives as an array of { day, time, label }
  var strengthSchedule = Array.isArray(params.strengthSchedule) ? params.strengthSchedule : [];
  // screenshots may arrive as an array (POST body) or comma-separated string (JSONP GET)
  var screenshots;
  if (Array.isArray(params.screenshots)) {
    screenshots = params.screenshots;
  } else {
    screenshots = (params.screenshotBase64 || '').split(',,,').filter(function(s) { return s.length > 0; });
  }

  if (!raceDate || !raceDistance) {
    return { error: 'raceDate and raceDistance are required.' };
  }

  // Compute the runner's tier server-side so we only send the relevant
  // template + workout library, instead of all 12 cells. Saves ~50% of
  // the system-prompt token budget per call.
  var tier        = inferTier(weeklyMileage, longestRecentRun);
  var distanceKey = getDistanceKey(raceDistance);

  // Build prompt
  var systemPrompt = buildSystemPrompt(coachingStyle, tier, distanceKey);
  var userPrompt   = buildUserPrompt({
    raceDate: raceDate,
    distance: raceDistance,
    mileage: weeklyMileage,
    goal: goalTime,
    longestRecentRun: longestRecentRun,
    daysPerWeek: daysPerWeek,
    longRunDay: longRunDay,
    injuryNotes: injuryNotes,
    screenshotCount: screenshots.length,
    strengthSchedule: strengthSchedule
  });

  // Build Gemini parts: text + inline images
  var parts = [{ text: userPrompt }];
  screenshots.forEach(function(b64) {
    parts.push({
      inline_data: {
        mime_type: 'image/png',
        data: b64
      }
    });
  });

  var payload = {
    system_instruction: { parts: [{ text: systemPrompt }] },
    contents: [{ role: 'user', parts: parts }],
    generationConfig: {
      temperature: 0.7,
      response_mime_type: 'application/json',
      // Plans with segments per quality day + 18-22 weeks can blow past
      // the default 8K output token budget. Bumping to 32K gives room for
      // a marathon plan with full per-workout structure.
      maxOutputTokens: 32768
    }
  };

  var url = 'https://generativelanguage.googleapis.com/v1beta/models/' + GEMINI_MODEL + ':generateContent?key=' + apiKey;
  var response = fetchGeminiWithRetry(url, payload);

  var code = response.getResponseCode();
  if (code !== 200) {
    return { error: 'Gemini API error (' + code + '): ' + response.getContentText().slice(0, 500) };
  }

  var data = JSON.parse(response.getContentText());
  var text = data.candidates && data.candidates[0] && data.candidates[0].content
    ? data.candidates[0].content.parts.map(function(p) { return p.text || ''; }).join('')
    : '';

  // Detect truncation: Gemini sets finishReason to "MAX_TOKENS" when the
  // response was cut off. The JSON will be unparseable in that case.
  var finishReason = (data.candidates && data.candidates[0] && data.candidates[0].finishReason) || '';
  if (finishReason === 'MAX_TOKENS') {
    return { error: 'Plan was too long and got truncated by Gemini. Try a shorter race timeline or fewer weeks.' };
  }

  // Gemini returns JSON-as-string when response_mime_type=application/json
  var parsed;
  try {
    parsed = JSON.parse(text);
  } catch(e) {
    return { error: 'Gemini returned malformed JSON: ' + String(e).slice(0, 200) + ' — first 200 chars: ' + text.slice(0, 200) };
  }

  // Sanity check: a valid plan must have a weeks array. Without this, the
  // frontend would silently save a broken plan and show a blank dashboard.
  if (!parsed || !Array.isArray(parsed.weeks) || parsed.weeks.length === 0) {
    return { error: 'Plan response was missing the required "weeks" array. Try regenerating.' };
  }

  return { success: true, result: parsed };
}

// ──────────────────────────────────────────────────
// Race lookup: ask Gemini to identify a race by name
// and return structured info for user confirmation.
// ──────────────────────────────────────────────────
function lookupRace(params) {
  var apiKey = PropertiesService.getScriptProperties().getProperty('GEMINI_API_KEY');
  if (!apiKey) return { error: 'GEMINI_API_KEY not set in script properties.' };

  var raceName = (params.raceName || '').trim();
  if (!raceName) return { error: 'raceName is required.' };

  var thisYear = new Date().getFullYear();
  var nextYear = thisYear + 1;

  var systemPrompt = 'You identify running races by name and return structured JSON. ' +
    'You know major races worldwide (Boston, NYC, Chicago, Berlin, London, Tokyo, Richmond, Marine Corps, etc.) ' +
    'and many smaller annual races.';

  var userPrompt = [
    'Identify this race: "' + raceName + '"',
    '',
    'The current year is ' + thisYear + '. The runner wants information for the upcoming edition (' + thisYear + ' or ' + nextYear + ').',
    '',
    'Return ONLY valid JSON in this exact structure:',
    '{',
    '  "found": true,',
    '  "name": "Full official race name",',
    '  "date": "YYYY-MM-DD",',
    '  "location": "City, State/Country",',
    '  "distance": "5K" | "10K" | "Half Marathon" | "Marathon" | "Other",',
    '  "confidence": "high" | "medium" | "low",',
    '  "notes": "brief context if helpful"',
    '}',
    '',
    'Rules:',
    '- If you do not recognize the race, return { "found": false }.',
    '- If the race happens annually but you do not know the exact upcoming date, use the typical pattern (e.g. "second Saturday of November") to estimate, and set confidence to "medium".',
    '- If multiple races match, pick the most famous one.',
    '- "distance" must be one of the exact strings listed above.',
    '- Return JSON ONLY, no markdown fences, no commentary.'
  ].join('\n');

  var payload = {
    system_instruction: { parts: [{ text: systemPrompt }] },
    contents: [{ role: 'user', parts: [{ text: userPrompt }] }],
    generationConfig: {
      temperature: 0.2,
      response_mime_type: 'application/json'
    }
  };

  var url = 'https://generativelanguage.googleapis.com/v1beta/models/' + GEMINI_MODEL + ':generateContent?key=' + apiKey;
  var response = fetchGeminiWithRetry(url, payload);

  if (response.getResponseCode() !== 200) {
    return { error: 'Lookup failed: ' + response.getContentText().slice(0, 300) };
  }

  var data = JSON.parse(response.getContentText());
  var text = data.candidates && data.candidates[0] && data.candidates[0].content
    ? data.candidates[0].content.parts.map(function(p) { return p.text || ''; }).join('')
    : '';

  var parsed;
  try { parsed = JSON.parse(text); } catch(e) { return { error: 'Could not parse lookup response.' }; }
  return { success: true, race: parsed };
}

// ──────────────────────────────────────────────────
// Parse a Strava run screenshot into structured fields.
// Returns distance, duration, avg HR, etc.
// ──────────────────────────────────────────────────
function parseRunScreenshot(params) {
  var apiKey = PropertiesService.getScriptProperties().getProperty('GEMINI_API_KEY');
  if (!apiKey) return { error: 'GEMINI_API_KEY not set in script properties.' };

  var image = params.image || '';
  if (!image) return { error: 'No image provided.' };

  var systemPrompt = 'You extract running activity data from Strava screenshots. Return only JSON, no commentary.';

  var userPrompt = [
    'This is a screenshot of a single running activity from Strava.',
    'Extract these fields and return ONLY valid JSON in this exact structure:',
    '{',
    '  "distance": number | null,        // miles (convert if shown in km)',
    '  "duration": "string" | null,      // formatted as "m:ss" or "h:mm:ss"',
    '  "avgHR": number | null,           // average heart rate in bpm',
    '  "maxHR": number | null,           // max heart rate if shown',
    '  "elevation": number | null,       // total elevation gain in feet (convert if meters)',
    '  "avgPace": "string" | null,       // pace per mile (e.g. "8:45")',
    '  "type": "Easy" | "Long" | "Tempo" | "Intervals" | "Cross" | "Other",',
    '  "confidence": "high" | "medium" | "low"',
    '}',
    '',
    'Rules:',
    '- If a field is not visible in the screenshot, return null.',
    '- "type" should be your best guess based on distance, pace, and any title visible.',
    '- Long = >10 mi for marathon training, Tempo = sustained quick effort, Intervals = workout with reps.',
    '- Convert km to miles if needed (1 km = 0.621 mi).',
    '- Convert meters of elevation to feet if needed (1 m = 3.28 ft).',
    '- Return JSON only.'
  ].join('\n');

  var payload = {
    system_instruction: { parts: [{ text: systemPrompt }] },
    contents: [{
      role: 'user',
      parts: [
        { text: userPrompt },
        { inline_data: { mime_type: 'image/png', data: image } }
      ]
    }],
    generationConfig: {
      temperature: 0.1,
      response_mime_type: 'application/json'
    }
  };

  var url = 'https://generativelanguage.googleapis.com/v1beta/models/' + GEMINI_MODEL + ':generateContent?key=' + apiKey;
  var response = fetchGeminiWithRetry(url, payload);

  if (response.getResponseCode() !== 200) {
    return { error: 'Parse failed: ' + response.getContentText().slice(0, 300) };
  }

  var data = JSON.parse(response.getContentText());
  var text = data.candidates && data.candidates[0] && data.candidates[0].content
    ? data.candidates[0].content.parts.map(function(p) { return p.text || ''; }).join('')
    : '';

  var parsed;
  try { parsed = JSON.parse(text); } catch(e) { return { error: 'Could not parse response.' }; }
  return { success: true, data: parsed };
}

// ──────────────────────────────────────────────────
// Weekly review: assess past week's execution and
// recommend adjustments. Returns coaching JSON.
// ──────────────────────────────────────────────────
function weeklyReview(params) {
  var apiKey = PropertiesService.getScriptProperties().getProperty('GEMINI_API_KEY');
  if (!apiKey) return { error: 'GEMINI_API_KEY not set in script properties.' };

  var weekData    = params.weekData    || {};   // { week, phase, focus, totalMiles, days }
  var dayLogs     = params.dayLogs     || [];   // [{ day, plannedType, plannedMiles, status, rpe, note }]
  var wellnessAvg = params.wellnessAvg || null; // { sleep, soreness, daysLogged }
  var raceInfo    = params.raceInfo    || {};   // { name, date, distance, goalTime, weeksOut }
  var nextWeek    = params.nextWeek    || null; // { week, phase, focus, totalMiles, days }
  var recentReviews   = params.recentReviews   || []; // last 2 prior reviews
  var cumulativeStats = params.cumulativeStats || null; // overall plan stats so far
  var coachingStyle = params.coachingStyle || 'encouraging';

  var systemPrompt = [
    'You are an experienced running coach reviewing your athlete\'s past training week.',
    'Be honest. If they crushed it, say so. If they fell off, say so. No empty cheerleading.',
    'Focus on patterns over individual workouts. The point is helping next week be better.',
    'Tone: ' + (coachingStyle === 'tough-love' ? 'direct and pushy' :
                coachingStyle === 'data-driven' ? 'analytical with reasoning' :
                'warm and supportive'),
    '',
    'UNIVERSAL RULES (apply to every review):',
    '- Explain the WHY behind any adjustment.',
    '- Never shame missed workouts. Always redirect forward.',
    '- Celebrate specific wins (longest run, first tempo done, hit pace target, etc.).',
    '- Be concise — coaching, not essays.',
    '',
    'MISSED-WORKOUT RULES:',
    '- 1-2 missed sessions: skip them, do not try to make them up. Continue forward.',
    '- A full week missed (illness, travel): reduce next week by 20-30%, then resume.',
    '- NEVER prescribe make-up doubles or extra long runs to compensate.',
    '- If 3+ sessions missed in a week: that\'s a missed week — apply the full-week rule.',
    '',
    'YOU DO NOT:',
    '- Diagnose injuries. If runner notes mention sharp pain, recommend they see a PT/sports med.',
    '- Coach through worsening pain. Recommend rest and professional eval.',
    '- Increase mileage > 10% if compliance was below 80% the prior week.',
    '- Add quality sessions when wellness shows fatigue (sleep < 6 or soreness > 7).'
  ].join('\n');

  // Build the data block
  var lines = [];
  lines.push('ATHLETE CONTEXT:');
  if (raceInfo.name) lines.push('- Race: ' + raceInfo.name + (raceInfo.distance ? ' (' + raceInfo.distance + ')' : '') + (raceInfo.date ? ' on ' + raceInfo.date : ''));
  if (raceInfo.goalTime) lines.push('- Goal time: ' + raceInfo.goalTime);
  if (raceInfo.weeksOut) lines.push('- ' + raceInfo.weeksOut + ' weeks until race');
  if (weekData.phase) lines.push('- Currently in ' + weekData.phase + ' phase');
  lines.push('');

  lines.push('WEEK ' + (weekData.week || '?') + ' PLANNED:');
  lines.push('- Total: ' + (weekData.totalMiles || 0) + ' miles');
  if (weekData.focus) lines.push('- Focus: ' + weekData.focus);
  lines.push('');

  lines.push('WEEK ' + (weekData.week || '?') + ' ACTUAL EXECUTION:');
  var totalDone = 0;
  var totalPlanned = 0;
  var totalActualMi = 0;
  dayLogs.forEach(function(d) {
    var planned = d.plannedType + (d.plannedMiles ? ' ' + d.plannedMiles + ' mi' : '');
    if (d.plannedMiles && d.plannedType !== 'Rest') totalPlanned += d.plannedMiles;
    if (d.status) {
      var statusLabel = d.status.toUpperCase();
      var rpeText = d.rpe ? ', RPE ' + d.rpe + '/10' : '';
      var noteText = d.note ? ', "' + d.note + '"' : '';
      // Actual run metrics if logged
      var actualParts = [];
      if (d.actualType && d.actualType !== d.plannedType) actualParts.push(d.actualType + ' (substituted)');
      if (d.actualDistance) actualParts.push(d.actualDistance + ' mi');
      if (d.actualDuration) actualParts.push(d.actualDuration);
      if (d.actualHR) actualParts.push('HR ' + d.actualHR);
      var actualText = actualParts.length ? ', ACTUAL: ' + actualParts.join(' · ') : '';
      lines.push('- ' + d.day + ': planned ' + planned + ' → ' + statusLabel + actualText + rpeText + noteText);
      if (d.status === 'done') {
        // Use actual distance if logged, otherwise fall back to planned
        totalDone += (d.actualDistance || d.plannedMiles || 0);
        if (d.actualDistance) totalActualMi += d.actualDistance;
      }
    } else {
      lines.push('- ' + d.day + ': planned ' + planned + ' → NO LOG');
    }
  });
  var pct = totalPlanned > 0 ? Math.round((totalDone / totalPlanned) * 100) : 0;
  lines.push('');
  lines.push('TOTAL: ' + totalDone + ' of ' + totalPlanned + ' planned miles (' + pct + '%)');
  lines.push('');

  if (wellnessAvg && wellnessAvg.daysLogged > 0) {
    lines.push('WELLNESS THIS WEEK (avg of ' + wellnessAvg.daysLogged + ' days):');
    lines.push('- Sleep: ' + wellnessAvg.sleep.toFixed(1) + '/10 (1=terrible, 10=great)');
    lines.push('- Soreness: ' + wellnessAvg.soreness.toFixed(1) + '/10 (1=none, 10=very sore)');
    lines.push('');
  } else {
    lines.push('WELLNESS: not logged this week');
    lines.push('');
  }

  // Cumulative stats so far
  if (cumulativeStats) {
    lines.push('CUMULATIVE STATS (plan so far):');
    lines.push('- Weeks completed: ' + cumulativeStats.weeksCompleted);
    lines.push('- Total miles: ' + cumulativeStats.totalActualMiles + ' of ' + cumulativeStats.totalPlannedMiles + ' planned (' + cumulativeStats.overallCompliancePct + '%)');
    lines.push('- Runs completed: ' + cumulativeStats.runsCompleted + ' · Runs skipped: ' + cumulativeStats.runsSkipped);
    lines.push('');
  }

  // Prior reviews — coach memory
  if (recentReviews.length) {
    lines.push('PRIOR COACH OBSERVATIONS (last ' + recentReviews.length + ' week' + (recentReviews.length > 1 ? 's' : '') + '):');
    recentReviews.forEach(function(r) {
      lines.push('- Week ' + r.weekNumber + ' (' + (r.compliancePct || 0) + '% compliance): ' + (r.summary || ''));
      if (r.observations && r.observations.length) {
        r.observations.forEach(function(o) { lines.push('    · ' + o); });
      }
      if (r.recommendation) lines.push('    → Recommended: ' + r.recommendation);
    });
    lines.push('');
    lines.push('IMPORTANT: Look for patterns across weeks. If you see a repeated issue (e.g. "tempo always skipped 3 weeks in a row"), call it out and propose a structural fix.');
    lines.push('');
  }

  // Next week's CURRENT plan (what AI may modify)
  if (nextWeek) {
    lines.push('NEXT WEEK CURRENTLY PLANNED (Week ' + (nextWeek.week || '?') + '):');
    lines.push('- Total: ' + (nextWeek.totalMiles || 0) + ' miles');
    if (nextWeek.focus) lines.push('- Focus: ' + nextWeek.focus);
    if (nextWeek.days && nextWeek.days.length) {
      nextWeek.days.forEach(function(d) {
        lines.push('  · ' + d.day + ': ' + d.type + (d.miles ? ' ' + d.miles + ' mi' : '') + (d.note ? ' — ' + d.note : ''));
      });
    }
    lines.push('');
  }

  lines.push('Return ONLY valid JSON in this exact structure:');
  lines.push('{');
  lines.push('  "summary": "1-2 sentence honest assessment of how the week went",');
  lines.push('  "compliancePct": ' + pct + ',');
  lines.push('  "observations": [');
  lines.push('    {"icon": "✅"|"⚠️"|"💤"|"💪"|"📈"|"🎯", "text": "specific observation about this week"}');
  lines.push('  ],');
  lines.push('  "recommendation": "1-2 sentence specific direction for next week",');
  lines.push('  "proposedChanges": {');
  lines.push('    "applies": true | false,');
  lines.push('    "reasoning": "1 sentence why these specific changes",');
  lines.push('    "newTotalMiles": number,');
  lines.push('    "newFocus": "string",');
  lines.push('    "newDays": [');
  lines.push('      {"day": "Mon"|"Tue"|"Wed"|"Thu"|"Fri"|"Sat"|"Sun", "type": "Easy"|"Long"|"Tempo"|"Intervals"|"Rest"|"Cross", "miles": number, "note": "string"}');
  lines.push('    ]');
  lines.push('  }');
  lines.push('}');
  lines.push('');
  lines.push('Rules for review:');
  lines.push('- 3 to 5 observations max. Actionable, not generic.');
  lines.push('- Recommendation should be specific.');
  lines.push('');
  lines.push('Rules for proposedChanges:');
  lines.push('- Set applies=true ONLY if changes are warranted (compliance < 70%, RPE pattern high, wellness flags, or major substitutions).');
  lines.push('- If the runner executed well (compliance ≥ 80%, RPE in expected range), set applies=false. Don\'t change a working plan.');
  lines.push('- When applies=true: return ALL 7 days for next week (Mon through Sun) with the new plan.');
  lines.push('- Common adjustments: hold mileage flat (compliance < 70%), reduce 10-15% (red flags), drop a quality session (high RPE pattern).');
  lines.push('- Keep the same workout types when possible. Adjust volume more often than swap workouts.');
  lines.push('- newTotalMiles must equal the sum of newDays.miles.');
  lines.push('');
  lines.push('Return JSON only, no markdown fences.');

  var userPrompt = lines.join('\n');

  var payload = {
    system_instruction: { parts: [{ text: systemPrompt }] },
    contents: [{ role: 'user', parts: [{ text: userPrompt }] }],
    generationConfig: {
      temperature: 0.5,
      response_mime_type: 'application/json'
    }
  };

  var url = 'https://generativelanguage.googleapis.com/v1beta/models/' + GEMINI_MODEL + ':generateContent?key=' + apiKey;
  var response = fetchGeminiWithRetry(url, payload);

  if (response.getResponseCode() !== 200) {
    return { error: 'Review failed: ' + response.getContentText().slice(0, 300) };
  }

  var data = JSON.parse(response.getContentText());
  var text = data.candidates && data.candidates[0] && data.candidates[0].content
    ? data.candidates[0].content.parts.map(function(p) { return p.text || ''; }).join('')
    : '';

  var parsed;
  try { parsed = JSON.parse(text); } catch(e) { return { error: 'Could not parse review response.' }; }
  return { success: true, review: parsed };
}

// ══════════════════════════════════════════════════
// TEMPLATE & WORKOUT DATA — used to build a TARGETED prompt
// ══════════════════════════════════════════════════
//
// Instead of sending all 12 race-distance × tier templates and all 8
// named workouts on every call, we compute the runner's tier server-side
// and inject only the relevant cell + workouts. This cuts the system
// prompt by ~50-60% and saves Gemini tokens.

var RACE_TEMPLATES = {
  '5k': {
    novice: [
      'NOVICE 5K (e.g. Hal Higdon Spring Training Beginner, 8 weeks):',
      '  - Total weeks: 6-8',
      '  - Days/week: 3-4 (very flexible)',
      '  - Quality: NONE. No tempo, no intervals. Easy runs + a longer run.',
      '  - Long run progression: 2 mi → 4 mi peak',
      '  - Workouts: Easy 2-3mi, "long" 3-4mi, walk-run alternation if needed',
      '  - Goal: build the habit and finish the race upright'
    ].join('\n'),
    intermediate: [
      'INTERMEDIATE 5K (Higdon Intermediate / Daniels Beginner 5K):',
      '  - Total weeks: 8',
      '  - Days/week: 4-5',
      '  - Quality: 1 strides session/wk + 1 light interval session in build/peak (e.g. 4x400m @ 5K pace)',
      '  - Long run progression: 4 → 6 mi',
      '  - Race-pace work in peak phase only'
    ].join('\n'),
    advanced: [
      'ADVANCED 5K (Daniels 5K-15K, Tinman 5K plans):',
      '  - Total weeks: 8-12',
      '  - Days/week: 5-6',
      '  - Quality: 2 sessions/wk (intervals + tempo, alternating)',
      '  - Long run: 8 mi peak (5K is short, long runs are aerobic support)',
      '  - Race-pace specificity: 5K-pace intervals throughout peak (e.g. 5x1000m @ 5K pace, 6x800m, ladder workouts)'
    ].join('\n')
  },
  '10k': {
    novice: [
      'NOVICE 10K (Hal Higdon Novice 10K, 8 weeks):',
      '  - Total weeks: 8',
      '  - Days/week: 3-4',
      '  - Quality: NONE for first 5 weeks. Optional strides only. ZERO tempo or intervals.',
      '  - Long run progression: 3 → 6 mi',
      '  - Cross-training 1x/wk'
    ].join('\n'),
    intermediate: [
      'INTERMEDIATE 10K (Higdon Intermediate 10K):',
      '  - Total weeks: 8-10',
      '  - Days/week: 4-5',
      '  - Quality: 1 light interval or fartlek session per week starting wk 3',
      '  - Long run: 6 → 9 mi',
      '  - Light tempo work in build phase'
    ].join('\n'),
    advanced: [
      'ADVANCED 10K (Daniels 10K, Pfitzinger faster road racing):',
      '  - Total weeks: 10-12',
      '  - Days/week: 5-6',
      '  - Quality: 2 sessions/wk (threshold + VO2 max)',
      '  - Long run: 10-11 mi peak',
      '  - Race-pace specificity: 10K-pace intervals in peak (e.g. 4x1mi, 6x1k @ 10K pace)'
    ].join('\n')
  },
  'half': {
    novice: [
      'NOVICE HALF (Hal Higdon Novice 1 Half, 12 weeks):',
      '  - Total weeks: 10-12',
      '  - Days/week: 4 (3 runs + 1 cross)',
      '  - Quality: NONE. Pure easy + long progression.',
      '  - Long run progression: 4 → 10 mi (peak is below race distance — stretch happens on race day)',
      '  - Weekly structure: Mon rest, Tue easy 3, Wed easy 4, Thu easy 3, Fri rest, Sat long, Sun cross/rest'
    ].join('\n'),
    intermediate: [
      'INTERMEDIATE HALF (Higdon Intermediate Half):',
      '  - Total weeks: 12',
      '  - Days/week: 4-5',
      '  - Quality: 1 pace run/wk (3-5 mi @ HM pace) starting wk 4-5',
      '  - Long run: 6 → 12 mi, with last long run including HM-pace miles in last third',
      '  - One light tempo session per week in build phase'
    ].join('\n'),
    advanced: [
      'ADVANCED HALF (Pfitzinger Faster Road Racing HM, Daniels HM):',
      '  - Total weeks: 12-14',
      '  - Days/week: 5-6',
      '  - Quality: 2 sessions/wk (lactate threshold tempo + VO2 max intervals)',
      '  - Long run: 8 → 14 mi, multiple long runs with HM-pace blocks (e.g. 12mi w/ 6 @ HM pace)'
    ].join('\n')
  },
  'marathon': {
    novice: [
      'NOVICE MARATHON (Hal Higdon Novice 1, 18 weeks — THE canonical first-timer plan):',
      '  - Total weeks: 18',
      '  - Days/week: 4 (3 runs + 1 cross + 2 rest)',
      '  - Quality: ABSOLUTELY NONE. Zero tempo. Zero intervals. Zero hill repeats. Zero MP work in long runs.',
      '  - Long run progression: 6 → 20 mi peak (3 weeks before race), with stepback weeks every 4th',
      '  - Weekly structure example: Mon rest, Tue 3mi easy, Wed 5mi easy, Thu 3mi easy, Fri rest, Sat long, Sun cross',
      '  - Goal: finish the race uninjured. Volume is the only stimulus.',
      '  - DO NOT prescribe ANY quality work for this tier under any circumstances. The runner is at injury risk just from the volume jump.'
    ].join('\n'),
    intermediate: [
      'INTERMEDIATE MARATHON (Hal Higdon Novice 2 or Intermediate 1, 18 weeks):',
      '  - Total weeks: 18',
      '  - Days/week: 5',
      '  - Quality: 1 pace run/wk (2-5 mi @ MP) starting around wk 8. Maybe 1 light tempo every 2-3 weeks in build phase.',
      '  - Long run: 8 → 20 mi peak, with the LAST 2-3 long runs including 3-5 mi @ MP at the end',
      '  - No intervals or hill repeats — strides only for leg turnover'
    ].join('\n'),
    advanced: [
      'ADVANCED MARATHON (Pfitzinger 18/55, 18/70, 18/85; Daniels Marathon A; Hansons Advanced):',
      '  - Total weeks: 18',
      '  - Days/week: 6-7',
      '  - Quality: 2 sessions/wk in build/peak (lactate threshold tempo + MP long run; sometimes VO2 intervals)',
      '  - Long run: 10 → 22 mi, with multiple long runs containing significant MP blocks (e.g. 18mi w/ 12 @ MP, 20mi w/ 14 @ MP). Pfitzinger-style.'
    ].join('\n')
  }
};

var NAMED_WORKOUT_LIBRARY = [
  {
    name: 'Yasso 800s',
    tiers: ['advanced'],
    desc: '"Yasso 800s" (Bart Yasso, Runner\'s World): 10x800m where each rep is run in min:sec equal to your goal marathon time in hr:min (e.g. 4:00 reps for a 4-hour marathon goal). 400m jog recovery. Marathon peak phase only.'
  },
  {
    name: 'Magic Mile',
    tiers: ['intermediate', 'advanced'],
    desc: '"Magic Mile" (Jeff Galloway): 1mi all-out time trial after a 15-min warmup. Fitness benchmark every 4-6 weeks. Place sparingly.'
  },
  {
    name: 'Cruise intervals',
    tiers: ['advanced'],
    desc: '"Cruise intervals" (Jack Daniels): 4-5 x 1mi at tempo (T) pace with 60 sec jog recovery. The short recovery makes this a true threshold workout.'
  },
  {
    name: 'Michigan workout',
    tiers: ['advanced'],
    desc: '"Michigan workout" (Ron Warhurst): A ladder — 1mi @ tempo, 1200m @ 5K pace, 800m @ 3K pace, 400m all out. Tempo-paced 800m recovery jogs between reps. Sub-elite only.'
  },
  {
    name: 'Hanson long run',
    tiers: ['advanced'],
    desc: '"Hanson long run" (Hansons Marathon Method): A long run capped at 16mi but run on accumulated fatigue (no preceding rest day). Marathon build phase.'
  },
  {
    name: 'Pfitzinger long run with MP',
    tiers: ['advanced'],
    desc: '"Pfitzinger long run with MP" (Pete Pfitzinger): Long run with a marathon-pace block in the second half (e.g. "16 mi total with last 12 @ MP"). The cornerstone of Pfitzinger marathon plans.'
  },
  {
    name: 'Galloway run-walk long run',
    tiers: ['novice', 'intermediate'],
    desc: '"Galloway run-walk long run" (Jeff Galloway): Long run with structured walk breaks (e.g. run 4 min, walk 1 min). Designed for beginners and injury-prone runners. Especially useful for first-time marathoners.'
  },
  {
    name: 'Lydiard long aerobic',
    tiers: ['intermediate', 'advanced'],
    desc: '"Lydiard long aerobic" (Arthur Lydiard): Very long, very easy run at upper end of conversational pace. Builds aerobic capacity. Early base phase. Distance is determined by time on feet (90-180 min), not mileage.'
  }
];

var TIER_INFLUENCES = {
  novice: 'Hal Higdon (Novice 1, Novice 2 — predictable, volume-driven, zero-quality plans for first-timers and returning runners). Jeff Galloway (run-walk method for absolute beginners).',
  intermediate: 'Hal Higdon Intermediate plans (light pace work, MP segments). Hansons Beginner.',
  advanced: 'Pete Pfitzinger (Advanced Marathoning — MP long runs are the backbone). Jack Daniels (Daniels\' Running Formula — VDOT-based pace zones, cruise intervals, structured quality). Hansons Advanced (cumulative fatigue methodology).'
};

// Normalize race distance string from the form/lookup → template key.
function getDistanceKey(raw) {
  var s = String(raw || '').toLowerCase();
  if (s.indexOf('half') !== -1) return 'half';
  if (s.indexOf('marathon') !== -1) return 'marathon';
  if (s.indexOf('10k') !== -1 || s.indexOf('10 k') !== -1) return '10k';
  if (s.indexOf('5k') !== -1 || s.indexOf('5 k') !== -1) return '5k';
  return 'marathon'; // safest default — gets the most conservative novice template
}

// Compute tier from inputs. Mileage is the primary signal; longest recent
// run can promote (never demote). This logic mirrors the rules previously
// embedded in the prompt — moving it server-side means we don't need to
// send the inference rules to Gemini.
function inferTier(mileage, longestRecentRun) {
  var miles   = parseFloat(mileage) || 0;
  var longRun = parseFloat(longestRecentRun) || 0;

  var tier;
  if (miles >= 40) tier = 'advanced';
  else if (miles >= 20) tier = 'intermediate';
  else tier = 'novice';

  // Long run can promote one tier (a runner doing 25 mi/wk with a 16mi
  // long run is fitter than 25 mi/wk with a 5mi long run).
  if (longRun >= 15 && tier === 'intermediate') tier = 'advanced';
  if (longRun >= 9  && tier === 'novice')       tier = 'intermediate';

  return tier;
}

// Build the workout-library section text — only the workouts that are
// gated for the runner's tier. Returns empty string if no relevant
// workouts exist (rare but possible for novice 5K).
function buildWorkoutLibraryText(tier) {
  var relevant = NAMED_WORKOUT_LIBRARY.filter(function(w) {
    return w.tiers.indexOf(tier) !== -1;
  });
  if (!relevant.length) return '';
  return [
    'NAMED WORKOUTS AVAILABLE FOR THIS RUNNER (use the exact name in the workout note when prescribing one of these):',
    ''
  ].concat(relevant.map(function(w) { return '  - ' + w.desc; })).join('\n');
}

function buildSystemPrompt(style, tier, distanceKey) {
  var styleMap = {
    'encouraging': 'TONE: Warm and supportive. Celebrate progress, frame challenges as opportunities. Avoid being saccharine.',
    'data-driven': 'TONE: Analytical and precise. Reference training principles by name. Justify recommendations with physiology.',
    'tough-love':  'TONE: Direct and honest. No filler. Push the runner. Call out weaknesses without being mean.'
  };
  var voice = styleMap[style] || styleMap['encouraging'];

  // Look up the one template cell for this runner. Fall back to the
  // most conservative novice marathon if the lookup misses (defensive).
  tier = tier || 'novice';
  distanceKey = distanceKey || 'marathon';
  var templateCell = (RACE_TEMPLATES[distanceKey] && RACE_TEMPLATES[distanceKey][tier])
    || RACE_TEMPLATES.marathon.novice;
  var influenceLine = TIER_INFLUENCES[tier] || TIER_INFLUENCES.novice;
  var libraryText   = buildWorkoutLibraryText(tier);
  var tierLabel     = tier.toUpperCase();

  return [
    'You are an experienced running coach for recreational runners aged 25-35 training for specific races.',
    voice,
    '',
    'UNIVERSAL COACHING RULES (apply to every recommendation regardless of tone):',
    '- Explain the WHY for every recommendation. Educate, don\'t just prescribe.',
    '- Never shame missed workouts. Always redirect forward.',
    '- Celebrate specific milestones (PRs, first tempo done, longest run, etc.).',
    '- Be concise. Runners don\'t need essays — give clear, actionable guidance.',
    '',
    'COACHING FRAMEWORK — follow these proven principles:',
    '1. PERIODIZATION: Plans have 4 phases — Base (aerobic foundation), Build (intensity introduction), Peak (race-specific work), Taper (recovery before race). Never compress or skip phases to fit a deadline.',
    '2. PROGRESSION: Increase weekly mileage by ~10% max. Every 4th week is a recovery week (~80% of prior peak). 3 build weeks → 1 recovery week.',
    '3. LONG RUN: Builds 1-2 mi per week. Cuts back every 4th week. Marathon plans peak at 18-22 mi long run, 3 weeks before race.',
    '4. INTENSITY DISTRIBUTION: ~80% easy, ~20% quality (tempo/intervals). Easy means conversational pace — Zone 2.',
    '5. HARD/EASY ALTERNATION: Never schedule two hard sessions (Tempo, Intervals, Hill Repeats, Long) back-to-back. Always follow a hard day with Easy or Rest. Never more than 2 hard days in a row even with rest between.',
    '6. WORKOUT TYPES (use these exact labels):',
    '   - Easy: conversational pace, Zone 2, the foundation',
    '   - Long: cornerstone weekly workout, easy effort throughout',
    '   - Tempo: comfortably hard, sustained effort, builds lactate threshold',
    '   - Intervals: VO2 max work with structured recovery (e.g. 6x800m)',
    '   - Hill Repeats: short uphill efforts for power and strength (e.g. 8x60sec)',
    '   - Strides: 4-6x 20-second relaxed accelerations added to end of an easy run',
    '   - Cross: non-impact aerobic (bike, swim, elliptical)',
    '   - Rest: full rest or walking only',
    '7. TAPER: 2-3 weeks before marathon, reduce volume but maintain intensity. Race week is very light.',
    '8. BASE BUILDING: If user has many weeks before race, start with a base phase to build mileage gradually before the formal plan.',
    '9. STRENGTH SCHEDULING (when user has fixed strength days):',
    '   - The runner has FIXED strength days each week — work runs around these.',
    '   - DO NOT schedule the long run on a strength day OR the day after a strength day.',
    '   - DO NOT schedule intervals/tempo/hills on a strength day if the strength is heavy lower body.',
    '   - PREFER easy/short runs on strength days (or rest).',
    '   - The day BEFORE a long run should be rest or easy — not strength.',
    '   - When in doubt, give Rest on a strength day rather than fight for both.',
    '',
    'YOU DO NOT (hard prohibitions — never violate):',
    '- Diagnose injuries. If the runner mentions sharp/worsening pain, refer them to a PT or sports medicine professional.',
    '- Coach through sharp, worsening, or joint pain. Recommend rest and professional evaluation.',
    '- Prescribe make-up workouts (doubles, extra long runs) to compensate for missed sessions. Skip and continue forward.',
    '- Recommend extreme calorie restriction or weight loss protocols. Out of your lane.',
    '- Compress periodization to fit a tight deadline. If the timeline is too short for a safe plan, say so honestly.',
    '- Increase weekly mileage by more than 10% week-over-week.',
    '- Schedule more than 2 hard sessions per week for recreational runners.',
    (tier === 'novice' ? '- Prescribe ANY quality work (tempo, intervals, hill repeats, MP long-run blocks). This runner is NOVICE tier — volume is the only stimulus they need and quality work is the primary injury risk at this experience level. The Hal Higdon Novice 1 marathon plan includes ZERO quality sessions for a reason.' : '- Schedule more than 2 quality sessions per week.'),
    '',
    'INFLUENCES for this runner (' + tierLabel + ' tier): ' + influenceLine + ' Plus Runna for adaptive feedback.',
    '',
    'TARGET PLAN TEMPLATE — this runner is ' + tierLabel + ' tier. Use ONLY this template; do not consider other variants.',
    '',
    templateCell,
    '',
    libraryText || 'No named library workouts apply to this runner — describe quality sessions functionally without inventing brand names.',
    '',
    'PACE GUIDANCE: When goal time is given, suggest paces relative to it. ALWAYS include a 1-line "reason" explaining WHY each pace target is set:',
    '  - Easy = goal marathon pace + 60-90 sec/mi (keeps effort aerobic, where most adaptation happens)',
    '  - Long = same as easy or slightly slower (time on feet, not speed)',
    '  - Marathon pace (MP) = goal pace (race-specific rehearsal)',
    '  - Tempo = goal half-marathon pace, ~MP - 15 sec/mi for marathoners (improves lactate threshold)',
    '  - Intervals = 5K to 10K pace (improves VO2 max and running economy)',
    '',
    'WORKOUT STRUCTURE — quality sessions must have segments:',
    'Every Tempo, Intervals, Hill Repeats, and Long-with-race-pace workout MUST include a "segments" array breaking it into warmup, main, recovery (where applicable), and cooldown blocks. Easy / Rest / Cross / Strides / pure Long workouts can omit segments (use just type+miles+note).',
    '',
    'Segment schema for each segment: {part, miles, paceTarget, note?}',
    '  - part: one of ["warmup", "main", "recovery", "cooldown"]',
    '  - miles: distance for THIS segment (segments must sum to total workout miles)',
    '  - paceTarget: one of ["easy", "marathon", "tempo", "interval", "rep"] — references the paceZones above',
    '  - note (optional): specific guidance e.g. "6 reps", "90 sec jog recovery"',
    '',
    'Examples:',
    '  TEMPO 5mi: [warmup 1mi easy, main 3mi tempo, cooldown 1mi easy]',
    '  INTERVALS 5mi (6x800m): [warmup 1.5mi easy, main 3mi interval (note "6x800m @ interval pace"), recovery 0.5mi easy (note "90 sec jog between reps"), cooldown 1mi easy]',
    '  HILL REPEATS 4mi: [warmup 1mi easy, main 1.5mi rep (note "8x60sec uphill, walk down"), cooldown 1.5mi easy]',
    '  LONG 16mi WITH MP BLOCK: [warmup 2mi easy, main 4mi marathon (note "marathon pace finish"), but use 2 segments: 12mi easy + 4mi marathon]',
    '',
    'EVERY workout (with or without segments) must include "estimatedDurationMin" — the total minutes the workout will take, based on the paceZones for each segment. Round to whole minutes.',
    '',
    'INTERVAL RECOVERY — for any Intervals workout, the segment list MUST explicitly state the recovery interval (e.g. "90 sec jog" or "400m recovery jog") in the note field of the recovery segment. Never leave intervals as just "6x800m" without recovery prescription.',
    '',
    'OUTPUT RULES:',
    '- Be CONCISE. The app handles tracking; you provide the framework.',
    '- Use the runner\'s data — never give generic advice if you have actual numbers.',
    '- Generate the FULL plan from today through race week. Include base-building weeks if needed.',
    '- Each week: week number, phase label, focus (1 short sentence), totalMiles, daily workout array.',
    '- Days are Mon-Sun. Each day: type, miles, note, estimatedDurationMin, and segments (when quality).',
    '',
    'Respond in valid JSON with this exact structure:',
    '{',
    '  "raceName": "string",',
    '  "raceDate": "YYYY-MM-DD",',
    '  "totalWeeks": number,',
    '  "summary": "2-3 sentences: where they are now, what the plan does, key thing to focus on",',
    '  "paceZones": {',
    '    "easy":     {"value": "9:30-10:00/mi", "reason": "1 sentence why"},',
    '    "marathon": {"value": "8:30/mi",       "reason": "1 sentence why"},',
    '    "tempo":    {"value": "8:00/mi",       "reason": "1 sentence why"},',
    '    "interval": {"value": "7:15/mi",       "reason": "1 sentence why"}',
    '  },',
    '  "phases": [',
    '    {"name": "Base", "weeks": "1-6", "goal": "short description"},',
    '    {"name": "Build", "weeks": "7-14", "goal": "..."},',
    '    {"name": "Peak", "weeks": "15-20", "goal": "..."},',
    '    {"name": "Taper", "weeks": "21-22", "goal": "..."}',
    '  ],',
    '  "weeks": [',
    '    {',
    '      "week": 1,',
    '      "phase": "Base",',
    '      "focus": "short sentence",',
    '      "totalMiles": 20,',
    '      "days": [',
    '        {"day": "Mon", "type": "Rest", "miles": 0, "note": "Recovery", "estimatedDurationMin": 0},',
    '        {"day": "Tue", "type": "Easy", "miles": 4, "note": "Easy pace + 4 strides at end", "estimatedDurationMin": 36},',
    '        {"day": "Wed", "type": "Tempo", "miles": 5, "note": "Threshold session", "estimatedDurationMin": 47, "segments": [',
    '          {"part": "warmup",   "miles": 1, "paceTarget": "easy"},',
    '          {"part": "main",     "miles": 3, "paceTarget": "tempo", "note": "Comfortably hard, controlled"},',
    '          {"part": "cooldown", "miles": 1, "paceTarget": "easy"}',
    '        ]},',
    '        {"day": "Thu", "type": "Easy", "miles": 4, "note": "", "estimatedDurationMin": 36},',
    '        {"day": "Fri", "type": "Rest", "miles": 0, "note": "", "estimatedDurationMin": 0},',
    '        {"day": "Sat", "type": "Long", "miles": 8, "note": "Easy pace", "estimatedDurationMin": 80},',
    '        {"day": "Sun", "type": "Cross", "miles": 0, "note": "Optional cross-training", "estimatedDurationMin": 30}',
    '      ]',
    '    }',
    '  ],',
    '  "holisticGuidance": {',
    '    "recovery": "1-2 sentences specific to this plan and phase",',
    '    "strength": "1-2 sentences (reference user\'s strength schedule if any)",',
    '    "nutrition": "1-2 sentences (escalate near long runs and race week)",',
    '    "raceDay": "1-2 sentences appropriate to the current phase"',
    '  },',
    '  "currentRunAnalysis": "If screenshots provided: 2-3 sentences on what they show. If not: empty string.",',
    '  "topPriority": "ONE actionable thing to focus on this week"',
    '}'
  ].join('\n');
}

function buildUserPrompt(p) {
  var today = Utilities.formatDate(new Date(), Session.getScriptTimeZone(), 'yyyy-MM-dd');
  var lines = [
    'Today is ' + today + '.',
    '',
    'RUNNER PROFILE:',
    '  - Race: ' + p.distance + ' on ' + p.raceDate,
    p.mileage ? '  - Current weekly mileage: ' + p.mileage + ' miles/week (this is the PRIMARY tier inference signal)' : '  - Weekly mileage not provided — assume NOVICE tier',
    p.longestRecentRun ? '  - Longest recent run: ' + p.longestRecentRun + ' miles (use as a strong tier signal — a runner doing 25mi/wk with a 14mi long run is fitter than 25mi/wk with a 5mi long run)' : '  - Longest recent run: not provided',
    p.goal ? '  - Goal finish time: ' + p.goal + ' (treat as a target, NOT proof of fitness — never let the goal promote the runner to a higher tier than mileage justifies)' : '  - No goal time given — recommend a realistic target based on inferred fitness',
    p.daysPerWeek ? '  - Days per week available: ' + p.daysPerWeek + ' (HARD CONSTRAINT — the plan must fit within this many running days, no more)' : '  - Days per week: not specified, default to 4-5',
    p.longRunDay ? '  - Long run preferred day: ' + p.longRunDay + ' (place the long run on this day each week unless a strength session conflicts)' : '  - Long run day: default to Saturday',
    p.injuryNotes ? '  - Current injuries / limitations: ' + p.injuryNotes + ' (work around these — if the note suggests a specific area is at risk, soften the plan in that area; never coach through pain)' : '',
    p.screenshotCount > 0
      ? '  - I have attached ' + p.screenshotCount + ' Strava screenshot(s) of recent runs. Use them to verify my self-reported fitness and detect anything I missed.'
      : '  - No run screenshots attached.'
  ].filter(function(l) { return l.length > 0; });

  // Strength schedule constraint
  if (p.strengthSchedule && p.strengthSchedule.length) {
    lines.push('');
    lines.push('STRENGTH CONSTRAINT — these are FIXED weekly strength sessions I cannot change. Build the running plan around them:');
    p.strengthSchedule.forEach(function(s) {
      lines.push('  - ' + s.day + (s.time ? ' at ' + s.time : '') + (s.label ? ' (' + s.label + ')' : ''));
    });
    lines.push('Apply the strength scheduling rules from the system prompt: no long run on or after strength days, prefer easy/rest on strength days, etc.');
  } else {
    lines.push('');
    lines.push('No strength schedule — you can place runs on any day (subject to the days-per-week constraint above).');
  }

  lines.push('');
  lines.push('Build a complete training plan from today through race week using the TARGET PLAN TEMPLATE in the system prompt. Include a base-building phase if there is enough time.');
  lines.push('If my goal time implies a fitness level beyond what my mileage supports, note in the plan summary that the goal may need to be revisited — do not promote me to a harder template.');
  lines.push('Return only the JSON. Be concise — focus on structure, not motivational text.');
  return lines.join('\n');
}
