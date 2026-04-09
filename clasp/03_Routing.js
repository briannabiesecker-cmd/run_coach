// ══════════════════════════════════════════════════
// ROUTING — doGet / doPost action dispatch
// ══════════════════════════════════════════════════
//
// Apps Script web app entry points. Two HTTP verbs:
//
//   doGet  — used for: ping (no auth), verifyPasscode, coach,
//            quotaUsed (used by frontend boot to show quota status).
//            Returns JSONP wrapped in callback() — required because
//            Apps Script web apps don't support CORS.
//
//   doPost — used for everything that has a large body or doesn't fit
//            in a query string. Body is JSON-encoded as text/plain to
//            avoid CORS preflight (Apps Script also doesn't accept
//            application/json POST without CORS).
//
// All actions except 'ping' and 'quotaUsed' require the passcode.
// Action handlers live in their own files (Coach.js, Storage.js, etc.).

function doGet(e) {
  var callback = e.parameter.callback || 'callback';
  var action = e.parameter.action || '';
  var result;

  try {
    if (action === 'ping') {
      result = { ok: true, version: BACKEND_VERSION, ts: new Date().toISOString() };
    } else if (action === 'quotaUsed') {
      result = getQuotaUsed();
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

function doPost(e) {
  var result;
  try {
    var body = JSON.parse(e.postData.contents || '{}');
    var action = body.action || '';

    // Auth: every POST action requires the passcode (no public POSTs).
    if (action !== 'verifyPasscode') {
      var auth = checkPasscode(body.passcode);
      if (!auth.ok) {
        return ContentService
          .createTextOutput(JSON.stringify({ error: auth.error }))
          .setMimeType(ContentService.MimeType.JSON);
      }
    }

    if      (action === 'verifyPasscode')     result = checkPasscode(body.passcode);
    else if (action === 'coach')              result = coach(body);
    else if (action === 'lookupRace')         result = lookupRace(body);
    else if (action === 'weeklyReview')       result = weeklyReview(body);
    else if (action === 'parseRunScreenshot') result = parseRunScreenshot(body);
    else if (action === 'loadUserData')       result = loadUserData(body);
    else if (action === 'saveUserData')       result = saveUserData(body);
    else                                       result = { error: 'Unknown action: ' + action };
  } catch (err) {
    result = { error: err.message || String(err) };
  }

  return ContentService
    .createTextOutput(JSON.stringify(result))
    .setMimeType(ContentService.MimeType.JSON);
}
