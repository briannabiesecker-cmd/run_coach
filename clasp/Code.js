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

function doGet(e) {
  var callback = e.parameter.callback || 'callback';
  var action   = e.parameter.action || '';
  var result;

  try {
    if (action === 'ping') {
      result = { ok: true, version: 'v1', ts: new Date().toISOString() };
    } else if (action === 'coach') {
      result = coach(e.parameter);
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

  var raceDate      = params.raceDate || '';
  var raceDistance  = params.raceDistance || '';
  var weeklyMileage = params.weeklyMileage || '';
  var goalTime      = params.goalTime || '';
  var coachingStyle = params.coachingStyle || 'encouraging';
  var screenshots   = (params.screenshotBase64 || '').split(',,,').filter(function(s) { return s.length > 0; });

  if (!raceDate || !raceDistance) {
    return { error: 'raceDate and raceDistance are required.' };
  }

  // Build prompt
  var systemPrompt = buildSystemPrompt(coachingStyle);
  var userPrompt   = buildUserPrompt(raceDate, raceDistance, weeklyMileage, goalTime, screenshots.length);

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
      response_mime_type: 'application/json'
    }
  };

  var url = 'https://generativelanguage.googleapis.com/v1beta/models/' + GEMINI_MODEL + ':generateContent?key=' + apiKey;
  var response = UrlFetchApp.fetch(url, {
    method: 'post',
    contentType: 'application/json',
    payload: JSON.stringify(payload),
    muteHttpExceptions: true
  });

  var code = response.getResponseCode();
  if (code !== 200) {
    return { error: 'Gemini API error (' + code + '): ' + response.getContentText().slice(0, 500) };
  }

  var data = JSON.parse(response.getContentText());
  var text = data.candidates && data.candidates[0] && data.candidates[0].content
    ? data.candidates[0].content.parts.map(function(p) { return p.text || ''; }).join('')
    : '';

  // Gemini returns JSON-as-string when response_mime_type=application/json
  var parsed;
  try { parsed = JSON.parse(text); } catch(e) { parsed = { raw: text }; }

  return { success: true, result: parsed };
}

function buildSystemPrompt(style) {
  var styleMap = {
    'encouraging': 'You are a warm, supportive running coach who celebrates small wins and frames challenges positively.',
    'data-driven': 'You are an analytical running coach who explains the science and uses metrics to back every recommendation.',
    'tough-love':  'You are a no-nonsense running coach who pushes runners to their potential with direct, honest feedback.'
  };
  var voice = styleMap[style] || styleMap['encouraging'];

  return voice + '\n\n' +
    'You help recreational runners aged 25–35 train for specific races. ' +
    'Always respond in valid JSON with this exact structure:\n' +
    '{\n' +
    '  "summary": "1-2 sentence overall assessment",\n' +
    '  "trainingPlan": [{"week": 1, "focus": "...", "keyWorkouts": ["..."], "totalMiles": 20}],\n' +
    '  "recentRunAnalysis": "what the screenshots show about the runner",\n' +
    '  "topRecommendation": "the single most important thing to focus on next"\n' +
    '}';
}

function buildUserPrompt(raceDate, distance, mileage, goal, screenshotCount) {
  var lines = [
    'I am training for a ' + distance + ' on ' + raceDate + '.',
    mileage ? 'Current weekly mileage: ' + mileage + ' miles.' : '',
    goal ? 'Goal finish time: ' + goal + '.' : '',
    screenshotCount > 0
      ? 'I have attached ' + screenshotCount + ' screenshot(s) of recent runs from Strava. Analyze them.'
      : 'No recent run data attached yet.',
    '',
    'Please return a training plan and coaching feedback in the JSON format specified.'
  ];
  return lines.filter(function(l) { return l.length > 0; }).join('\n');
}
