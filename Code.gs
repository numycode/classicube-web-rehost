// ============================================================
// ClassiCube Web — Google Apps Script backend
// ============================================================
// Authenticates users with ClassiCube.net, proxies the server
// list, and serves the default texture pack so the client can
// load it without hitting cross-origin restrictions.
//
// Requires a Google account to access (appsscript.json access: ANYONE).
// Each user's ClassiCube session is stored in the script-level cache
// under a key derived from their verified Google email address, so
// sessions are isolated per user with no shared state.
// ============================================================

var CC_BASE          = 'https://www.classicube.net';
var SESSION_TTL      = 3600;   // seconds — ClassiCube session cookie lifetime
var TEXTURE_PACK_TTL = 86400;  // seconds — texture pack is cached for 24 hours
var RATE_LIMIT_MAX   = 5;      // max CC login attempts per window
var RATE_LIMIT_TTL   = 600;    // seconds — rate-limit window (10 minutes)
var MAX_PASSWORD_LEN = 200;    // generous upper bound; CC passwords are typically much shorter

// Valid ClassiCube username: 1–16 chars, letters/digits/underscores
var USERNAME_RE  = /^[A-Za-z0-9_]{1,16}$/;
// Server hashes returned by the ClassiCube API are 32-char hex strings
var SERVER_HASH_RE = /^[0-9a-f]{32}$/i;

// ============================================================
// Web-app entry point
// ============================================================

function doGet() {
  return HtmlService.createHtmlOutputFromFile('Index')
    .setTitle('ClassiCube Web')
    .addMetaTag('viewport',                     'width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=no')
    .addMetaTag('apple-mobile-web-app-capable', 'yes')
    .addMetaTag('mobile-web-app-capable',       'yes')
    .setSandboxMode(HtmlService.SandboxMode.IFRAME)
    .setXFrameOptionsMode(HtmlService.XFrameOptionsMode.ALLOWALL);
}

// ============================================================
// Google identity
// ============================================================

/**
 * Return the authenticated Google user's email address.
 * Because the web app is deployed with access: ANYONE, GAS guarantees
 * that every caller is signed in; this function exposes that identity
 * to the front-end so it can display who is logged in.
 *
 * Returns { email } or { email: null } if somehow unavailable.
 */
function getGoogleUser() {
  var email = getCurrentUserEmail_();
  return { email: email };
}

// ============================================================
// ClassiCube authentication
// ============================================================

/**
 * Authenticate with ClassiCube.net on behalf of the current Google user.
 *
 * Flow (per the ClassiCube Web API docs):
 *   1. GET /api/login/ → JSON { token } + "session" cookie
 *   2. POST /api/login/ with username, password, token → JSON { username, authenticated, errors }
 *      If errors contains "login_code", a 2FA/email code is required.
 *   3. (optional) Re-call with loginCode populated to complete 2FA.
 *
 * Returns:
 *   { success: true,  username, verified }
 *   { success: false, needsTwoFactor: true }   — 2FA code required
 *   { success: false, error }
 */
function loginToClassiCube(username, password, loginCode) {
  var callerEmail = getCurrentUserEmail_();

  // Input validation
  if (!username || !USERNAME_RE.test(username)) {
    return { success: false, error: 'Invalid username. Use 1–16 letters, digits, or underscores.' };
  }
  if (!password || typeof password !== 'string' || password.length < 1 || password.length > MAX_PASSWORD_LEN) {
    return { success: false, error: 'Invalid password.' };
  }

  // Rate limiting — prevent brute-force attacks
  var rlResult = checkRateLimit_(callerEmail);
  if (!rlResult.allowed) {
    return {
      success: false,
      error:   'Too many login attempts. Please wait ' + rlResult.waitSeconds + ' seconds before trying again.'
    };
  }

  try {
    // ---- Step 1: obtain CSRF token and initial session cookie ----
    var getResp = UrlFetchApp.fetch(CC_BASE + '/api/login/', {
      muteHttpExceptions: true
    });

    if (getResp.getResponseCode() !== 200) {
      return { success: false, error: 'Unable to reach ClassiCube.net. Please try again later.' };
    }

    var getJson = JSON.parse(getResp.getContentText());
    if (!getJson.token) {
      return { success: false, error: 'Failed to retrieve the login token from ClassiCube.' };
    }

    var getCookies = parseCookieHeaders_(getResp.getAllHeaders()['Set-Cookie']);

    // ---- Step 2: submit credentials ----
    var postPayload = { username: username, password: password, token: getJson.token };
    if (loginCode && typeof loginCode === 'string' && loginCode.trim().length > 0) {
      postPayload.login_code = loginCode.trim();
    }
    var postResp = UrlFetchApp.fetch(CC_BASE + '/api/login/', {
      method:             'post',
      payload:            postPayload,
      headers: {
        'Cookie':  cookiesToHeader_(getCookies),
        'Referer': CC_BASE + '/api/login/'
      },
      followRedirects:    false,
      muteHttpExceptions: true
    });

    var postJson = JSON.parse(postResp.getContentText());

    // Map API error keys to user-readable messages
    var errorLabels = {
      token:        'Invalid login token — please try again.',
      username:     'That username does not exist.',
      password:     'Incorrect password.',
      verification: 'Your ClassiCube account has not been verified yet (check your email). ' +
                    'You can still play singleplayer, but multiplayer requires a verified account.',
      login_code:   'A two-factor authentication code is required.'
    };

    var errors = postJson.errors || [];
    // "login_code" signals that a 2FA code is required — tell the front-end to prompt for it
    if (errors.indexOf('login_code') !== -1) {
      return { success: false, needsTwoFactor: true };
    }
    // "verification" is a soft error — login still succeeded but multiplayer is blocked
    var hardErrors = errors.filter(function (e) { return e !== 'verification'; });
    if (hardErrors.length > 0) {
      return {
        success: false,
        error: hardErrors.map(function (e) { return errorLabels[e] || e; }).join(' ')
      };
    }

    if (!postJson.authenticated || !postJson.username) {
      return { success: false, error: 'Login failed. Please check your credentials.' };
    }

    // Merge Set-Cookie headers from both responses and persist in the cache
    var postCookies = parseCookieHeaders_(postResp.getAllHeaders()['Set-Cookie']);
    var merged      = mergeCookieLists_(getCookies, postCookies);
    var verified    = errors.indexOf('verification') === -1;

    saveUserSession_(callerEmail, postJson.username, cookiesToHeader_(merged), verified);

    // On a successful login, clear the rate-limit counter for this user
    CacheService.getScriptCache().remove(rlKey_(callerEmail));

    return {
      success:  true,
      username: postJson.username,
      verified: verified
    };

  } catch (err) {
    console.error('loginToClassiCube error for ' + callerEmail + ': ' + err);
    return { success: false, error: 'Connection error. Please try again.' };
  }
}

/**
 * Check whether the current Google user already has a live ClassiCube session.
 * Refreshes the TTL on success.
 *
 * Returns { valid: true, username, verified } or { valid: false }.
 */
function checkCcSession() {
  var callerEmail = getCurrentUserEmail_();
  var session     = loadUserSession_(callerEmail);
  if (!session) return { valid: false };

  // Refresh the TTL so active users stay logged in
  saveUserSession_(callerEmail, session.username, session.cookie, session.verified);
  return { valid: true, username: session.username, verified: session.verified };
}

/**
 * Clear the current Google user's ClassiCube session.
 */
function logoutCcSession() {
  var callerEmail = getCurrentUserEmail_();
  clearUserSession_(callerEmail);
}

// ============================================================
// Server list
// ============================================================

/**
 * Fetch the public server list from ClassiCube.net.
 * Returns { success: true, servers: [...] } or { success: false, error }.
 */
function getServerList() {
  var callerEmail = getCurrentUserEmail_();
  var session     = loadUserSession_(callerEmail);
  if (!session) return { success: false, error: 'Session expired. Please sign in again.' };

  try {
    var resp = UrlFetchApp.fetch(CC_BASE + '/api/servers', {
      headers:            { 'Cookie': session.cookie },
      muteHttpExceptions: true
    });
    if (resp.getResponseCode() !== 200) {
      console.error('getServerList: unexpected status ' + resp.getResponseCode());
      return { success: false, error: 'Failed to load server list. Please try again.' };
    }
    var data = JSON.parse(resp.getContentText());
    saveUserSession_(callerEmail, session.username, session.cookie, session.verified);
    return { success: true, servers: data.servers || [] };
  } catch (err) {
    console.error('getServerList error: ' + err);
    return { success: false, error: 'Failed to load server list. Please try again.' };
  }
}

/**
 * Get connection details (including mppass) for a specific server.
 * Returns { success: true, name, ip, port, mppass } or { success: false, error }.
 */
function getServerInfo(serverHash) {
  if (!serverHash || !SERVER_HASH_RE.test(serverHash)) {
    return { success: false, error: 'Invalid server identifier.' };
  }

  var callerEmail = getCurrentUserEmail_();
  var session     = loadUserSession_(callerEmail);
  if (!session) return { success: false, error: 'Session expired. Please sign in again.' };

  try {
    var resp = UrlFetchApp.fetch(CC_BASE + '/api/server/' + serverHash, {
      headers:            { 'Cookie': session.cookie },
      muteHttpExceptions: true
    });
    if (resp.getResponseCode() !== 200) {
      return { success: false, error: 'Server not found.' };
    }
    var data = JSON.parse(resp.getContentText());
    if (!data.servers || data.servers.length === 0) {
      return { success: false, error: 'Server not found.' };
    }
    var s = data.servers[0];
    saveUserSession_(callerEmail, session.username, session.cookie, session.verified);
    return {
      success: true,
      name:    s.name,
      ip:      s.ip,
      port:    String(s.port || 25565),
      mppass:  s.mppass || ''
    };
  } catch (err) {
    console.error('getServerInfo error: ' + err);
    return { success: false, error: 'Failed to retrieve server details. Please try again.' };
  }
}

// ============================================================
// Texture-pack proxy
// ============================================================

/**
 * Download default.zip from classicube.net and return it as a base64 string
 * so the browser can create a same-origin Blob URL, sidestepping CORS.
 *
 * The result is cached script-wide for TEXTURE_PACK_TTL seconds (24 h) to
 * avoid an upstream fetch on every game launch.
 */
function getTexturePack() {
  var cache  = CacheService.getScriptCache();
  var cached = cache.get('cc_texture_pack');
  if (cached) return cached;

  try {
    var resp = UrlFetchApp.fetch('https://classicube.net/static/default.zip', {
      muteHttpExceptions: true
    });
    if (resp.getResponseCode() === 200) {
      var b64 = Utilities.base64Encode(resp.getContent());
      // cache.put silently discards values larger than 100 KB; that is acceptable
      try { cache.put('cc_texture_pack', b64, TEXTURE_PACK_TTL); } catch (e) { /* too large */ }
      return b64;
    }
    console.error('getTexturePack: unexpected status ' + resp.getResponseCode());
  } catch (e) {
    console.error('getTexturePack error: ' + e);
  }
  return null;
}

// ============================================================
// Private helpers
// ============================================================

/**
 * Return the verified Google email of the current caller.
 * Throws if unavailable (should never happen when access: ANYONE is set).
 */
function getCurrentUserEmail_() {
  var email = Session.getActiveUser().getEmail();
  if (!email) throw new Error('Google authentication required.');
  return email;
}

// ---- Session storage (email-keyed in ScriptCache) ----

function userCacheKey_(email, suffix) {
  // Using the email directly as a cache key is safe: it is server-side only
  // and already known to GAS via Session.getActiveUser().
  return 'cc_' + suffix + '_' + email;
}

function saveUserSession_(email, username, cookie, verified) {
  var cache   = CacheService.getScriptCache();
  var payload = JSON.stringify({ username: username, cookie: cookie, verified: !!verified });
  cache.put(userCacheKey_(email, 'session'), payload, SESSION_TTL);
}

function loadUserSession_(email) {
  var raw = CacheService.getScriptCache().get(userCacheKey_(email, 'session'));
  if (!raw) return null;
  try { return JSON.parse(raw); } catch (e) { return null; }
}

function clearUserSession_(email) {
  CacheService.getScriptCache().remove(userCacheKey_(email, 'session'));
}

// ---- Rate limiting ----

function rlKey_(email) { return 'cc_rl_' + email; }

/**
 * Check and increment the login attempt counter for this Google user.
 * Returns { allowed: true } or { allowed: false, waitSeconds }.
 */
function checkRateLimit_(email) {
  var cache   = CacheService.getScriptCache();
  var key     = rlKey_(email);
  var raw     = cache.get(key);
  var now     = Math.floor(Date.now() / 1000);
  var record  = raw ? JSON.parse(raw) : { count: 0, firstAttempt: now };

  if (record.count >= RATE_LIMIT_MAX) {
    var elapsed = now - record.firstAttempt;
    var wait    = RATE_LIMIT_TTL - elapsed;
    return { allowed: false, waitSeconds: wait > 0 ? wait : 0 };
  }

  record.count++;
  if (record.count === 1) record.firstAttempt = now;
  var ttl = RATE_LIMIT_TTL - (now - record.firstAttempt);
  cache.put(key, JSON.stringify(record), ttl > 0 ? ttl : RATE_LIMIT_TTL);
  return { allowed: true };
}

// ---- Cookie utilities ----

function parseCookieHeaders_(setCookieHeader) {
  var result = [];
  if (!setCookieHeader) return result;
  if (typeof setCookieHeader === 'string') setCookieHeader = [setCookieHeader];
  setCookieHeader.forEach(function (raw) {
    var kv  = raw.split(';')[0].trim();
    var idx = kv.indexOf('=');
    if (idx > 0) result.push({ name: kv.substring(0, idx).trim(), value: kv.substring(idx + 1).trim() });
  });
  return result;
}

function cookiesToHeader_(cookieList) {
  return cookieList.map(function (c) { return c.name + '=' + c.value; }).join('; ');
}

function mergeCookieLists_(base, updates) {
  var map = {};
  base.forEach(    function (c) { map[c.name] = c.value; });
  updates.forEach(function (c) { map[c.name] = c.value; });
  return Object.keys(map).map(function (k) { return { name: k, value: map[k] }; });
}

