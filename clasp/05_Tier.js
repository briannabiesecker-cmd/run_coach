// ══════════════════════════════════════════════════
// TIER — runner experience tier inference
// ══════════════════════════════════════════════════
//
// The system prompt sends only ONE template cell (race distance × tier)
// instead of all 12. To pick the right cell, we infer the runner's
// tier from their inputs. Inferring server-side keeps the prompt small
// and lets us enforce the safety guardrail (a novice can't be promoted
// to advanced just because their goal time implies it).
//
// Mileage is the primary signal. Longest recent run is a secondary
// signal that can promote (never demote).

/**
 * Normalize a raw race-distance string into a template key.
 *
 * @param {string} raw - "5K", "Half Marathon", "marathon", etc.
 * @return {'5k'|'10k'|'half'|'marathon'} Template key (defaults to 'marathon')
 */
function getDistanceKey(raw) {
  var s = String(raw || '').toLowerCase();
  if (s.indexOf('half') !== -1) return 'half';
  if (s.indexOf('marathon') !== -1) return 'marathon';
  if (s.indexOf('10k') !== -1 || s.indexOf('10 k') !== -1) return '10k';
  if (s.indexOf('5k') !== -1 || s.indexOf('5 k') !== -1) return '5k';
  return 'marathon'; // safest default — most conservative novice template
}

/**
 * Infer the runner's experience tier from inputs. Mileage is the
 * primary signal; longest recent run can promote one tier (never
 * demote). This is a SAFETY guardrail — goal time cannot promote
 * the tier, only actual training history can.
 *
 * @param {string|number} mileage - Current weekly miles
 * @param {string|number} longestRecentRun - Longest run in recent training (mi)
 * @return {'novice'|'intermediate'|'advanced'} Inferred tier
 */
function inferTier(mileage, longestRecentRun) {
  var miles   = parseFloat(mileage) || 0;
  var longRun = parseFloat(longestRecentRun) || 0;

  var tier;
  if (miles >= 40) tier = 'advanced';
  else if (miles >= 20) tier = 'intermediate';
  else tier = 'novice';

  // Long run can promote one tier (a runner doing 25 mi/wk with a 16mi
  // long run is fitter than 25 mi/wk with a 5mi long run).
  if (longRun >= 15 && tier === 'intermediate') tier = 'advanced';
  if (longRun >= 9  && tier === 'novice')       tier = 'intermediate';

  return tier;
}

// Filter the named workout library to only the workouts gated for this
// tier. Returns the formatted text block, or empty string if no
// relevant workouts (rare — only novice 5K).
/**
 * Filter NAMED_WORKOUT_LIBRARY to only the workouts allowed for this
 * tier. Returns the formatted text block ready to inject into the
 * system prompt.
 *
 * @param {'novice'|'intermediate'|'advanced'} tier
 * @return {string} Formatted library text, or empty string if no matches
 */
function buildWorkoutLibraryText(tier) {
  var relevant = NAMED_WORKOUT_LIBRARY.filter(function(w) {
    return w.tiers.indexOf(tier) !== -1;
  });
  if (!relevant.length) return '';
  return [
    'NAMED WORKOUTS AVAILABLE FOR THIS RUNNER (use the exact name in the workout note when prescribing one of these):',
    ''
  ].concat(relevant.map(function(w) { return '  - ' + w.desc; })).join('\n');
}
