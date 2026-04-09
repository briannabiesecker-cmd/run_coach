// ══════════════════════════════════════════════════
// GEMINI CLIENT — single point of contact with the Gemini API
// ══════════════════════════════════════════════════
//
// All Gemini calls (coach, lookupRace, parseRunScreenshot, weeklyReview)
// route through fetchGeminiWithRetry. This wrapper handles two distinct
// transient failure modes from Google's free tier:
//
//   503 UNAVAILABLE — model overloaded ("high demand")
//                     → exponential backoff (2s, 4s, 8s)
//
//   429 RESOURCE_EXHAUSTED — per-minute rate limit hit. Response body
//                            includes "Please retry in X.Xs" hint.
//                            We parse it, wait + 500ms buffer, retry.
//                            If suggested wait > GEMINI_RETRY_MAX_WAIT_MS
//                            it's the DAILY quota — surface immediately.
//
//   500 — generic server error, treated like 503.
//
// Every successful retry attempt counts toward the daily quota, so we
// also call trackGeminiCall() on every fetch attempt to keep the
// quota counter accurate. See 13_Diagnostics.js for the counter.

function fetchGeminiWithRetry(url, payload) {
  var lastResponse = null;
  for (var attempt = 1; attempt <= GEMINI_RETRY_MAX_ATTEMPTS; attempt++) {
    trackGeminiCall(); // increment daily quota counter
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
    if (attempt >= GEMINI_RETRY_MAX_ATTEMPTS) break;

    // Decide how long to wait before the next attempt
    var sleepMs;
    if (code === 429) {
      var body = response.getContentText();
      var match = body.match(/retry in ([\d.]+)s/i);
      if (match) {
        sleepMs = Math.ceil(parseFloat(match[1]) * 1000) + 500;
        if (sleepMs > GEMINI_RETRY_MAX_WAIT_MS) return response;
      } else {
        sleepMs = 5000;
      }
    } else {
      sleepMs = Math.pow(2, attempt) * 1000;
    }
    Utilities.sleep(sleepMs);
  }
  return lastResponse;
}

// Build the Gemini generateContent URL with the API key from script
// properties. Returns null if the key isn't set so callers can return
// a clean error.
function buildGeminiUrl() {
  var apiKey = PropertiesService.getScriptProperties().getProperty('GEMINI_API_KEY');
  if (!apiKey) return null;
  return GEMINI_API_BASE + GEMINI_MODEL + ':generateContent?key=' + apiKey;
}
