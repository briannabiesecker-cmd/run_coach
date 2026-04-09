// ══════════════════════════════════════════════════
// PARSE — extract running activity data from a Strava screenshot
// ══════════════════════════════════════════════════
//
// User uploads a screenshot from Strava (or any tracker), Gemini Vision
// extracts distance/duration/HR/pace/elevation. Used to auto-fill the
// check-in form so users don't manually type numbers from their watch.

/**
 * Extract running activity data from a Strava screenshot via Gemini Vision.
 * Used to auto-fill the check-in form so users don't manually type
 * numbers from their watch.
 *
 * @param {{image: string}} params - image is base64-encoded PNG
 * @return {{success: true, data: {distance: number|null, duration: string|null,
 *           avgHR: number|null, elevation: number|null, type: string,
 *           confidence: string}} | {error: string}}
 */
function parseRunScreenshot(params) {
  var url = buildGeminiUrl();
  if (!url) return { error: 'GEMINI_API_KEY not set in script properties.' };

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
