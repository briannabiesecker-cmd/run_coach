# Run Coach — Virtual Run Coach App

Lightweight web app that creates personalized training plans for recreational runners and gives AI coaching feedback on uploaded Strava run screenshots.

## Audience

Recreational runners aged 25–35 training for specific races. Plain language, no jargon, mobile-friendly.

## Architecture

| Component | Where |
|---|---|
| Frontend | `index.html` → GitHub Pages |
| AI proxy | Google Apps Script web app (`RunCoach-AppScript.js`) |
| AI model | Gemini 2.5 Flash (multimodal — reads screenshots) |
| Storage | Browser localStorage (race plan, run history per user) |

The Apps Script holds the Gemini API key in script properties (server-side only) so the frontend never exposes it. Browser sends form data + base64 screenshots via JSONP, Apps Script forwards to Gemini, returns JSON response.

## Deploying

**Apps Script:**
```bash
bash deploy.sh
```
After clasp push, **bump the deployment version** in the Apps Script editor (Deploy → Manage deployments → Edit → New version → Deploy) — clasp updates code but doesn't activate it on the web app URL.

**Frontend:** Push to `main` on GitHub. GitHub Pages redeploys in ~1 minute.

## API key setup

1. Get Gemini API key at https://aistudio.google.com/ → "Get API Key"
2. In the Apps Script editor: **Project Settings → Script Properties → Add property**
   - Property: `GEMINI_API_KEY`
   - Value: your key
3. Also add: `APP_PASSCODE` = a shared word/phrase friends use to unlock the app
4. Never commit either key to git

## Privacy rules (do not violate)

- **Shared passcode required.** All API actions except `ping` and `verifyPasscode` check `APP_PASSCODE` from script properties. Never bypass this check.
- **Strava GPS data must never reach Gemini.** When v2 ships, the Apps Script must extract only summary metrics (distance, duration, avg/max HR, pace, elevation) — never the polyline or stream coordinates. Even if a coach prompt would benefit from a route, the privacy rule wins.
- **Strava OAuth tokens must never reach the browser.** When v2 ships, store tokens server-side in Apps Script Script Properties only. The frontend never sees the access or refresh token.
- **No persistent server storage of plans yet.** Plans live in browser localStorage. Multi-device sync is deferred — adding it requires user identity, which is a separate decision.
- **Consent screen must be shown before first use.** Don't remove the consent gate.

## MVP Scope

1. User fills form: race date, distance, current weekly mileage, goal time, coaching style preference
2. User uploads screenshot(s) of recent Strava run(s)
3. App sends to Gemini → returns training plan + coaching feedback
4. Display result, save to localStorage history

## Out of scope for MVP

- Direct Strava API integration (planned for v2)
- User accounts / cloud sync
- Mobile app via Replit (planned later)
- Multiple coaching styles preset library

## Key conventions

- **JSONP for API calls** — Apps Script doesn't allow CORS by default
- **Base64 screenshots** — converted in browser before upload
- **Mobile-first CSS** — runners use phones
- **Plain language** — no coaching jargon without explanation
- Write commits with `Co-Authored-By: Claude` trailer

## Known constraints

- JSONP URL length ~8KB — keep screenshots compressed before encoding
- Gemini free tier: 250 requests/day, 10 RPM on Flash
- Apps Script cold start: ~5–7 seconds first call after idle
