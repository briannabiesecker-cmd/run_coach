// ══════════════════════════════════════════════════
// LOOKUP — identify a race by name via Gemini
// ══════════════════════════════════════════════════
//
// User types a partial race name in the setup form, we ask Gemini to
// identify it and return structured info (date, distance, location).
// Frontend shows the result and asks for confirmation before using it.

/**
 * Identify a race by user-supplied name via Gemini. Returns
 * structured info (date, distance, location) for frontend confirmation.
 *
 * @param {{raceName: string}} params
 * @return {{success: true, race: {found: boolean, name?: string, date?: string,
 *           location?: string, distance?: string, confidence?: string}} | {error: string}}
 */
function lookupRace(params) {
  var url = buildGeminiUrl();
  if (!url) return { error: 'GEMINI_API_KEY not set in script properties.' };

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
