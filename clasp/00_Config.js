// ══════════════════════════════════════════════════
// CONFIG — central constants for the entire script
// ══════════════════════════════════════════════════
//
// All magic numbers and tunable knobs live here. Edit one place,
// affects everything that imports it (which is everything, since
// Apps Script has no module system — globals work across all files).

var GEMINI_MODEL = 'gemini-2.5-flash';
var GEMINI_API_BASE = 'https://generativelanguage.googleapis.com/v1beta/models/';

// Output token budget for plan generation. Default is 8K which truncates
// long marathon plans with per-workout segments. 32K is the practical
// safety zone for gemini-2.5-flash.
var GEMINI_MAX_OUTPUT_TOKENS = 32768;

// fetchGeminiWithRetry: how many times to retry transient errors
var GEMINI_RETRY_MAX_ATTEMPTS = 3;
// Cap on parsed "retry in X seconds" wait time. Anything bigger means
// the daily quota is exhausted, not a per-minute throttle.
var GEMINI_RETRY_MAX_WAIT_MS = 60000;

// Sheets cell value limit (Google: 50,000 chars). We leave 500 char
// safety buffer so partial writes don't push us into the truncation zone.
var SHEETS_CELL_LIMIT = 49500;

// Schema version for cloud-stored payloads. Bump on breaking schema
// changes; migratePayload() will handle the upgrade path.
var PAYLOAD_VERSION = 1;

// Diagnostic version string returned by ?action=ping. Bump manually when
// shipping a release worth labeling.
var BACKEND_VERSION = 'v3-tier1-with-quota-ui';
