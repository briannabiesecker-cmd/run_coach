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

  // Build prompt
  var systemPrompt = buildSystemPrompt(coachingStyle);
  var userPrompt   = buildUserPrompt(raceDate, raceDistance, weeklyMileage, goalTime, screenshots.length, strengthSchedule);

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
  var response = UrlFetchApp.fetch(url, {
    method: 'post',
    contentType: 'application/json',
    payload: JSON.stringify(payload),
    muteHttpExceptions: true
  });

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
  var response = UrlFetchApp.fetch(url, {
    method: 'post',
    contentType: 'application/json',
    payload: JSON.stringify(payload),
    muteHttpExceptions: true
  });

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
  var response = UrlFetchApp.fetch(url, {
    method: 'post',
    contentType: 'application/json',
    payload: JSON.stringify(payload),
    muteHttpExceptions: true
  });

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

function buildSystemPrompt(style) {
  var styleMap = {
    'encouraging': 'TONE: Warm and supportive. Celebrate progress, frame challenges as opportunities. Avoid being saccharine.',
    'data-driven': 'TONE: Analytical and precise. Reference training principles by name. Justify recommendations with physiology.',
    'tough-love':  'TONE: Direct and honest. No filler. Push the runner. Call out weaknesses without being mean.'
  };
  var voice = styleMap[style] || styleMap['encouraging'];

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
    '',
    'INFLUENCES: Hal Higdon (predictable structure), Pfitzinger (marathon-pace work), Daniels (pace zones), Runna (adaptive feedback).',
    '',
    'RACE-DISTANCE TEMPLATES — match the plan structure to the race distance. Do not generate a generic plan; pick the template that fits.',
    '',
    '  5K (3.1 mi):',
    '    - Total weeks: 6-8 ideal',
    '    - Phase split: Base ~30%, Build ~35%, Peak ~25%, Taper ~10%',
    '    - Long run progression: peak at 6-8 mi (NEVER more — 5K is short, long runs serve as endurance support only)',
    '    - Quality emphasis: VO2 max work (intervals), strides, race-pace work',
    '    - Race-pace specificity: Peak phase should include 5K-pace intervals (e.g. 5x1000m @ 5K pace)',
    '    - Weekly structure example (4-5 day plan): Long, Intervals, Easy, Tempo or Strides, Easy/Rest',
    '',
    '  10K (6.2 mi):',
    '    - Total weeks: 8-10 ideal',
    '    - Phase split: Base ~30%, Build ~35%, Peak ~25%, Taper ~10%',
    '    - Long run progression: peak at 9-11 mi',
    '    - Quality emphasis: Threshold (tempo) heavy, plus VO2 max',
    '    - Race-pace specificity: Peak phase includes 10K-pace work (e.g. 4x1mi @ 10K pace)',
    '',
    '  Half Marathon (13.1 mi):',
    '    - Total weeks: 10-14 ideal',
    '    - Phase split: Base ~35%, Build ~30%, Peak ~25%, Taper ~10%',
    '    - Long run progression: peak at 12-14 mi',
    '    - Quality emphasis: Tempo / threshold work is the cornerstone (HM = threshold race)',
    '    - Race-pace specificity: Late in build, include long runs with HM-pace miles (e.g. 10mi long with last 4 @ HM pace)',
    '',
    '  Marathon (26.2 mi):',
    '    - Total weeks: 16-20 ideal (12 minimum)',
    '    - Phase split: Base ~40%, Build ~30%, Peak ~20%, Taper ~10%',
    '    - Long run progression: peak at 18-22 mi, 3 weeks before race',
    '    - Quality emphasis: Marathon pace work is THE key. Tempo for threshold. Some intervals for economy.',
    '    - Race-pace specificity: Multiple long runs in peak phase MUST include marathon-pace miles (e.g. 16mi with last 6 @ MP, 20mi with middle 8 @ MP). This is non-negotiable for marathon plans.',
    '',
    'WORKOUT LIBRARY — prefer these named, well-known sessions when generating quality days. Naming workouts gives runners confidence and consistency:',
    '  - "Yasso 800s": 10x800m @ goal-marathon-time-as-minutes (e.g. 4:00 800s for 4hr marathon goal). Use in marathon plans.',
    '  - "Mile repeats": 3-5x1mi @ tempo or 10K pace, 90 sec jog recovery. Versatile.',
    '  - "Cruise intervals": 4-5x1mi @ tempo pace, 60 sec jog. Threshold builder.',
    '  - "Magic Mile": 1mi all-out time trial as a fitness benchmark. Use sparingly (every 4-6 weeks).',
    '  - "Fartlek 1-2-3": Alternating 1/2/3 min hard with equal easy. Unstructured speed for base phase.',
    '  - "Hill 8x60": 8 reps of 60-sec hard uphill, walk-down recovery. Power + form.',
    '  - "Progression run": Easy first half, tempo second half. Gentle quality.',
    '  - "Marathon simulation": Long run with 60-80% at marathon pace. Race rehearsal.',
    '  - "Cutdown": Last mile of an easy run progressively faster. Strider replacement.',
    'When you reference one of these, put the name in the workout note (e.g. note: "Yasso 800s — 8 reps").',
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

function buildUserPrompt(raceDate, distance, mileage, goal, screenshotCount, strengthSchedule) {
  var today = Utilities.formatDate(new Date(), Session.getScriptTimeZone(), 'yyyy-MM-dd');
  var lines = [
    'Today is ' + today + '.',
    'Race: ' + distance + ' on ' + raceDate + '.',
    mileage ? 'Current weekly mileage: ' + mileage + ' miles per week.' : 'Weekly mileage not provided — assume beginner.',
    goal ? 'Goal finish time: ' + goal + '.' : 'No goal time given — recommend a realistic target.',
    screenshotCount > 0
      ? 'I have attached ' + screenshotCount + ' Strava screenshot(s) of recent runs. Use them to assess my current fitness, pace, and patterns.'
      : 'No run data attached.'
  ];

  // Strength schedule constraint
  if (strengthSchedule && strengthSchedule.length) {
    lines.push('');
    lines.push('STRENGTH CONSTRAINT — these are FIXED weekly strength sessions I cannot change. Build the running plan around them:');
    strengthSchedule.forEach(function(s) {
      lines.push('  - ' + s.day + (s.time ? ' at ' + s.time : '') + (s.label ? ' (' + s.label + ')' : ''));
    });
    lines.push('Apply the strength scheduling rules from the system prompt: no long run on or after strength days, prefer easy/rest on strength days, etc.');
  } else {
    lines.push('No strength schedule — you can place runs on any day.');
  }

  lines.push('');
  lines.push('Build a complete training plan from today through race week. Include a base-building phase if there is enough time.');
  lines.push('Return only the JSON. Be concise — focus on structure, not motivational text.');
  return lines.filter(function(l) { return l.length > 0 || true; }).join('\n');
}
