# ClassiCube Web (Google Apps Script)

A self-contained rehost of the [ClassiCube](https://www.classicube.net) web client, designed to run entirely on **Google Apps Script** (GAS). No separate web server is needed.

## Features

- **Sign in** with your ClassiCube account (username + password)
- **Play singleplayer** with no account required (guest mode)
- **Browse & join multiplayer servers** – the backend authenticates with ClassiCube.net server-side and returns the `mppass` needed to connect
- Texture pack is fetched server-side and delivered as a Blob URL, eliminating any cross-origin issues
- Responsive dark-theme UI; works on desktop and mobile browsers

---

## How it works

```
Browser                   Google Apps Script          ClassiCube.net
  │                              │                          │
  │── login form ───────────────►│── POST /api/login/ ─────►│
  │◄── sessionToken (UUID) ──────│◄─ session cookie ─────────│
  │                              │                          │
  │── loadServers ──────────────►│── GET /api/servers ──────►│
  │◄── server list ──────────────│◄─ JSON ───────────────────│
  │                              │                          │
  │── joinServer(hash) ─────────►│── GET /api/server/{hash} ►│
  │◄── ip, port, mppass ─────────│◄─ JSON ───────────────────│
  │                              │                          │
  │── getTexturePack ───────────►│── GET /static/default.zip►│
  │◄── base64 zip ───────────────│◄─ binary ─────────────────│
  │                              │
  │   ClassiCube.js loaded directly from cs.classicube.net
  │   Texture pack served as an in-memory Blob URL
```

The GAS session cache stores each user's ClassiCube session cookie server-side, keyed by a random UUID that is kept in the browser's `localStorage`. Sessions expire after **1 hour** of inactivity.

---

## Setup

### Prerequisites

- A **Google account**
- Access to [script.google.com](https://script.google.com)

### Step 1 – Create a new Apps Script project

1. Go to [script.google.com](https://script.google.com) and click **New project**.
2. Rename the project (e.g. *ClassiCube Web*) via **File → Rename**.

### Step 2 – Copy the files

The project requires three files. For each one, copy the content from this repository:

| File in this repo | What to do in the Apps Script editor |
|---|---|
| `Code.gs` | Paste into the default `Code.gs` file (replace all existing content) |
| `Index.html` | Click **＋ → HTML** , name it `Index`, paste the content |
| `appsscript.json` | Click **Project Settings** (⚙) → tick **Show "appsscript.json"** → paste the content into that file |

### Step 3 – Deploy as a web app

1. Click **Deploy → New deployment**.
2. Click the ⚙ gear icon next to *Select type* and choose **Web app**.
3. Fill in the form:
   - **Description**: anything you like (e.g. *v1*)
   - **Execute as**: *Me* (your Google account)
   - **Who has access**: *Anyone* (no Google sign-in required for players)
4. Click **Deploy** and authorise the permissions when prompted.
5. Copy the **Web app URL** – this is the URL you (and others) will visit to play.

> **Note:** If you update the files later, click **Deploy → Manage deployments → Edit** and create a new version to apply your changes.

---

## Usage

Open the Web app URL in any modern browser.

### Playing singleplayer
1. Click **Continue as Guest** and enter a display name, _or_ sign in with your ClassiCube account.
2. Click **Play Singleplayer**.

### Joining a multiplayer server
1. Sign in with your ClassiCube account (an unverified account cannot join servers).
2. Click **Browse Multiplayer Servers**.
3. Use the search box to filter, then click **Join** next to the server you want.

### Exiting the game
Click **✕ Exit** in the toolbar above the canvas. The page reloads and returns you to the home screen (you will still be signed in).

---

## Limitations & notes

| Item | Detail |
|---|---|
| Session lifetime | GAS script cache entries expire after 1 hour. After that, you will need to sign in again. |
| UrlFetchApp quota | GAS consumer accounts allow ~20,000 external URL fetches per day. The texture pack is fetched once per game session. |
| Execution time | Each GAS function call (login, server list, texture fetch) must complete within 30 seconds. This is well within normal limits. |
| ClassiCube.js | Loaded directly from `cs.classicube.net/client/latest/ClassiCube.js`. No copy is stored here. |
| Texture pack | Fetched from `classicube.net/static/default.zip` on each game start and delivered as an in-memory Blob URL. |
| Multiplayer | Requires a verified ClassiCube account (verify your email at classicube.net). |
| HTTPS | GAS web apps are always served over HTTPS. |

---

## File overview

```
Code.gs           Google Apps Script backend
                  • doGet()             — serves Index.html
                  • loginToClassiCube() — authenticates with classicube.net API
                  • verifySession()     — checks / refreshes a session token
                  • getServerList()     — proxies /api/servers
                  • getServerInfo()     — proxies /api/server/{hash} (returns mppass)
                  • getTexturePack()    — proxies default.zip as base64

Index.html        Single-page front-end
                  • Login screen
                  • Home screen (singleplayer / browse servers)
                  • Server browser with search/filter
                  • Fullscreen game canvas

appsscript.json   GAS project manifest (webapp settings)
```

---

## Credits

- [ClassiCube](https://www.classicube.net) by UnknownShadow200 & contributors
- Hosting documentation: [ClassiCube/ClassiCube — doc/hosting-webclient.md](https://github.com/ClassiCube/ClassiCube/blob/master/doc/hosting-webclient.md)
