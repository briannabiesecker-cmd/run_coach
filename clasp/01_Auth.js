// ══════════════════════════════════════════════════
// AUTH — shared passcode check
// ══════════════════════════════════════════════════
//
// Single shared passcode set in Project Settings → Script Properties as
// APP_PASSCODE. All actions except 'ping' must pass this check.
// 'verifyPasscode' is the bootstrap action the frontend uses to
// validate the user's input before storing it locally.
//
// This is theatrical security for ~3 friends in a private app. NOT a
// real auth model. Anyone with the passcode can pretend to be any
// user. CLAUDE.md documents this and the privacy plan defers real
// auth until there's an actual adversary.

function checkPasscode(supplied) {
  var expected = PropertiesService.getScriptProperties().getProperty('APP_PASSCODE');
  if (!expected) return { ok: false, error: 'APP_PASSCODE not set in script properties.' };
  if (!supplied || supplied !== expected) return { ok: false, error: 'Unauthorized' };
  return { ok: true };
}
