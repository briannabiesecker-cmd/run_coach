// ══════════════════════════════════════════════════
// TEMPLATES — race-distance × tier matrix + workout library
// ══════════════════════════════════════════════════
//
// 4 race distances × 3 tiers = 12 distinct plan templates. Each cell
// is modeled on a real published program (Higdon Novice 1, Pfitzinger
// 18/55, Daniels Marathon A, etc).
//
// The named workout library has tier gating — Yasso 800s and Cruise
// intervals are advanced-only, Galloway run-walk is novice-only, etc.
// inferTier picks the cell, buildWorkoutLibraryText filters the library.

var RACE_TEMPLATES = {
  '5k': {
    novice: [
      'NOVICE 5K (e.g. Hal Higdon Spring Training Beginner, 8 weeks):',
      '  - Total weeks: 6-8',
      '  - Days/week: 3-4 (very flexible)',
      '  - Quality: NONE. No tempo, no intervals. Easy runs + a longer run.',
      '  - Long run progression: 2 mi → 4 mi peak',
      '  - Workouts: Easy 2-3mi, "long" 3-4mi, walk-run alternation if needed',
      '  - Goal: build the habit and finish the race upright'
    ].join('\n'),
    intermediate: [
      'INTERMEDIATE 5K (Higdon Intermediate / Daniels Beginner 5K):',
      '  - Total weeks: 8',
      '  - Days/week: 4-5',
      '  - Quality: 1 strides session/wk + 1 light interval session in build/peak (e.g. 4x400m @ 5K pace)',
      '  - Long run progression: 4 → 6 mi',
      '  - Race-pace work in peak phase only'
    ].join('\n'),
    advanced: [
      'ADVANCED 5K (Daniels 5K-15K, Tinman 5K plans):',
      '  - Total weeks: 8-12',
      '  - Days/week: 5-6',
      '  - Quality: 2 sessions/wk (intervals + tempo, alternating)',
      '  - Long run: 8 mi peak (5K is short, long runs are aerobic support)',
      '  - Race-pace specificity: 5K-pace intervals throughout peak (e.g. 5x1000m @ 5K pace, 6x800m, ladder workouts)'
    ].join('\n')
  },
  '10k': {
    novice: [
      'NOVICE 10K (Hal Higdon Novice 10K, 8 weeks):',
      '  - Total weeks: 8',
      '  - Days/week: 3-4',
      '  - Quality: NONE for first 5 weeks. Optional strides only. ZERO tempo or intervals.',
      '  - Long run progression: 3 → 6 mi',
      '  - Cross-training 1x/wk'
    ].join('\n'),
    intermediate: [
      'INTERMEDIATE 10K (Higdon Intermediate 10K):',
      '  - Total weeks: 8-10',
      '  - Days/week: 4-5',
      '  - Quality: 1 light interval or fartlek session per week starting wk 3',
      '  - Long run: 6 → 9 mi',
      '  - Light tempo work in build phase'
    ].join('\n'),
    advanced: [
      'ADVANCED 10K (Daniels 10K, Pfitzinger faster road racing):',
      '  - Total weeks: 10-12',
      '  - Days/week: 5-6',
      '  - Quality: 2 sessions/wk (threshold + VO2 max)',
      '  - Long run: 10-11 mi peak',
      '  - Race-pace specificity: 10K-pace intervals in peak (e.g. 4x1mi, 6x1k @ 10K pace)'
    ].join('\n')
  },
  'half': {
    novice: [
      'NOVICE HALF (Hal Higdon Novice 1 Half, 12 weeks):',
      '  - Total weeks: 10-12',
      '  - Days/week: 4 (3 runs + 1 cross)',
      '  - Quality: NONE. Pure easy + long progression.',
      '  - Long run progression: 4 → 10 mi (peak is below race distance — stretch happens on race day)',
      '  - Weekly structure: Mon rest, Tue easy 3, Wed easy 4, Thu easy 3, Fri rest, Sat long, Sun cross/rest'
    ].join('\n'),
    intermediate: [
      'INTERMEDIATE HALF (Higdon Intermediate Half):',
      '  - Total weeks: 12',
      '  - Days/week: 4-5',
      '  - Quality: 1 pace run/wk (3-5 mi @ HM pace) starting wk 4-5',
      '  - Long run: 6 → 12 mi, with last long run including HM-pace miles in last third',
      '  - One light tempo session per week in build phase'
    ].join('\n'),
    advanced: [
      'ADVANCED HALF (Pfitzinger Faster Road Racing HM, Daniels HM):',
      '  - Total weeks: 12-14',
      '  - Days/week: 5-6',
      '  - Quality: 2 sessions/wk (lactate threshold tempo + VO2 max intervals)',
      '  - Long run: 8 → 14 mi, multiple long runs with HM-pace blocks (e.g. 12mi w/ 6 @ HM pace)'
    ].join('\n')
  },
  'marathon': {
    novice: [
      'NOVICE MARATHON (Hal Higdon Novice 1, 18 weeks — THE canonical first-timer plan):',
      '  - Total weeks: 18',
      '  - Days/week: 4 (3 runs + 1 cross + 2 rest)',
      '  - Quality: ABSOLUTELY NONE. Zero tempo. Zero intervals. Zero hill repeats. Zero MP work in long runs.',
      '  - Long run progression: 6 → 20 mi peak (3 weeks before race), with stepback weeks every 4th',
      '  - Weekly structure example: Mon rest, Tue 3mi easy, Wed 5mi easy, Thu 3mi easy, Fri rest, Sat long, Sun cross',
      '  - Goal: finish the race uninjured. Volume is the only stimulus.',
      '  - DO NOT prescribe ANY quality work for this tier under any circumstances. The runner is at injury risk just from the volume jump.'
    ].join('\n'),
    intermediate: [
      'INTERMEDIATE MARATHON (Hal Higdon Novice 2 or Intermediate 1, 18 weeks):',
      '  - Total weeks: 18',
      '  - Days/week: 5',
      '  - Quality: 1 pace run/wk (2-5 mi @ MP) starting around wk 8. Maybe 1 light tempo every 2-3 weeks in build phase.',
      '  - Long run: 8 → 20 mi peak, with the LAST 2-3 long runs including 3-5 mi @ MP at the end',
      '  - No intervals or hill repeats — strides only for leg turnover'
    ].join('\n'),
    advanced: [
      'ADVANCED MARATHON (Pfitzinger 18/55, 18/70, 18/85; Daniels Marathon A; Hansons Advanced):',
      '  - Total weeks: 18',
      '  - Days/week: 6-7',
      '  - Quality: 2 sessions/wk in build/peak (lactate threshold tempo + MP long run; sometimes VO2 intervals)',
      '  - Long run: 10 → 22 mi, with multiple long runs containing significant MP blocks (e.g. 18mi w/ 12 @ MP, 20mi w/ 14 @ MP). Pfitzinger-style.'
    ].join('\n')
  }
};

var NAMED_WORKOUT_LIBRARY = [
  {
    name: 'Yasso 800s',
    tiers: ['advanced'],
    desc: '"Yasso 800s" (Bart Yasso, Runner\'s World): 10x800m where each rep is run in min:sec equal to your goal marathon time in hr:min (e.g. 4:00 reps for a 4-hour marathon goal). 400m jog recovery. Marathon peak phase only.'
  },
  {
    name: 'Magic Mile',
    tiers: ['intermediate', 'advanced'],
    desc: '"Magic Mile" (Jeff Galloway): 1mi all-out time trial after a 15-min warmup. Fitness benchmark every 4-6 weeks. Place sparingly.'
  },
  {
    name: 'Cruise intervals',
    tiers: ['advanced'],
    desc: '"Cruise intervals" (Jack Daniels): 4-5 x 1mi at tempo (T) pace with 60 sec jog recovery. The short recovery makes this a true threshold workout.'
  },
  {
    name: 'Michigan workout',
    tiers: ['advanced'],
    desc: '"Michigan workout" (Ron Warhurst): A ladder — 1mi @ tempo, 1200m @ 5K pace, 800m @ 3K pace, 400m all out. Tempo-paced 800m recovery jogs between reps. Sub-elite only.'
  },
  {
    name: 'Hanson long run',
    tiers: ['advanced'],
    desc: '"Hanson long run" (Hansons Marathon Method): A long run capped at 16mi but run on accumulated fatigue (no preceding rest day). Marathon build phase.'
  },
  {
    name: 'Pfitzinger long run with MP',
    tiers: ['advanced'],
    desc: '"Pfitzinger long run with MP" (Pete Pfitzinger): Long run with a marathon-pace block in the second half (e.g. "16 mi total with last 12 @ MP"). The cornerstone of Pfitzinger marathon plans.'
  },
  {
    name: 'Galloway run-walk long run',
    tiers: ['novice', 'intermediate'],
    desc: '"Galloway run-walk long run" (Jeff Galloway): Long run with structured walk breaks (e.g. run 4 min, walk 1 min). Designed for beginners and injury-prone runners. Especially useful for first-time marathoners.'
  },
  {
    name: 'Lydiard long aerobic',
    tiers: ['intermediate', 'advanced'],
    desc: '"Lydiard long aerobic" (Arthur Lydiard): Very long, very easy run at upper end of conversational pace. Builds aerobic capacity. Early base phase. Distance is determined by time on feet (90-180 min), not mileage.'
  }
];

var TIER_INFLUENCES = {
  novice: 'Hal Higdon (Novice 1, Novice 2 — predictable, volume-driven, zero-quality plans for first-timers and returning runners). Jeff Galloway (run-walk method for absolute beginners).',
  intermediate: 'Hal Higdon Intermediate plans (light pace work, MP segments). Hansons Beginner.',
  advanced: 'Pete Pfitzinger (Advanced Marathoning — MP long runs are the backbone). Jack Daniels (Daniels\' Running Formula — VDOT-based pace zones, cruise intervals, structured quality). Hansons Advanced (cumulative fatigue methodology).'
};
