// ══════════════════════════════════════════════════
// AUTH — shared passcode check (hashed at rest)
// ══════════════════════════════════════════════════
//
// Single shared passcode set in Project Settings → Script Properties as
// APP_PASSCODE. All actions except 'ping' must pass this check.
//
// HASHING: the passcode is stored as a SHA-256 hash with a 'sha256:'
// prefix. checkPasscode hashes the supplied input the same way and
// constant-time-compares the digests. This means anyone with edit
// access to the Apps Script project (which lets them read script
// properties) can NOT trivially read the passcode — they'd have to
// brute force the hash.
//
// MIGRATION: if APP_PASSCODE in script properties is still plaintext
// (no 'sha256:' prefix), we hash it on first call and write it back.
// One-time, transparent. After migration, plaintext is gone forever.
//
// This is still not "real" auth — anyone with the (hashed or plain)
// passcode can authenticate. But hashing closes the "edit access leaks
// the secret" hole, which is a meaningful improvement.

function _hashPasscode(s) {
  var bytes = Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, s);
  var hex = '';
  for (var i = 0; i < bytes.length; i++) {
    var b = bytes[i] < 0 ? bytes[i] + 256 : bytes[i];
    hex += ('0' + b.toString(16)).slice(-2);
  }
  return 'sha256:' + hex;
}

// Constant-time string comparison. Prevents timing-based discovery of
// the correct hash by ensuring comparison takes the same time
// regardless of where strings differ.
function _constantTimeEquals(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  if (a.length !== b.length) return false;
  var result = 0;
  for (var i = 0; i < a.length; i++) {
    result |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return result === 0;
}

/**
 * Validate the supplied passcode against the stored hash.
 * One-time migration: hashes plaintext APP_PASSCODE on first call.
 *
 * @param {string} supplied - The passcode the user typed
 * @return {{ok: boolean, error?: string}} ok=true on match, error msg on fail
 */
function checkPasscode(supplied) {
  var props = PropertiesService.getScriptProperties();
  var stored = props.getProperty('APP_PASSCODE');
  if (!stored) return { ok: false, error: 'APP_PASSCODE not set in script properties.' };
  if (!supplied) return { ok: false, error: 'Unauthorized' };

  // One-time migration: if stored value is still plaintext, hash it
  // now and persist. This runs at most once per script lifetime.
  if (stored.indexOf('sha256:') !== 0) {
    var hashed = _hashPasscode(stored);
    props.setProperty('APP_PASSCODE', hashed);
    stored = hashed;
  }

  var suppliedHash = _hashPasscode(supplied);
  if (!_constantTimeEquals(stored, suppliedHash)) {
    return { ok: false, error: 'Unauthorized' };
  }
  return { ok: true };
}
