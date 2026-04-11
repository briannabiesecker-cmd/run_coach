// ══════════════════════════════════════════════════
// STRAVA — OAuth + activity sync
// ══════════════════════════════════════════════════
//
// OAuth flow:
//   1. Frontend calls GET ?action=stravaAuthUrl → returns the Strava authorize URL
//   2. User approves on Strava → redirects to GET ?action=stravaCallback
//   3. Apps Script exchanges code for tokens, stores server-side
//   4. Redirects user back to the app
//
// Sync flow:
//   1. Frontend calls POST action=stravaSync
//   2. Apps Script reads token, refreshes if expired
//   3. Fetches recent activities from Strava API
//   4. Extracts ONLY summary metrics (no GPS, no polylines)
//   5. Returns activities to frontend
//
// Privacy: tokens stored in Script Properties only, never sent to browser.
// GPS data (polylines, streams) is never requested or extracted.

var STRAVA_AUTH_URL   = 'https://www.strava.com/oauth/authorize';
var STRAVA_TOKEN_URL  = 'https://www.strava.com/oauth/token';
var STRAVA_API_BASE   = 'https://www.strava.com/api/v3';
var METERS_TO_MILES   = 0.000621371;

/**
 * Build the Strava OAuth authorize URL for a user.
 * The callback URL is this script's web app URL with action=stravaCallback.
 *
 * @param {string} userName
 * @param {string} passcode - for verification on callback
 * @return {{success: true, url: string} | {error: string}}
 */
function getStravaAuthUrl(userName, passcode) {
  var props = PropertiesService.getScriptProperties();
  var clientId = props.getProperty('STRAVA_CLIENT_ID');
  if (!clientId) return { error: 'STRAVA_CLIENT_ID not configured in Script Properties.' };

  // Build callback URL — the deployed web app URL
  var scriptUrl = ScriptApp.getService().getUrl();
  var redirectUri = scriptUrl;

  // State encodes userName + passcode for verification on callback
  var state = encodeURIComponent(userName) + '::' + encodeURIComponent(passcode);

  var url = STRAVA_AUTH_URL +
    '?client_id=' + clientId +
    '&response_type=code' +
    '&redirect_uri=' + encodeURIComponent(redirectUri) +
    '&approval_prompt=auto' +
    '&scope=activity:read_all' +
    '&state=' + encodeURIComponent(state);

  return { success: true, url: url };
}

/**
 * Handle the OAuth callback from Strava. Exchanges the authorization code
 * for access + refresh tokens and stores them in Script Properties.
 *
 * Called as a GET request: ?action=stravaCallback&code=XXX&state=userName::passcode
 *
 * @param {Object} params - { code, state }
 * @return {GoogleAppsScript.Content.TextOutput} HTML redirect back to app
 */
function handleStravaCallback(params) {
  var code  = params.code  || '';
  var state = params.state || '';

  if (!code) {
    return HtmlService.createHtmlOutput('<h2>Strava connection failed</h2><p>No authorization code received.</p>');
  }

  // Parse state to get userName
  var parts = decodeURIComponent(state).split('::');
  var userName = parts[0] || '';
  var passcode = parts[1] || '';

  if (!userName) {
    return HtmlService.createHtmlOutput('<h2>Strava connection failed</h2><p>Missing user identity.</p>');
  }

  // Verify passcode
  var auth = checkPasscode(passcode);
  if (!auth.ok) {
    return HtmlService.createHtmlOutput('<h2>Strava connection failed</h2><p>Invalid passcode.</p>');
  }

  var props = PropertiesService.getScriptProperties();
  var clientId     = props.getProperty('STRAVA_CLIENT_ID');
  var clientSecret = props.getProperty('STRAVA_CLIENT_SECRET');

  if (!clientId || !clientSecret) {
    return HtmlService.createHtmlOutput('<h2>Strava connection failed</h2><p>API credentials not configured.</p>');
  }

  // Exchange authorization code for tokens
  var response = UrlFetchApp.fetch(STRAVA_TOKEN_URL, {
    method: 'post',
    payload: {
      client_id: clientId,
      client_secret: clientSecret,
      code: code,
      grant_type: 'authorization_code'
    },
    muteHttpExceptions: true
  });

  if (response.getResponseCode() !== 200) {
    return HtmlService.createHtmlOutput('<h2>Strava connection failed</h2><p>Token exchange error: ' + response.getContentText().slice(0, 200) + '</p>');
  }

  var tokenData = JSON.parse(response.getContentText());

  // Store tokens server-side only
  var tokenKey = 'STRAVA_TOKEN_' + userName.toLowerCase();
  props.setProperty(tokenKey, JSON.stringify({
    access_token:  tokenData.access_token,
    refresh_token: tokenData.refresh_token,
    expires_at:    tokenData.expires_at,
    athlete_id:    tokenData.athlete && tokenData.athlete.id
  }));

  // Redirect back to the app
  var appUrl = 'https://briannabiesecker-cmd.github.io/run_coach/?stravaConnected=1';
  return HtmlService.createHtmlOutput(
    '<html><head><meta http-equiv="refresh" content="0;url=' + appUrl + '"></head>' +
    '<body><p>Strava connected! Redirecting...</p></body></html>'
  );
}

/**
 * Refresh the Strava access token if expired.
 *
 * @param {string} userName
 * @return {string|null} Valid access token, or null on failure
 */
function refreshStravaToken(userName) {
  var props = PropertiesService.getScriptProperties();
  var tokenKey = 'STRAVA_TOKEN_' + userName.toLowerCase();
  var raw = props.getProperty(tokenKey);
  if (!raw) return null;

  var tokens = JSON.parse(raw);
  var now = Math.floor(Date.now() / 1000);

  // If token hasn't expired yet, return it
  if (tokens.expires_at && tokens.expires_at > now + 60) {
    return tokens.access_token;
  }

  // Refresh the token
  var clientId     = props.getProperty('STRAVA_CLIENT_ID');
  var clientSecret = props.getProperty('STRAVA_CLIENT_SECRET');

  var response = UrlFetchApp.fetch(STRAVA_TOKEN_URL, {
    method: 'post',
    payload: {
      client_id: clientId,
      client_secret: clientSecret,
      grant_type: 'refresh_token',
      refresh_token: tokens.refresh_token
    },
    muteHttpExceptions: true
  });

  if (response.getResponseCode() !== 200) return null;

  var newTokens = JSON.parse(response.getContentText());
  tokens.access_token  = newTokens.access_token;
  tokens.refresh_token = newTokens.refresh_token;
  tokens.expires_at    = newTokens.expires_at;
  props.setProperty(tokenKey, JSON.stringify(tokens));

  return tokens.access_token;
}

/**
 * Check if a user has connected Strava.
 *
 * @param {string} userName
 * @return {{connected: boolean}}
 */
function isStravaConnected(userName) {
  var props = PropertiesService.getScriptProperties();
  var tokenKey = 'STRAVA_TOKEN_' + userName.toLowerCase();
  return { connected: !!props.getProperty(tokenKey) };
}

/**
 * Fetch recent activities from Strava and return summary metrics only.
 * NO GPS data, NO polylines, NO streams — privacy rule.
 *
 * @param {Object} params - { userName, days (default 30) }
 * @return {{success: true, activities: Array} | {error: string}}
 */
function stravaSync(params) {
  var userName = params.userName || '';
  var days = parseInt(params.days) || 30;

  if (!userName) return { error: 'userName is required' };

  var accessToken = refreshStravaToken(userName);
  if (!accessToken) return { error: 'Strava not connected or token refresh failed. Please reconnect.' };

  var after = Math.floor(Date.now() / 1000) - (days * 86400);
  var url = STRAVA_API_BASE + '/athlete/activities?after=' + after + '&per_page=100';

  var response = UrlFetchApp.fetch(url, {
    headers: { 'Authorization': 'Bearer ' + accessToken },
    muteHttpExceptions: true
  });

  if (response.getResponseCode() === 401) {
    return { error: 'Strava authorization expired. Please reconnect.' };
  }
  if (response.getResponseCode() !== 200) {
    return { error: 'Strava API error: ' + response.getContentText().slice(0, 200) };
  }

  var rawActivities = JSON.parse(response.getContentText());

  // Extract ONLY summary metrics — no GPS, no polylines, no map data
  var activities = rawActivities
    .filter(function(a) { return a.type === 'Run' || a.type === 'Walk' || a.type === 'Hike'; })
    .map(function(a) {
      var distMi = Math.round(a.distance * METERS_TO_MILES * 100) / 100;
      var durSec = a.moving_time || a.elapsed_time || 0;
      var durMin = Math.floor(durSec / 60);
      var durS   = durSec % 60;
      var duration = durMin + ':' + (durS < 10 ? '0' : '') + durS;
      var paceSecPerMi = distMi > 0 ? durSec / distMi : 0;
      var paceMin = Math.floor(paceSecPerMi / 60);
      var paceSec = Math.round(paceSecPerMi % 60);
      var pace = paceMin + ':' + (paceSec < 10 ? '0' : '') + paceSec;

      return {
        id:          a.id,
        name:        a.name,
        type:        a.type,
        date:        a.start_date_local ? a.start_date_local.slice(0, 10) : '',
        distance:    distMi,
        duration:    duration,
        durationSec: durSec,
        pace:        pace + '/mi',
        avgHR:       a.average_heartrate || null,
        maxHR:       a.max_heartrate || null,
        elevation:   a.total_elevation_gain ? Math.round(a.total_elevation_gain * 3.28084) : null,
        calories:    a.calories || null
        // Deliberately omitting: map, polyline, start_latlng, end_latlng, streams
      };
    });

  return { success: true, activities: activities, count: activities.length };
}

/**
 * Disconnect Strava for a user — removes stored tokens.
 *
 * @param {string} userName
 * @return {{success: true}}
 */
function stravaDisconnect(userName) {
  var props = PropertiesService.getScriptProperties();
  var tokenKey = 'STRAVA_TOKEN_' + userName.toLowerCase();
  props.deleteProperty(tokenKey);
  return { success: true };
}
