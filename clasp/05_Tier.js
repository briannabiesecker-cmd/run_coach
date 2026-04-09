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

function getDistanceKey(raw) {
  var s = String(raw || '').toLowerCase();
  if (s.indexOf('half') !== -1) return 'half';
  if (s.indexOf('marathon') !== -1) return 'marathon';
  if (s.indexOf('10k') !== -1 || s.indexOf('10 k') !== -1) return '10k';
  if (s.indexOf('5k') !== -1 || s.indexOf('5 k') !== -1) return '5k';
  return 'marathon'; // safest default — most conservative novice template
}

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
