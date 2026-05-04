# ClassiCube Web (Google Apps Script)

A self-contained rehost of the [ClassiCube](https://www.classicube.net) web client, designed to run entirely on **Google Apps Script** (GAS). No separate web server is needed.

## Features

- **Requires a Google account** — access to the app is gated by Google sign-in; no anonymous access
- **Sign in** with your ClassiCube account for multiplayer (username + password)
- **Play singleplayer** without a ClassiCube account — your Google identity is used as an in-game display name
- **Browse & join multiplayer servers** — the backend authenticates with ClassiCube.net server-side and returns the `mppass` needed to connect
- **Per-user session isolation** — each Google user's ClassiCube session is stored server-side, keyed by their Google identity; no session tokens in the browser
- **Login rate-limiting** — brute-force protection (5 attempts per 10 minutes per Google account)
- **Input validation** — all user-supplied inputs are validated before being forwarded
- **Texture pack caching** — `default.zip` is cached server-side for 24 hours to reduce upstream fetches
- Responsive dark-theme UI; works on desktop and mobile browsers

---

## How it works

```
Browser                   Google Apps Script          ClassiCube.net
  │                              │                          │
  │── (Google auto sign-in) ────►│ GAS enforces Google auth │
  │◄── page served ──────────────│                          │
  │                              │                          │
  │── login form ───────────────►│── POST /api/login/ ─────►│
  │◄── { username, verified } ───│◄─ session cookie ─────────│
  │   (session stored server-side, keyed by Google email)    │
  │                              │                          │
  │── loadServers ──────────────►│── GET /api/servers ──────►│
  │◄── server list ──────────────│◄─ JSON ───────────────────│
  │                              │                          │
  │── joinServer(hash) ─────────►│── GET /api/server/{hash} ►│
  │◄── ip, port, mppass ─────────│◄─ JSON ───────────────────│
  │                              │                          │
  │── getTexturePack ───────────►│ (served from 24h cache)  │
  │◄── base64 zip ───────────────│ or → /static/default.zip ►│
  │                              │
  │   ClassiCube.js loaded directly from cs.classicube.net
  │   Texture pack served as an in-memory Blob URL
```

Sessions expire after **1 hour** of inactivity. The session cookie is stored entirely server-side — nothing sensitive is stored in the browser.

---

## Setup

### Prerequisites

- A **Google account** (deployer)
- Access to [script.google.com](https://script.google.com)

### Step 1 – Create a new Apps Script project

1. Go to [script.google.com](https://script.google.com) and click **New project**.
2. Rename the project (e.g. *ClassiCube Web*) via **File → Rename**.

### Step 2 – Copy the files

The project requires three files. For each one, copy the content from this repository:

| File in this repo | What to do in the Apps Script editor |
|---|---|
| `Code.gs` | Paste into the default `Code.gs` file (replace all existing content) |
| `Index.html` | Click **＋ → HTML**, name it `Index`, paste the content |
| `appsscript.json` | Click **Project Settings** (⚙) → tick **Show "appsscript.json"** → paste the content into that file |

### Step 3 – Deploy as a web app

1. Click **Deploy → New deployment**.
2. Click the ⚙ gear icon next to *Select type* and choose **Web app**.
3. Fill in the form:
   - **Description**: anything you like (e.g. *v1*)
   - **Execute as**: *Me* (your Google account)
   - **Who has access**: *Anyone with a Google account* — this enforces Google sign-in for all visitors
4. Click **Deploy** and authorise the permissions when prompted.
5. Copy the **Web app URL** — this is the URL you (and others) will visit to play.

> **Note:** If you update the files later, click **Deploy → Manage deployments → Edit** and create a new version to apply your changes.

---

## Usage

Open the Web app URL in any modern browser. Google will redirect unauthenticated visitors to sign in automatically.

### Playing singleplayer (no ClassiCube account needed)
1. On the login screen, click **Play Singleplayer (no ClassiCube account)**.
2. Your Google username (the part of your email before `@`) is used as your in-game display name.

### Playing singleplayer (with ClassiCube account)
1. Sign in with your ClassiCube credentials.
2. Click **Play Singleplayer**.

### Joining a multiplayer server
1. Sign in with your ClassiCube account (an unverified account cannot join servers).
2. Click **Browse Multiplayer Servers**.
3. Use the search box to filter, then click **Join** next to the server you want.

### Exiting the game
Click **✕ Exit** in the toolbar above the canvas. The page reloads and returns you to the home screen (your ClassiCube session is preserved server-side for 1 hour).

---

## Limitations & notes

| Item | Detail |
|---|---|
| Google account required | All visitors must sign in with a Google account before the app loads. |
| Session lifetime | ClassiCube sessions expire after 1 hour of inactivity. After that, you will need to sign in to ClassiCube again (Google sign-in is not affected). |
| Login rate-limiting | Login attempts are capped at 5 per 10-minute window per Google account. |
| Texture pack caching | `default.zip` is cached for 24 hours in the script-level cache. Entries larger than ~100 KB may not be cached (GAS limit); in that case it is re-fetched each game session. |
| UrlFetchApp quota | GAS consumer accounts allow ~20,000 external URL fetches per day. |
| Execution time | Each GAS function call must complete within 30 seconds — well within normal limits. |
| ClassiCube.js | Loaded directly from `cs.classicube.net/client/latest/ClassiCube.js`. |
| Multiplayer | Requires a verified ClassiCube account (verify your email at classicube.net). |
| HTTPS | GAS web apps are always served over HTTPS. |

---

## File overview

```
Code.gs           Google Apps Script backend
                  • doGet()                — serves Index.html
                  • getGoogleUser()        — returns the signed-in Google user's email
                  • loginToClassiCube()    — validates input, rate-limits, authenticates
                  • checkCcSession()       — checks / refreshes per-user CC session
                  • logoutCcSession()      — clears the server-side CC session
                  • getServerList()        — proxies /api/servers
                  • getServerInfo(hash)    — proxies /api/server/{hash} (returns mppass)
                  • getTexturePack()       — proxies default.zip as base64 (24h cache)

Index.html        Single-page front-end
                  • Shows Google account email in the header
                  • Login screen (ClassiCube credentials or singleplayer-only)
                  • Home screen (singleplayer / browse servers)
                  • Server browser with search/filter and session expiry handling
                  • Fullscreen game canvas with XHR/fetch patch for texture pack

appsscript.json   GAS project manifest
                  • access: ANYONE — requires Google account
                  • Explicit OAuth scopes declared
```

---

## Credits

- [ClassiCube](https://www.classicube.net) by UnknownShadow200 & contributors
- Hosting documentation: [ClassiCube/ClassiCube — doc/hosting-webclient.md](https://github.com/ClassiCube/ClassiCube/blob/master/doc/hosting-webclient.md)
