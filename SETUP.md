# Run Coach — Apps Script Setup

This is a runbook for getting the Apps Script backend deployed and
configured. The frontend is a static `index.html` served from GitHub
Pages and needs no setup beyond pointing it at your Apps Script
deployment URL.

## Required script properties

Open the Apps Script editor → **⚙ Project Settings** → **Script
Properties**. The script needs these:

| Property | Required? | What it is | How to get it |
|---|---|---|---|
| `GEMINI_API_KEY` | **Required** | Your Gemini API key | Go to https://aistudio.google.com → Get API Key |
| `APP_PASSCODE` | **Required** | Shared passcode that all users must enter to unlock the app | Pick any string. Friends will type this once. |
| `RUNCOACH_FOLDER_ID` | Optional but recommended | Drive folder where per-user sheets live | Open your folder in Drive, copy the ID from the URL: `https://drive.google.com/drive/folders/<THIS_ID>` |

## Auto-managed script properties

The script also writes these automatically — **don't edit them by hand
unless you know what you're doing**:

| Property | Set by | Purpose |
|---|---|---|
| `USER_SHEET_<lowercased name>` | `getOrCreateUserSheet()` | Caches the per-user sheet ID so we don't search Drive on every save. One entry per user (e.g. `USER_SHEET_brianna`). |
| `gemini_count_YYYY-MM-DD` | `trackGeminiCall()` | Daily counter for Gemini API requests. Read via `?action=quotaUsed`. Auto-rotates per day. |
| `SAMPLE_SHEET_ID` | Optional manual override | If set, `populateSampleSheet()` uses this sheet ID instead of the hardcoded default. |

## Deployment process

The first deployment is manual; subsequent deploys are automated via
`bash deploy.sh`.

### First deploy (one-time)

1. Install clasp:
   ```
   npm install -g @google/clasp
   clasp login
   ```
2. Create your Apps Script project at https://script.google.com → **New project**
3. Get the script ID from the URL: `https://script.google.com/d/<SCRIPT_ID>/edit`
4. Update `clasp/.clasp.json` with your script ID
5. Push the code:
   ```
   bash deploy.sh
   ```
   On the first run, this will fail at the deploy step because there's
   no existing deployment yet. Continue to step 6.
6. In the Apps Script editor → **Deploy** → **New deployment**
   - Click the gear ⚙ next to "Select type" → **Web app**
   - Description: `v2 cloud sync` (must contain this exact string for
     auto-deploy to find it later)
   - Execute as: **Me**
   - Who has access: **Anyone**
   - Click **Deploy** → authorize → copy the **Web app URL**
7. Save the URL for `deploy.sh` smoke test:
   ```
   echo 'https://script.google.com/macros/s/.../exec' > clasp/script_url
   ```
8. Set the required script properties (see table above) in Project
   Settings → Script Properties
9. Update `SCRIPT_URL` constant in `index.html` to match the deployment
   URL (line ~3307)
10. Verify everything works:
    ```
    bash deploy.sh
    ```
    The smoke test should pass with `✓ Smoke test passed (version: v3-tier1-refactor)`

### Subsequent deploys

Just run:
```
bash deploy.sh
```

This will:
1. `clasp push` — uploads all `.js` files in `clasp/` to Apps Script
2. `clasp deploy --deploymentId ...` — bumps the existing "v2 cloud sync"
   deployment to a new version. **Same URL keeps working** — no version
   bump dance in the editor.
3. Smoke test — hits `?action=ping` and verifies a 200 response

## Required OAuth scopes

The script needs these scopes (declared in `clasp/appsscript.json`):

- `https://www.googleapis.com/auth/script.external_request` — UrlFetchApp (Gemini calls)
- `https://www.googleapis.com/auth/spreadsheets` — SpreadsheetApp (cloud sync)
- `https://www.googleapis.com/auth/drive` — DriveApp (folder + file management)

If you add a new scope after the script is already deployed, **the
existing OAuth grant won't auto-extend**. You'll need to either:

1. Run any function from the editor to trigger re-authorization (Apps Script will detect the new scope and re-prompt), OR
2. Revoke the script's permission at https://myaccount.google.com/permissions and re-authorize from scratch

## File layout in `clasp/`

Each `.js` file becomes a separate `.gs` file in the Apps Script editor.
Files are loaded alphabetically — the numeric prefixes ensure dependency
order (Config first, then Auth, then everything else).

| File | Purpose |
|---|---|
| `00_Config.js` | All constants — Gemini model, token budgets, retry knobs, schema version |
| `01_Auth.js` | `checkPasscode()` |
| `02_GeminiClient.js` | `fetchGeminiWithRetry()`, `buildGeminiUrl()` |
| `03_Routing.js` | `doGet()` / `doPost()` action dispatch |
| `04_Storage.js` | Cloud sync — `loadUserData`, `saveUserData`, sheet/folder helpers, `migratePayload`, LockService |
| `05_Tier.js` | `inferTier`, `getDistanceKey`, `buildWorkoutLibraryText` |
| `06_Templates.js` | `RACE_TEMPLATES`, `NAMED_WORKOUT_LIBRARY`, `TIER_INFLUENCES` |
| `07_Prompts.js` | `buildSystemPrompt`, `buildUserPrompt` |
| `08_Coach.js` | `coach()` — generate a full plan |
| `09_WeeklyReview.js` | `weeklyReview()` |
| `10_Lookup.js` | `lookupRace()` |
| `11_Parse.js` | `parseRunScreenshot()` |
| `12_SamplePlan.js` | `buildHigdonNovice1Plan`, `populateSampleSheet` |
| `13_Diagnostics.js` | `trackGeminiCall`, `getQuotaUsed`, `testCloudSync` |
| `appsscript.json` | OAuth scopes + runtime config |

## Diagnostic functions

Run these from the Apps Script editor (Function dropdown → pick → Run):

- **`testCloudSync()`** — verifies folder lookup, sheet creation, write/read round-trip. Use this to debug any cloud-sync issue without going through the frontend.
- **`populateSampleSheet()`** — writes a hardcoded Higdon Novice 1 marathon plan to the sheet referenced by `SAMPLE_SHEET_ID` (or the default hardcoded one). Three tabs: `data` (JSON for app), `Plan` (human-readable rows), `Summary` (phases + paces).
- **Hit `?action=ping` directly** — paste this into your browser address bar to verify the deployment is reachable: `https://script.google.com/macros/s/.../exec?action=ping`. Returns `callback({"ok":true,"version":"...","ts":"..."})`.
- **Hit `?action=quotaUsed`** — same pattern, returns today's Gemini call count so you know how close you are to the free tier ceiling.

## Common gotchas

- **"Unknown action: loadUserData"** — your deployment is on old code. Run `bash deploy.sh` to bump it.
- **404 on the deployment URL** — the deployment was deleted. Create a new one (Apps Script editor → Deploy → New deployment) and update both `SCRIPT_URL` in `index.html` and `clasp/script_url`.
- **"You do not have permission to call DriveApp..."** — the OAuth grant doesn't include Drive scope. Run any function from the editor to trigger re-auth.
- **Multiple "Active" deployments** — archive old ones in Manage Deployments → ⋮ → Archive. Keep only "v2 cloud sync".
- **Cold start latency** — first request after ~5 min of idle takes 5-7 seconds. The frontend pings the script on app boot to mitigate this; subsequent calls are fast.
- **Gemini 429 / quota exhausted** — check `?action=quotaUsed`. If you hit the daily limit (250 free tier), wait until midnight Pacific or move to a billed Google Cloud project.
