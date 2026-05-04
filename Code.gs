// ============================================================
// ClassiCube Web — Google Apps Script backend
// ============================================================
// Authenticates users with ClassiCube.net, proxies the server
// list, and serves the default texture pack so the client can
// load it without hitting cross-origin restrictions.
// ============================================================

var CC_BASE    = 'https://www.classicube.net';
var SESSION_TTL = 3600; // seconds (1 hour)

// ------------------------------------------------------------
// Web-app entry point
// ------------------------------------------------------------

function doGet() {
  return HtmlService.createHtmlOutputFromFile('Index')
    .setTitle('ClassiCube Web')
    .addMetaTag('viewport',                 'width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=no')
    .addMetaTag('apple-mobile-web-app-capable', 'yes')
    .addMetaTag('mobile-web-app-capable',   'yes')
    .setSandboxMode(HtmlService.SandboxMode.IFRAME)
    .setXFrameOptionsMode(HtmlService.XFrameOptionsMode.ALLOWALL);
}

// ------------------------------------------------------------
// Authentication
// ------------------------------------------------------------

/**
 * Authenticate with ClassiCube.net.
 *
 * Flow (per the ClassiCube Web API docs):
 *   1. GET /api/login/ → JSON { token, ... } + "session" cookie
 *   2. POST /api/login/ with username, password, token → JSON { username, authenticated, errors }
 *
 * Returns:
 *   { success: true,  username, sessionToken, verified }
 *   { success: false, error }
 */
function loginToClassiCube(username, password) {
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
    var postResp = UrlFetchApp.fetch(CC_BASE + '/api/login/', {
      method:          'post',
      payload:         { username: username, password: password, token: getJson.token },
      headers: {
        'Cookie':   cookiesToHeader_(getCookies),
        'Referer':  CC_BASE + '/api/login/'
      },
      followRedirects:  false,
      muteHttpExceptions: true
    });

    var postJson = JSON.parse(postResp.getContentText());

    // Map API error keys to user-readable messages
    var errorLabels = {
      token:        'Invalid login token — please try again.',
      username:     'That username does not exist.',
      password:     'Incorrect password.',
      verification: 'Your account has not been verified yet (check your email). ' +
                    'You can still play singleplayer, but multiplayer requires a verified account.'
    };

    var errors = postJson.errors || [];
    // "verification" is a soft error — login still succeeded
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

    // Merge Set-Cookie headers from both responses
    var postCookies = parseCookieHeaders_(postResp.getAllHeaders()['Set-Cookie']);
    var merged      = mergeCookieLists_(getCookies, postCookies);

    // Store the merged session cookie in GAS Script Cache, keyed by a UUID
    var sessionToken = Utilities.getUuid();
    var cache        = CacheService.getScriptCache();
    cache.put('cc_cookie_' + sessionToken, cookiesToHeader_(merged), SESSION_TTL);
    cache.put('cc_user_'   + sessionToken, postJson.username,        SESSION_TTL);

    return {
      success:      true,
      username:     postJson.username,
      sessionToken: sessionToken,
      verified:     errors.indexOf('verification') === -1
    };

  } catch (err) {
    return { success: false, error: 'Connection error: ' + err.message };
  }
}

/**
 * Verify that a GAS session token is still alive (also refreshes its TTL).
 * Returns { valid: true, username } or { valid: false }.
 */
function verifySession(sessionToken) {
  if (!sessionToken) return { valid: false };
  var cache    = CacheService.getScriptCache();
  var username = cache.get('cc_user_' + sessionToken);
  if (!username) return { valid: false };
  refreshSession_(sessionToken);
  return { valid: true, username: username };
}

// ------------------------------------------------------------
// Server list
// ------------------------------------------------------------

/**
 * Fetch the public server list from ClassiCube.net.
 * Returns { success: true, servers: [...] } or { success: false, error }.
 */
function getServerList(sessionToken) {
  var cookie = sessionCookie_(sessionToken);
  if (!cookie) return { success: false, error: 'Session expired. Please log in again.' };

  try {
    var resp = UrlFetchApp.fetch(CC_BASE + '/api/servers', {
      headers: { 'Cookie': cookie },
      muteHttpExceptions: true
    });
    var data = JSON.parse(resp.getContentText());
    refreshSession_(sessionToken);
    return { success: true, servers: data.servers || [] };
  } catch (err) {
    return { success: false, error: err.message };
  }
}

/**
 * Get connection details (including mppass) for a specific server.
 * Returns { success: true, name, ip, port, mppass } or { success: false, error }.
 */
function getServerInfo(sessionToken, serverHash) {
  var cookie = sessionCookie_(sessionToken);
  if (!cookie) return { success: false, error: 'Session expired. Please log in again.' };

  try {
    var resp = UrlFetchApp.fetch(CC_BASE + '/api/server/' + serverHash, {
      headers: { 'Cookie': cookie },
      muteHttpExceptions: true
    });
    var data = JSON.parse(resp.getContentText());
    if (!data.servers || data.servers.length === 0) {
      return { success: false, error: 'Server not found.' };
    }
    var s = data.servers[0];
    refreshSession_(sessionToken);
    return {
      success: true,
      name:    s.name,
      ip:      s.ip,
      port:    String(s.port || 25565),
      mppass:  s.mppass || ''
    };
  } catch (err) {
    return { success: false, error: err.message };
  }
}

// ------------------------------------------------------------
// Texture-pack proxy
// ------------------------------------------------------------

/**
 * Download default.zip from classicube.net and return it as a
 * base64 string so the browser can create a same-origin Blob URL.
 * This sidesteps any CORS restriction on the classicube.net CDN.
 */
function getTexturePack() {
  try {
    var resp = UrlFetchApp.fetch('https://classicube.net/static/default.zip', {
      muteHttpExceptions: true
    });
    if (resp.getResponseCode() === 200) {
      return Utilities.base64Encode(resp.getContent());
    }
    Logger.log('getTexturePack: unexpected status ' + resp.getResponseCode());
  } catch (e) {
    Logger.log('getTexturePack error: ' + e);
  }
  return null;
}

// ------------------------------------------------------------
// Private helpers
// ------------------------------------------------------------

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

function mergeCookieLists_(base, override) {
  var map = {};
  base.forEach(    function (c) { map[c.name] = c.value; });
  override.forEach(function (c) { map[c.name] = c.value; });
  return Object.keys(map).map(function (k) { return { name: k, value: map[k] }; });
}

function sessionCookie_(token) {
  if (!token) return null;
  return CacheService.getScriptCache().get('cc_cookie_' + token);
}

function refreshSession_(token) {
  var cache  = CacheService.getScriptCache();
  var cookie = cache.get('cc_cookie_' + token);
  var user   = cache.get('cc_user_'   + token);
  if (cookie && user) {
    cache.put('cc_cookie_' + token, cookie, SESSION_TTL);
    cache.put('cc_user_'   + token, user,   SESSION_TTL);
  }
}
