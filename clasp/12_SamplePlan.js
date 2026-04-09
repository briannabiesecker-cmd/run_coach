// ══════════════════════════════════════════════════
// SAMPLE PLAN — hardcoded Higdon Novice 1, no Gemini call needed
// ══════════════════════════════════════════════════
//
// Bypasses Gemini entirely. Builds a complete 18-week marathon plan in
// the same JSON shape Gemini produces, so the rest of the app treats
// it identically. Two callable functions:
//
//   buildHigdonNovice1Plan(raceDateISO) — returns the plan object
//   populateSampleSheet()               — runs from the editor and
//     writes the plan to a specific sheet (set DEFAULT_SHEET_ID below
//     or override via SAMPLE_SHEET_ID script property) in three tabs:
//       - "data": JSON blob (used by app's cloud sync)
//       - "Plan": human-readable workout rows
//       - "Summary": phases, paces, holistic guidance

function buildHigdonNovice1Plan(raceDateISO) {
  var grid = [
    [ 1,  3, 3, 3, 6 ],
    [ 2,  3, 3, 3, 7 ],
    [ 3,  3, 4, 3, 5 ],
    [ 4,  3, 4, 3, 9 ],
    [ 5,  3, 5, 3, 10],
    [ 6,  3, 5, 3, 7 ],
    [ 7,  4, 5, 4, 12],
    [ 8,  4, 6, 4, 13],
    [ 9,  4, 6, 4, 10],
    [10,  4, 7, 4, 15],
    [11,  5, 8, 5, 16],
    [12,  5, 8, 5, 12],
    [13,  5, 8, 5, 18],
    [14,  5, 9, 5, 14],
    [15,  5, 10,5, 20],
    [16,  5, 8, 5, 12],
    [17,  4, 6, 4, 8 ],
    [18,  3, 4, 2, 0 ]
  ];
  function phaseFor(wk) {
    if (wk <= 8)  return 'Base';
    if (wk <= 13) return 'Build';
    if (wk <= 15) return 'Peak';
    return 'Taper';
  }
  var minPerMi = 11.25;
  var weeks = grid.map(function(row) {
    var wk = row[0], tueMi = row[1], wedMi = row[2], thuMi = row[3], satMi = row[4];
    var phase = phaseFor(wk);
    var isRaceWeek = wk === 18;
    var dayObjs = [
      { day: 'Mon', type: 'Rest', miles: 0,     note: 'Recovery',                                              estimatedDurationMin: 0 },
      { day: 'Tue', type: 'Easy', miles: tueMi, note: '',                                                      estimatedDurationMin: Math.round(tueMi * minPerMi) },
      { day: 'Wed', type: 'Easy', miles: wedMi, note: '',                                                      estimatedDurationMin: Math.round(wedMi * minPerMi) },
      { day: 'Thu', type: 'Easy', miles: thuMi, note: '',                                                      estimatedDurationMin: Math.round(thuMi * minPerMi) },
      { day: 'Fri', type: 'Rest', miles: 0,     note: '',                                                      estimatedDurationMin: 0 },
      isRaceWeek
        ? { day: 'Sat', type: 'Rest', miles: 0,    note: 'Race day tomorrow — full rest',                    estimatedDurationMin: 0 }
        : { day: 'Sat', type: 'Long', miles: satMi, note: 'Easy pace throughout — time on feet is the goal', estimatedDurationMin: Math.round(satMi * minPerMi) },
      isRaceWeek
        ? { day: 'Sun', type: 'Long', miles: 26.2, note: 'RACE DAY — execute the plan, trust your training', estimatedDurationMin: 262 }
        : { day: 'Sun', type: 'Cross', miles: 0,    note: 'Optional: bike, swim, walk — anything non-impact, 30-45 min', estimatedDurationMin: 30 }
    ];
    var totalMiles = 0;
    for (var i = 0; i < dayObjs.length; i++) totalMiles += dayObjs[i].miles || 0;
    return {
      week: wk,
      phase: phase,
      focus: isRaceWeek
        ? 'Race week — trust the work, run the race'
        : (phase === 'Base' ? 'Build the habit and accumulate easy miles'
           : phase === 'Build' ? 'Stretch the long run; mid-week miles bump'
           : phase === 'Peak' ? 'Peak long runs — the hardest stretch'
           : 'Taper — fitness is banked, freshen up'),
      totalMiles: Math.round(totalMiles * 10) / 10,
      days: dayObjs
    };
  });
  return {
    raceName: 'Test Marathon',
    raceDate: raceDateISO,
    totalWeeks: 18,
    summary: 'Hal Higdon Novice 1 marathon plan — the canonical first-timer 18-week program. Volume-only progression, zero quality work. Long run builds 6 → 20 mi. Goal: finish the race uninjured.',
    paceZones: {
      easy:     { value: '11:00–11:30/mi', reason: 'Easy pace + 60-90 sec/mi over goal MP keeps effort aerobic, where most adaptation happens at the novice tier.' },
      marathon: { value: '10:00/mi',       reason: 'Goal marathon pace based on a ~4:22 finish target.' },
      tempo:    { value: '9:30/mi',        reason: 'Threshold pace, ~MP minus 30 sec. Not used in Novice 1 plans but listed for reference.' },
      interval: { value: '8:30/mi',        reason: '5K-pace, VO2 max effort. Not used in Novice 1 — reserved for Intermediate plans.' }
    },
    phases: [
      { name: 'Base',  weeks: '1-8',   goal: 'Build the aerobic base. Run easy, accumulate time on feet.' },
      { name: 'Build', weeks: '9-13',  goal: 'Stretch the long run progressively; mid-week miles increase.' },
      { name: 'Peak',  weeks: '14-15', goal: 'Peak long runs — 18mi and 20mi. Trust the plan.' },
      { name: 'Taper', weeks: '16-18', goal: 'Reduce volume sharply. Fitness is banked; arrive fresh.' }
    ],
    weeks: weeks,
    holisticGuidance: {
      recovery:  'Sleep 7-8 hours minimum. The body adapts at rest, not during runs. After Saturday long runs, prioritize a slow walk and protein within 30 min.',
      strength:  'Optional 2x/week light strength on run days (Tue + Thu) — bodyweight squats, lunges, planks. Skip if any session leaves you sore for the next run.',
      nutrition: 'Eat normally on weekdays. Carb-load Friday night before long runs. During runs over 90 min, take 30g carbs/hour (gels, sports drink). Refuel within 30 min after.',
      raceDay:   'Practice race-day routine on long-run days from week 12 onward: same breakfast, same gear, same fueling. Trust what works in training.'
    },
    topPriority: 'Get to the start line healthy. Easy runs should feel boring — that means you are doing them right.'
  };
}

function populateSampleSheet() {
  var DEFAULT_SHEET_ID = '1ki4J0MaUfKp7I7gdhhTPkXsjHuFFlmTAlZ_MSJ9R9uo';
  var sheetId = PropertiesService.getScriptProperties().getProperty('SAMPLE_SHEET_ID') || DEFAULT_SHEET_ID;

  var ss;
  try { ss = SpreadsheetApp.openById(sheetId); }
  catch (e) {
    Logger.log('❌ Could not open sheet ' + sheetId + ': ' + e.message);
    return 'Could not open sheet: ' + e.message;
  }

  var d = new Date();
  var dayOfWeek = (d.getDay() + 6) % 7;
  d.setDate(d.getDate() - dayOfWeek + 18 * 7);
  var raceDateISO = Utilities.formatDate(d, Session.getScriptTimeZone(), 'yyyy-MM-dd');

  var plan = buildHigdonNovice1Plan(raceDateISO);

  // ── Tab 1: "data" — JSON blob for app cloud sync ──
  var dataSheet = ss.getSheetByName('data');
  if (!dataSheet) {
    dataSheet = ss.insertSheet('data');
    dataSheet.appendRow(['payload', 'updatedAt']);
    dataSheet.setFrozenRows(1);
  } else if (dataSheet.getRange(1, 1).getValue() !== 'payload') {
    dataSheet.getRange(1, 1, 1, 2).setValues([['payload', 'updatedAt']]);
    dataSheet.setFrozenRows(1);
  }

  var payload = {
    payloadVersion: PAYLOAD_VERSION,
    plan: plan,
    planStartDate: Utilities.formatDate(new Date(), Session.getScriptTimeZone(), 'yyyy-MM-dd'),
    strengthSchedule: [],
    checkIns: {},
    wellness: {},
    weeklyReviews: {},
    runnerProfile: {
      raceName: plan.raceName,
      raceDistance: 'Marathon',
      raceDate: raceDateISO,
      weeklyMileage: '15',
      goalTime: '4:22:00',
      coachingStyle: 'encouraging',
      daysPerWeek: '4'
    },
    savedAt: new Date().toISOString()
  };
  var nowIso = new Date().toISOString();
  if (dataSheet.getLastRow() < 2) {
    dataSheet.appendRow([JSON.stringify(payload), nowIso]);
  } else {
    dataSheet.getRange(2, 1, 1, 2).setValues([[JSON.stringify(payload), nowIso]]);
  }

  // ── Tab 2: "Plan" — human-readable workout rows ──
  var planSheet = ss.getSheetByName('Plan');
  if (planSheet) ss.deleteSheet(planSheet);
  planSheet = ss.insertSheet('Plan');
  var headers = ['Week', 'Phase', 'Focus', 'Day', 'Type', 'Miles', 'Pace target', 'Est min', 'Note'];
  planSheet.appendRow(headers);
  planSheet.setFrozenRows(1);

  var rows = [];
  for (var w = 0; w < plan.weeks.length; w++) {
    var week = plan.weeks[w];
    for (var di = 0; di < week.days.length; di++) {
      var day = week.days[di];
      var pace = '';
      if (day.type === 'Easy' || day.type === 'Long') pace = plan.paceZones.easy.value;
      else if (day.type === 'Tempo') pace = plan.paceZones.tempo.value;
      else if (day.type === 'Intervals') pace = plan.paceZones.interval.value;
      var focus = di === 0 ? week.focus : '';
      rows.push([week.week, week.phase, focus, day.day, day.type, day.miles || '', pace, day.estimatedDurationMin || '', day.note || '']);
    }
  }
  if (rows.length > 0) {
    planSheet.getRange(2, 1, rows.length, headers.length).setValues(rows);
  }

  planSheet.getRange(1, 1, 1, headers.length).setFontWeight('bold').setBackground('#1f2937').setFontColor('#ffffff');
  for (var c = 1; c <= headers.length; c++) planSheet.autoResizeColumn(c);
  // Batch the phase coloring (one setBackgrounds call instead of N setBackground calls)
  var phaseColors = { 'Base': '#ecfdf5', 'Build': '#eff6ff', 'Peak': '#fff7ed', 'Taper': '#faf5ff' };
  var bgColors = rows.map(function(r) {
    var color = phaseColors[r[1]] || '#ffffff';
    return [color, color, color, color, color, color, color, color, color];
  });
  if (bgColors.length > 0) {
    planSheet.getRange(2, 1, bgColors.length, headers.length).setBackgrounds(bgColors);
  }

  // ── Tab 3: "Summary" — phases, paces, holistic guidance ──
  var summarySheet = ss.getSheetByName('Summary');
  if (summarySheet) ss.deleteSheet(summarySheet);
  summarySheet = ss.insertSheet('Summary');
  var summaryRows = [
    ['Run Coach Plan Summary', ''],
    ['', ''],
    ['Race name', plan.raceName],
    ['Race date', plan.raceDate],
    ['Total weeks', plan.totalWeeks],
    ['Plan style', 'Hal Higdon Novice 1 (marathon)'],
    ['', ''],
    ['Summary', plan.summary],
    ['', ''],
    ['── Phases ──', ''],
    ['Base',  plan.phases[0].weeks + ' — ' + plan.phases[0].goal],
    ['Build', plan.phases[1].weeks + ' — ' + plan.phases[1].goal],
    ['Peak',  plan.phases[2].weeks + ' — ' + plan.phases[2].goal],
    ['Taper', plan.phases[3].weeks + ' — ' + plan.phases[3].goal],
    ['', ''],
    ['── Pace zones ──', ''],
    ['Easy',     plan.paceZones.easy.value     + ' — ' + plan.paceZones.easy.reason],
    ['Marathon', plan.paceZones.marathon.value + ' — ' + plan.paceZones.marathon.reason],
    ['Tempo',    plan.paceZones.tempo.value    + ' — ' + plan.paceZones.tempo.reason],
    ['Interval', plan.paceZones.interval.value + ' — ' + plan.paceZones.interval.reason],
    ['', ''],
    ['── Holistic guidance ──', ''],
    ['Recovery',  plan.holisticGuidance.recovery],
    ['Strength',  plan.holisticGuidance.strength],
    ['Nutrition', plan.holisticGuidance.nutrition],
    ['Race day',  plan.holisticGuidance.raceDay],
    ['', ''],
    ['Top priority', plan.topPriority]
  ];
  summarySheet.getRange(1, 1, summaryRows.length, 2).setValues(summaryRows);
  summarySheet.getRange(1, 1).setFontWeight('bold').setFontSize(14);
  summarySheet.getRange(2, 1, summaryRows.length, 2).setWrap(true);
  summarySheet.setColumnWidth(1, 140);
  summarySheet.setColumnWidth(2, 600);

  var msg = '✅ Sheet populated. URL: ' + ss.getUrl();
  Logger.log(msg);
  Logger.log('Tabs created: data (JSON for app), Plan (' + rows.length + ' workout rows), Summary');
  return msg;
}
