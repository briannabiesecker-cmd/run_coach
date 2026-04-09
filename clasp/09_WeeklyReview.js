// ══════════════════════════════════════════════════
// WEEKLY REVIEW — assess past week + propose adjustments
// ══════════════════════════════════════════════════
//
// Inputs (params):
//   weekData         {week, phase, focus, totalMiles, days}
//   dayLogs          [{day, plannedType, plannedMiles, status, rpe, note,
//                      actualType, actualDistance, actualDuration, actualHR}]
//   wellnessAvg      {sleep, soreness, daysLogged}
//   raceInfo         {name, date, distance, goalTime, weeksOut}
//   nextWeek         {week, phase, focus, totalMiles, days}
//   recentReviews    last 2 prior reviews
//   cumulativeStats  overall plan stats so far
//   coachingStyle    'encouraging' | 'data-driven' | 'tough-love'
//
// Returns: { success, review: { summary, compliancePct, observations,
//            recommendation, proposedChanges } }

/**
 * Generate a weekly review of past execution + propose next-week
 * adjustments via Gemini. Includes coach memory (recentReviews) and
 * cumulative stats so the AI can spot patterns across weeks.
 *
 * @param {Object} params
 * @param {Object} params.weekData - The just-completed week (week, phase, focus, totalMiles, days)
 * @param {Array} params.dayLogs - Per-day log [{day, plannedType, plannedMiles, status, rpe, note, ...}]
 * @param {Object|null} [params.wellnessAvg] - {sleep, soreness, daysLogged}
 * @param {Object} [params.raceInfo] - {name, date, distance, goalTime, weeksOut}
 * @param {Object|null} [params.nextWeek] - Currently planned next week
 * @param {Array} [params.recentReviews] - Last 2 prior reviews for memory
 * @param {Object|null} [params.cumulativeStats] - Plan-so-far totals
 * @param {string} [params.coachingStyle='encouraging']
 * @return {{success: true, review: Object} | {error: string}}
 */
function weeklyReview(params) {
  var url = buildGeminiUrl();
  if (!url) return { error: 'GEMINI_API_KEY not set in script properties.' };

  var weekData    = params.weekData    || {};
  var dayLogs     = params.dayLogs     || [];
  var wellnessAvg = params.wellnessAvg || null;
  var raceInfo    = params.raceInfo    || {};
  var nextWeek    = params.nextWeek    || null;
  var recentReviews   = params.recentReviews   || [];
  var cumulativeStats = params.cumulativeStats || null;
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
  dayLogs.forEach(function(d) {
    var planned = d.plannedType + (d.plannedMiles ? ' ' + d.plannedMiles + ' mi' : '');
    if (d.plannedMiles && d.plannedType !== 'Rest') totalPlanned += d.plannedMiles;
    if (d.status) {
      var statusLabel = d.status.toUpperCase();
      var rpeText = d.rpe ? ', RPE ' + d.rpe + '/10' : '';
      var noteText = d.note ? ', "' + d.note + '"' : '';
      var actualParts = [];
      if (d.actualType && d.actualType !== d.plannedType) actualParts.push(d.actualType + ' (substituted)');
      if (d.actualDistance) actualParts.push(d.actualDistance + ' mi');
      if (d.actualDuration) actualParts.push(d.actualDuration);
      if (d.actualHR) actualParts.push('HR ' + d.actualHR);
      var actualText = actualParts.length ? ', ACTUAL: ' + actualParts.join(' · ') : '';
      lines.push('- ' + d.day + ': planned ' + planned + ' → ' + statusLabel + actualText + rpeText + noteText);
      if (d.status === 'done') {
        totalDone += (d.actualDistance || d.plannedMiles || 0);
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

  if (cumulativeStats) {
    lines.push('CUMULATIVE STATS (plan so far):');
    lines.push('- Weeks completed: ' + cumulativeStats.weeksCompleted);
    lines.push('- Total miles: ' + cumulativeStats.totalActualMiles + ' of ' + cumulativeStats.totalPlannedMiles + ' planned (' + cumulativeStats.overallCompliancePct + '%)');
    lines.push('- Runs completed: ' + cumulativeStats.runsCompleted + ' · Runs skipped: ' + cumulativeStats.runsSkipped);
    lines.push('');
  }

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

  var response = fetchGeminiWithRetry(url, payload);
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
