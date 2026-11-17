# Russ Community Credit Union (Demo)

A digital account opening application built on Alloy's Journeys API, for the Alloy
Solutions Engineering interview exercise (Option 2: build your own demo app).

Russ Community Credit Union is fictional. Use test data only.

## Run it

You need Node.js 18 or newer. There is nothing to install.

```
node server.js
```

Then open http://localhost:3000

In Cursor: open this folder, open the terminal (Ctrl + backtick), and run the command above.

## Two modes

| Mode | When | What happens |
| --- | --- | --- |
| Mock | Any Alloy setting is blank in `.env` | Responses are simulated and shaped like Alloy's. Good for rehearsal. |
| Live sandbox | Base URL, journey token, workflow token and secret are all set | Real calls to the Consumer Onboarding journey in Alloy's sandbox. |

The badge in the header shows which mode is active.

### Go live

1. Make a copy of `.env.example` in this folder and name the copy `.env`.
   In the Cursor terminal: `cp .env.example .env`
2. Open `.env` and paste the workflow token and secret from the Alloy dashboard
   (Settings > API Keys > "Fraud & CIP (LexisNexis)" row).
3. Stop the server (Ctrl + C) and start it again.

`.env` is listed in `.gitignore`. Keep the secret out of chats, screenshots, and commits.

## Test applicants

The "Demo tools" row on each form step fills the form with an invented applicant.
The postal code selects a sandbox profile in the Alloy account.

| Button | Postal code | Sandbox profile | Expected result |
| --- | --- | --- | --- |
| Approved | 33602 | none | Approved (confirm on first live run) |
| Step-Up | 00001 | Fraud Review | Step Up Required (seen in the dashboard) |
| Denied | 00002 | Fraud Denial | Denied (confirm on first live run) |
| Manual review | 00003 | Fraud & KYC Review | Manual Review or Exception (confirm) |
| Review (identity) | 00004 | LNII Review | Manual Review or Exception (confirm) |

`TEST_NAME_PREFIX` in `.env` (default `RI`) is added to each first name so you can find
your applications in the shared Application Queue.

## How it works

```
Browser (public/)  ->  server.js (mock ESB)  ->  Alloy Journeys API
```

- `public/` is the member-facing application. It only calls this app's own `/api` endpoints.
- `server.js` plays the credit union's ESB. It holds the Alloy credentials, builds the
  Alloy request, and maps Alloy's `status` and `complete_outcome` to a member experience.
- The X-ray panel shows every hop, with request and response bodies (SSN masked).

| Alloy says | Member sees |
| --- | --- |
| `completed` + `Approved` | Approved |
| `completed` + `Denied` | Denied |
| `pending_step_up` | Step-Up (photo ID and selfie through Alloy's SDK) |
| `waiting_review` | In review |
| `pending_action`, `data_request` | More information needed |
| `error` | Something went wrong |

The mapping lives in one function, `normalize()` in `server.js`. `npm test` checks it.

### Endpoints

| This app | Calls Alloy |
| --- | --- |
| `POST /api/applications` | `POST /journeys/{journey_token}/applications` |
| `GET /api/applications/:token` | `GET /journeys/{journey_token}/applications/:token` |

## Things to know

- **Status checks use polling.** The SE Hiring account has no webhook settings, so the app
  re-reads the application. In production the ESB would react to Alloy webhooks.
- **Manual review in live mode** is decided in the Alloy dashboard (Applications queue).
  The page picks up the decision on its next status check, or press "Check now".
- **Step-up in live mode** loads Alloy's SDK. If it does not open, the SDK domain allowlist
  in the dashboard may need `localhost` added. Ask your Alloy contact.
- **Not built:** Spanish language toggle, address autocomplete, save-and-resume across
  devices, and the non-default routing paths (existing member, loan, business, non-resident),
  which show an explanation screen.
