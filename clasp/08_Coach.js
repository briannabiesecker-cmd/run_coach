// ══════════════════════════════════════════════════
// COACH — generate a full training plan from the runner's profile
// ══════════════════════════════════════════════════
//
// Inputs (params):
//   raceDate          "YYYY-MM-DD"
//   raceDistance      "5K"|"10K"|"Half Marathon"|"Marathon"
//   weeklyMileage     current weekly miles (PRIMARY tier signal)
//   longestRecentRun  longest recent run mi (secondary tier signal)
//   goalTime          target finish time
//   daysPerWeek       3-7 (HARD constraint)
//   longRunDay        preferred long run day
//   injuryNotes       free text
//   coachingStyle     'encouraging' | 'data-driven' | 'tough-love'
//   strengthSchedule  [{day, time, label}]
//   screenshots       array of base64 PNG (or screenshotBase64 string)
//
// Tier is computed server-side via inferTier() so we send only the
// relevant template + workout library, not all 12 cells.

/**
 * Generate a complete training plan via Gemini. Computes runner tier
 * server-side, builds a targeted prompt (only 1 template cell, not 12),
 * sends to Gemini with screenshots if provided, validates the response
 * structure before returning.
 *
 * @param {Object} params
 * @param {string} params.raceDate - "YYYY-MM-DD"
 * @param {string} params.raceDistance - "5K"|"10K"|"Half Marathon"|"Marathon"
 * @param {string} [params.weeklyMileage] - PRIMARY tier signal
 * @param {string} [params.longestRecentRun] - Secondary tier signal
 * @param {string} [params.goalTime] - Target finish time (NOT a tier promoter)
 * @param {string} [params.daysPerWeek] - HARD constraint, 3-7
 * @param {string} [params.longRunDay] - Preferred long run day
 * @param {string} [params.injuryNotes] - Free text limitations
 * @param {string} [params.coachingStyle='encouraging']
 * @param {Array<{day:string,time:string,label:string}>} [params.strengthSchedule]
 * @param {string[]} [params.screenshots] - Base64-encoded PNGs
 * @return {{success: true, result: Object} | {error: string}}
 */
function coach(params) {
  var url = buildGeminiUrl();
  if (!url) return { error: 'GEMINI_API_KEY not set in script properties.' };

  var raceDate         = params.raceDate || '';
  var raceDistance     = params.raceDistance || '';
  var weeklyMileage    = params.weeklyMileage || '';
  var goalTime         = params.goalTime || '';
  var coachingStyle    = params.coachingStyle || 'encouraging';
  var longestRecentRun = params.longestRecentRun || '';
  var daysPerWeek      = params.daysPerWeek || '';
  var longRunDay       = params.longRunDay || '';
  var injuryNotes      = params.injuryNotes || '';
  var strengthSchedule = Array.isArray(params.strengthSchedule) ? params.strengthSchedule : [];
  var screenshots;
  if (Array.isArray(params.screenshots)) {
    screenshots = params.screenshots;
  } else {
    screenshots = (params.screenshotBase64 || '').split(',,,').filter(function(s) { return s.length > 0; });
  }

  if (!raceDate || !raceDistance) {
    return { error: 'raceDate and raceDistance are required.' };
  }

  // Compute tier server-side so the prompt only ships the relevant cell
  var tier        = inferTier(weeklyMileage, longestRecentRun);
  var distanceKey = getDistanceKey(raceDistance);

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

  var parts = [{ text: userPrompt }];
  screenshots.forEach(function(b64) {
    parts.push({ inline_data: { mime_type: 'image/png', data: b64 } });
  });

  var payload = {
    system_instruction: { parts: [{ text: systemPrompt }] },
    contents: [{ role: 'user', parts: parts }],
    generationConfig: {
      temperature: 0.7,
      response_mime_type: 'application/json',
      maxOutputTokens: GEMINI_MAX_OUTPUT_TOKENS
    }
  };

  var response = fetchGeminiWithRetry(url, payload);
  var code = response.getResponseCode();
  if (code !== 200) {
    return { error: 'Gemini API error (' + code + '): ' + response.getContentText().slice(0, 500) };
  }

  var data = JSON.parse(response.getContentText());
  var text = data.candidates && data.candidates[0] && data.candidates[0].content
    ? data.candidates[0].content.parts.map(function(p) { return p.text || ''; }).join('')
    : '';

  // Detect truncation: Gemini sets finishReason="MAX_TOKENS" when cut off
  var finishReason = (data.candidates && data.candidates[0] && data.candidates[0].finishReason) || '';
  if (finishReason === 'MAX_TOKENS') {
    return { error: 'Plan was too long and got truncated by Gemini. Try a shorter race timeline or fewer weeks.' };
  }

  var parsed;
  try {
    parsed = JSON.parse(text);
  } catch(e) {
    return { error: 'Gemini returned malformed JSON: ' + String(e).slice(0, 200) + ' — first 200 chars: ' + text.slice(0, 200) };
  }

  // Sanity check: a valid plan must have a weeks array
  if (!parsed || !Array.isArray(parsed.weeks) || parsed.weeks.length === 0) {
    return { error: 'Plan response was missing the required "weeks" array. Try regenerating.' };
  }

  return { success: true, result: parsed };
}
