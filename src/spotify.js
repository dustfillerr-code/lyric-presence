'use strict';

const crypto = require('crypto');
const http = require('http');
const { URL, URLSearchParams } = require('url');
const { shell } = require('electron');

const REDIRECT_URI = 'http://127.0.0.1:8888/callback';
const SCOPE = 'user-read-currently-playing user-read-playback-state';

function base64url(buf) {
  return buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function makePkcePair() {
  const verifier = base64url(crypto.randomBytes(64));
  const challenge = base64url(crypto.createHash('sha256').update(verifier).digest());
  return { verifier, challenge };
}

/**
 * Runs the Authorization Code + PKCE flow. Opens the user's browser, spins up a
 * one-shot loopback server to catch the redirect, then exchanges the code.
 * Returns { accessToken, refreshToken, expiresAt }.
 */
function authorize(clientId) {
  return new Promise((resolve, reject) => {
    const { verifier, challenge } = makePkcePair();
    const state = base64url(crypto.randomBytes(16));

    const server = http.createServer(async (req, res) => {
      try {
        const reqUrl = new URL(req.url, REDIRECT_URI);
        if (reqUrl.pathname !== '/callback') {
          res.writeHead(404).end();
          return;
        }
        const code = reqUrl.searchParams.get('code');
        const returnedState = reqUrl.searchParams.get('state');
        const err = reqUrl.searchParams.get('error');

        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(
          '<!doctype html><meta charset="utf-8"><title>Lyric Presence</title>' +
            '<body style="font-family:system-ui;background:#121212;color:#fff;display:grid;place-items:center;height:100vh;margin:0">' +
            '<div style="text-align:center"><h2>' +
            (err ? 'Authorization failed' : 'Connected ✓') +
            '</h2><p style="opacity:.7">You can close this tab and return to Lyric Presence.</p></div>'
        );

        server.close();
        if (err) return reject(new Error('Spotify authorization error: ' + err));
        if (!code || returnedState !== state) {
          return reject(new Error('Invalid authorization response (state mismatch).'));
        }

        const tokens = await exchangeCode(clientId, code, verifier);
        resolve(tokens);
      } catch (e) {
        try { server.close(); } catch (_) {}
        reject(e);
      }
    });

    server.on('error', reject);
    server.listen(8888, '127.0.0.1', () => {
      const authUrl = new URL('https://accounts.spotify.com/authorize');
      authUrl.search = new URLSearchParams({
        client_id: clientId,
        response_type: 'code',
        redirect_uri: REDIRECT_URI,
        code_challenge_method: 'S256',
        code_challenge: challenge,
        state,
        scope: SCOPE,
      }).toString();
      shell.openExternal(authUrl.toString());
    });

    // Safety timeout so we don't leave the loopback server dangling forever.
    setTimeout(() => {
      try { server.close(); } catch (_) {}
      reject(new Error('Authorization timed out (no response within 3 minutes).'));
    }, 3 * 60 * 1000).unref();
  });
}

async function exchangeCode(clientId, code, verifier) {
  const body = new URLSearchParams({
    grant_type: 'authorization_code',
    code,
    redirect_uri: REDIRECT_URI,
    client_id: clientId,
    code_verifier: verifier,
  });
  const res = await fetch('https://accounts.spotify.com/api/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body,
  });
  if (!res.ok) throw new Error('Token exchange failed: ' + res.status + ' ' + (await res.text()));
  const json = await res.json();
  return {
    accessToken: json.access_token,
    refreshToken: json.refresh_token,
    expiresAt: Date.now() + json.expires_in * 1000,
  };
}

/** Trades a refresh token for a fresh access token. Spotify may rotate the refresh token. */
async function refresh(clientId, refreshToken) {
  const body = new URLSearchParams({
    grant_type: 'refresh_token',
    refresh_token: refreshToken,
    client_id: clientId,
  });
  const res = await fetch('https://accounts.spotify.com/api/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body,
  });
  if (!res.ok) throw new Error('Token refresh failed: ' + res.status + ' ' + (await res.text()));
  const json = await res.json();
  return {
    accessToken: json.access_token,
    refreshToken: json.refresh_token || refreshToken,
    expiresAt: Date.now() + json.expires_in * 1000,
  };
}

/**
 * Returns the currently playing item, or null when nothing is playing.
 * { isPlaying, progressMs, durationMs, trackId, track, artist, album }
 */
async function getCurrentlyPlaying(accessToken) {
  const res = await fetch('https://api.spotify.com/v1/me/player/currently-playing', {
    headers: { Authorization: 'Bearer ' + accessToken },
  });
  if (res.status === 204) return null; // Nothing playing.
  if (res.status === 401) {
    const e = new Error('Access token expired');
    e.code = 'TOKEN_EXPIRED';
    throw e;
  }
  if (!res.ok) throw new Error('currently-playing failed: ' + res.status);

  const json = await res.json();
  const item = json.item;
  if (!item) return null; // e.g. a podcast episode with no track item.

  return {
    isPlaying: Boolean(json.is_playing),
    progressMs: json.progress_ms || 0,
    durationMs: item.duration_ms || 0,
    trackId: item.id,
    track: item.name,
    artist: (item.artists || []).map((a) => a.name).join(', '),
    album: item.album ? item.album.name : '',
  };
}

module.exports = { authorize, refresh, getCurrentlyPlaying };
