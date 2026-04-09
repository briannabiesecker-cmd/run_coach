// ══════════════════════════════════════════════════
// ROUTING — doGet / doPost action dispatch + rate limiting
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
//
// Rate limiting: every authed action passes through checkRateLimit()
// using CacheService as a sliding-window counter. Default is 60 calls
// per 60 seconds per identity. The identity is the userName when
// available (most actions have it), otherwise a hash of the passcode
// so we never store the passcode itself in cache.

// Sliding-window rate limiter using CacheService. Returns true if
// the call is allowed, false if exceeded. Per-identity counter
// auto-expires after RATE_LIMIT_WINDOW_SEC.
function checkRateLimit(identity) {
  if (!identity) return true; // can't rate limit anonymous — fail open
  var cache = CacheService.getScriptCache();
  var key = 'rl_' + identity;
  var current = parseInt(cache.get(key) || '0', 10);
  if (current >= RATE_LIMIT_MAX_CALLS) return false;
  cache.put(key, String(current + 1), RATE_LIMIT_WINDOW_SEC);
  return true;
}

// Derive a stable identity from the request body for rate limiting.
// Prefer userName (lowercased) since most calls have it. Fall back to
// a SHA-256 hash of the passcode so we never use the raw passcode as
// a cache key (defense in depth — the cache is per-script and
// shouldn't see secrets).
function rateLimitIdentity(body) {
  if (body && body.userName) return 'user:' + String(body.userName).toLowerCase();
  if (body && body.passcode) {
    var bytes = Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, body.passcode);
    var hex = bytes.map(function(b) {
      return ('0' + (b < 0 ? b + 256 : b).toString(16)).slice(-2);
    }).join('');
    return 'pc:' + hex.slice(0, 16);
  }
  return null;
}

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
  var startMs = Date.now();
  var action = '';
  var identity = '';
  try {
    var body = JSON.parse(e.postData.contents || '{}');
    action = body.action || '';

    // Auth: every POST action requires the passcode (no public POSTs).
    if (action !== 'verifyPasscode') {
      var auth = checkPasscode(body.passcode);
      if (!auth.ok) {
        logActivity(action, 'unknown', 'auth_fail', Date.now() - startMs, auth.error);
        return ContentService
          .createTextOutput(JSON.stringify({ error: auth.error }))
          .setMimeType(ContentService.MimeType.JSON);
      }
    }

    // Rate limit: applied AFTER auth (so unauthed callers can't burn
    // through the limit on a victim's identity). 60 calls/min per user.
    identity = rateLimitIdentity(body) || '';
    if (!checkRateLimit(identity)) {
      logActivity(action, identity, 'rate_limited', Date.now() - startMs, '');
      return ContentService
        .createTextOutput(JSON.stringify({
          error: 'Rate limit exceeded (' + RATE_LIMIT_MAX_CALLS + '/' + RATE_LIMIT_WINDOW_SEC + 's). Slow down.'
        }))
        .setMimeType(ContentService.MimeType.JSON);
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

  // Log every call (success or error). Best-effort, never blocks
  // the response. Note: logged data is metadata only — no payload
  // contents, no PII, no secrets.
  var status = (result && result.error) ? 'error' : 'ok';
  var note = (result && result.error) ? String(result.error).slice(0, 200) : '';
  logActivity(action, identity, status, Date.now() - startMs, note);

  return ContentService
    .createTextOutput(JSON.stringify(result))
    .setMimeType(ContentService.MimeType.JSON);
}
