// ══════════════════════════════════════════════════
// RUN ANALYSIS — post-run AI feedback via Gemini
// ══════════════════════════════════════════════════

/**
 * Analyze a completed run and provide coaching feedback.
 *
 * @param {Object} params
 * @param {Object} params.planned - { type, miles, paceTarget }
 * @param {Object} params.actual  - { distance, duration, pace, avgHR, rpe }
 * @param {Object} params.context - { phase, weekNumber, vdot, recentDays[] }
 * @param {string} [params.coachingStyle='encouraging']
 * @return {{success: true, analysis: Object} | {error: string}}
 */
function analyzeRun(params) {
  var url = buildGeminiUrl();
  if (!url) return { error: 'GEMINI_API_KEY not set in script properties.' };

  var planned = params.planned || {};
  var actual  = params.actual  || {};
  var context = params.context || {};
  var style   = params.coachingStyle || 'encouraging';

  var systemPrompt = [
    'You are an experienced running coach reviewing a single workout your athlete just completed.',
    'Be specific and actionable. Reference the actual numbers.',
    'Tone: ' + (style === 'tough-love' ? 'direct and honest' :
                style === 'data-driven' ? 'analytical with reasoning' :
                'warm and supportive'),
    '',
    'Return ONLY valid JSON in this exact structure:',
    '{',
    '  "summary": "1-2 sentence overall assessment of this workout",',
    '  "paceAnalysis": "1-2 sentences comparing actual pace to target zone",',
    '  "effortAnalysis": "1 sentence on RPE vs expected effort for this workout type",',
    '  "recommendation": "1 sentence actionable advice for the next workout"',
    '}'
  ].join('\n');

  var lines = [];
  lines.push('PLANNED WORKOUT:');
  lines.push('  Type: ' + (planned.type || 'Unknown'));
  lines.push('  Distance: ' + (planned.miles || '?') + ' mi');
  if (planned.paceTarget) lines.push('  Target pace: ' + planned.paceTarget);
  lines.push('');
  lines.push('ACTUAL LOGGED:');
  if (actual.distance) lines.push('  Distance: ' + actual.distance + ' mi');
  if (actual.duration) lines.push('  Duration: ' + actual.duration);
  if (actual.pace)     lines.push('  Pace: ' + actual.pace);
  if (actual.avgHR)    lines.push('  Avg HR: ' + actual.avgHR + ' bpm');
  if (actual.rpe)      lines.push('  RPE: ' + actual.rpe + '/10');
  lines.push('');
  if (context.phase)      lines.push('Training phase: ' + context.phase);
  if (context.weekNumber) lines.push('Week: ' + context.weekNumber);
  if (context.vdot)       lines.push('VDOT: ' + context.vdot);
  if (context.recentDays && context.recentDays.length) {
    lines.push('');
    lines.push('LAST 3 DAYS:');
    context.recentDays.forEach(function(d) {
      lines.push('  ' + d.day + ': ' + d.type + (d.miles ? ' ' + d.miles + 'mi' : '') + (d.status ? ' (' + d.status + ')' : ''));
    });
  }
  lines.push('');
  lines.push('Analyze this workout. Return JSON only.');

  var payload = {
    system_instruction: { parts: [{ text: systemPrompt }] },
    contents: [{ role: 'user', parts: [{ text: lines.join('\n') }] }],
    generationConfig: {
      temperature: 0.4,
      response_mime_type: 'application/json'
    }
  };

  var response = fetchGeminiWithRetry(url, payload);
  if (response.getResponseCode() !== 200) {
    return { error: 'Analysis failed: ' + response.getContentText().slice(0, 300) };
  }

  var data = JSON.parse(response.getContentText());
  var text = data.candidates && data.candidates[0] && data.candidates[0].content
    ? data.candidates[0].content.parts.map(function(p) { return p.text || ''; }).join('')
    : '';

  var parsed;
  try { parsed = JSON.parse(text); } catch(e) { return { error: 'Could not parse analysis response.' }; }
  return { success: true, analysis: parsed };
}
