'use strict';

const path = require('path');
const {
  app, Tray, Menu, BrowserWindow, nativeImage, ipcMain, shell, Notification,
} = require('electron');

const store = require('./store');
const spotify = require('./spotify');
const lyrics = require('./lyrics');
const { DiscordPresence } = require('./discord');

// Keep the app tray-only (no dock/taskbar entry beyond the tray).
if (process.platform === 'darwin' && app.dock) app.dock.hide();

let tray = null;
let settingsWin = null;
const discord = new DiscordPresence();

// ---- Runtime state -------------------------------------------------------
const state = {
  running: false,
  connectingSpotify: false,
  token: null, // { accessToken, refreshToken, expiresAt }
  currentTrackId: null,
  loadedLyrics: { synced: [], plain: null, instrumental: false },
  // Playback baseline for local interpolation between Spotify polls.
  baseProgressMs: 0,
  baseAt: 0, // Date.now() when baseProgressMs was captured.
  durationMs: 0,
  isPlaying: false,
  trackLabel: '', // "artist – track" cache for state line.
  artist: '',
  track: '',
  lastPushedText: '',
  lastPushAt: 0,
  pushTimes: [], // Timestamps of recent activity pushes (rolling 20s window).
  statusText: 'Idle',
};

let fastTimer = null;
let slowTimer = null;

// Discord hard-caps Rich Presence activity updates at ~5 per 20s. We push as
// fast as that allows: at least 2s apart AND never more than 5 within any 20s
// window. Going faster just makes Discord silently drop updates, so this is the
// real floor. Lyric *detection* still runs every 1s (see fastTimer).
const MIN_PUSH_INTERVAL_MS = 2000;
const PUSH_WINDOW_MS = 20000;
const PUSH_WINDOW_MAX = 5;
const SLOW_POLL_MS = 5000; // Spotify currently-playing poll cadence.

// ---- Token handling ------------------------------------------------------
async function ensureAccessToken() {
  const clientId = store.get('spotifyClientId');
  const refreshToken = store.get('spotifyRefreshToken');
  if (!clientId || !refreshToken) return null;

  if (state.token && state.token.expiresAt - Date.now() > 30000) {
    return state.token.accessToken;
  }
  const t = await spotify.refresh(clientId, refreshToken);
  state.token = t;
  if (t.refreshToken !== refreshToken) store.set('spotifyRefreshToken', t.refreshToken);
  return t.accessToken;
}

// ---- Core loop -----------------------------------------------------------
async function pollSpotify() {
  let accessToken;
  try {
    accessToken = await ensureAccessToken();
  } catch (e) {
    setStatus('Spotify auth error — reconnect in Settings');
    return;
  }
  if (!accessToken) {
    setStatus('Not connected to Spotify');
    return;
  }

  let now;
  try {
    now = await spotify.getCurrentlyPlaying(accessToken);
  } catch (e) {
    if (e.code === 'TOKEN_EXPIRED') {
      state.token = null; // Force refresh next tick.
      return;
    }
    setStatus('Spotify request failed');
    return;
  }

  if (!now) {
    // Nothing playing.
    state.isPlaying = false;
    state.currentTrackId = null;
    if (store.get('idleClearsActivity')) {
      await discord.clear();
      state.lastPushedText = '';
    }
    setStatus('Nothing playing on Spotify');
    return;
  }

  state.isPlaying = now.isPlaying;
  state.durationMs = now.durationMs;
  state.baseProgressMs = now.progressMs;
  state.baseAt = Date.now();
  state.artist = now.artist;
  state.track = now.track;
  state.trackLabel = now.artist + ' – ' + now.track;

  if (now.trackId !== state.currentTrackId) {
    state.currentTrackId = now.trackId;
    state.loadedLyrics = { synced: [], plain: null, instrumental: false };
    setStatus('Loading lyrics: ' + now.track);
    try {
      state.loadedLyrics = await lyrics.loadLyrics({
        artist: now.artist,
        track: now.track,
        album: now.album,
        durationMs: now.durationMs,
      });
    } catch (_) {
      state.loadedLyrics = { synced: [], plain: null, instrumental: false };
    }
  }
}

function estimatedProgressMs() {
  if (!state.isPlaying) return state.baseProgressMs;
  return state.baseProgressMs + (Date.now() - state.baseAt);
}

async function tick() {
  if (!state.running) return;

  const synced = state.loadedLyrics.synced;
  const hasSynced = synced && synced.length > 0;

  let details = '';
  if (state.isPlaying && hasSynced) {
    details = lyrics.lineAt(synced, estimatedProgressMs());
  }

  // Decide what to show.
  let text;
  if (details) {
    text = fill(store.get('detailsTemplate'), details);
  } else if (state.loadedLyrics.instrumental) {
    text = '🎵 (instrumental)';
  } else if (store.get('showTrackWhenNoLyrics') && state.track) {
    text = state.track;
  } else {
    text = '';
  }

  if (!state.isPlaying) {
    updateTrayTitle();
    return; // Leave last activity; don't spam updates while paused.
  }

  const stateLine = fill(store.get('stateTemplate'), '');
  const now = Date.now();
  state.pushTimes = state.pushTimes.filter((t) => now - t < PUSH_WINDOW_MS);
  const underWindow = state.pushTimes.length < PUSH_WINDOW_MAX;

  if (
    text !== state.lastPushedText &&
    now - state.lastPushAt >= MIN_PUSH_INTERVAL_MS &&
    underWindow
  ) {
    state.lastPushedText = text;
    state.lastPushAt = now;
    state.pushTimes.push(now);
    try {
      await discord.setActivity({
        details: text || state.track || 'Listening',
        state: stateLine,
        largeImageKey: store.get('largeImageKey') || undefined,
        largeImageText: fill(store.get('largeImageText'), text) || undefined,
      });
      setStatus('▶ ' + (text || state.track));
    } catch (_) {
      setStatus('Discord not connected — open Discord desktop');
    }
  } else {
    updateTrayTitle();
  }
}

function fill(template, line) {
  return String(template || '')
    .replace(/\{line\}/g, line)
    .replace(/\{track\}/g, state.track)
    .replace(/\{artist\}/g, state.artist)
    .trim();
}

// ---- Start / stop --------------------------------------------------------
async function start() {
  if (state.running) return;
  const discordClientId = store.get('discordClientId');
  if (!discordClientId) {
    notify('Set your Discord Application ID in Settings first.');
    openSettings();
    return;
  }
  try {
    await discord.connect(discordClientId);
  } catch (e) {
    notify('Could not connect to Discord. Is the Discord desktop app running?');
    return;
  }
  state.running = true;
  setStatus('Running');
  await pollSpotify();
  slowTimer = setInterval(pollSpotify, SLOW_POLL_MS);
  fastTimer = setInterval(tick, 1000);
  rebuildTray();
}

async function stop() {
  state.running = false;
  if (slowTimer) clearInterval(slowTimer);
  if (fastTimer) clearInterval(fastTimer);
  slowTimer = fastTimer = null;
  await discord.clear();
  state.lastPushedText = '';
  setStatus('Stopped');
  rebuildTray();
}

// ---- Spotify connect flow ------------------------------------------------
async function connectSpotify() {
  const clientId = store.get('spotifyClientId');
  if (!clientId) {
    notify('Enter your Spotify Client ID in Settings first.');
    openSettings();
    return;
  }
  if (state.connectingSpotify) return;
  state.connectingSpotify = true;
  setStatus('Waiting for Spotify authorization in your browser…');
  try {
    const tokens = await spotify.authorize(clientId);
    state.token = tokens;
    store.set('spotifyRefreshToken', tokens.refreshToken);
    notify('Spotify connected ✓');
    setStatus('Spotify connected');
    if (settingsWin) settingsWin.webContents.send('config-changed', publicConfig());
  } catch (e) {
    notify('Spotify connection failed: ' + e.message);
    setStatus('Spotify connection failed');
  } finally {
    state.connectingSpotify = false;
    rebuildTray();
  }
}

// ---- Tray + windows ------------------------------------------------------
function trayIcon() {
  // A tiny embedded PNG so we don't ship a binary asset. 16x16 green dot.
  const b64 =
    'iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAYAAAAf8/9hAAAApElEQVR4nGNgGAWjYBSMglEw' +
    'CkbBKBgFo2AUjIJRMApGwSgYBaNgFIyCUTAKRsEoGAWjYBSMglEwCkbBKBgFo2AUjIJRMApG' +
    'wSgYBaNgFIyCUTAKRsEoGAWjYBSMglEwCkbBKBgFo2AUjIJRMApGwSgYBaNgFIyCUTAKRsEo' +
    'GAWjYBSMglEwCkbBKBgFo2AUjIJRMApGwSgYBaNgFAwPAAD9dAKBTeQKQQAAAABJRU5ErkJg' +
    'gg==';
  return nativeImage.createFromBuffer(Buffer.from(b64, 'base64'));
}

function rebuildTray() {
  if (!tray) return;
  const connected = Boolean(store.get('spotifyRefreshToken'));
  const menu = Menu.buildFromTemplate([
    { label: 'Lyric Presence', enabled: false },
    { label: state.statusText, enabled: false },
    { type: 'separator' },
    state.running
      ? { label: 'Stop', click: () => stop() }
      : { label: 'Start', click: () => start() },
    {
      label: connected ? 'Reconnect Spotify' : 'Connect Spotify…',
      click: () => connectSpotify(),
    },
    { label: 'Settings…', click: () => openSettings() },
    { type: 'separator' },
    { label: 'Quit', click: () => { app.isQuitting = true; app.quit(); } },
  ]);
  tray.setContextMenu(menu);
  updateTrayTitle();
}

function updateTrayTitle() {
  if (!tray) return;
  tray.setToolTip('Lyric Presence — ' + state.statusText);
}

function setStatus(text) {
  state.statusText = text;
  if (settingsWin) settingsWin.webContents.send('status', text);
  rebuildTrayThrottled();
}

let trayThrottle = 0;
function rebuildTrayThrottled() {
  const now = Date.now();
  if (now - trayThrottle > 1500) {
    trayThrottle = now;
    rebuildTray();
  }
}

function openSettings() {
  if (settingsWin) {
    settingsWin.show();
    settingsWin.focus();
    return;
  }
  settingsWin = new BrowserWindow({
    width: 560,
    height: 640,
    title: 'Lyric Presence — Settings',
    resizable: false,
    webPreferences: { preload: path.join(__dirname, 'preload.js') },
  });
  settingsWin.setMenuBarVisibility(false);
  settingsWin.loadFile(path.join(__dirname, '..', 'renderer', 'settings.html'));
  settingsWin.on('closed', () => { settingsWin = null; });
}

function publicConfig() {
  return {
    spotifyClientId: store.get('spotifyClientId'),
    discordClientId: store.get('discordClientId'),
    detailsTemplate: store.get('detailsTemplate'),
    stateTemplate: store.get('stateTemplate'),
    largeImageKey: store.get('largeImageKey'),
    largeImageText: store.get('largeImageText'),
    showTrackWhenNoLyrics: store.get('showTrackWhenNoLyrics'),
    idleClearsActivity: store.get('idleClearsActivity'),
    spotifyConnected: Boolean(store.get('spotifyRefreshToken')),
    running: state.running,
  };
}

function notify(body) {
  try {
    if (Notification.isSupported()) new Notification({ title: 'Lyric Presence', body }).show();
  } catch (_) {}
}

// ---- IPC -----------------------------------------------------------------
ipcMain.handle('get-config', () => publicConfig());
ipcMain.handle('save-config', (_e, cfg) => {
  store.set('spotifyClientId', (cfg.spotifyClientId || '').trim());
  store.set('discordClientId', (cfg.discordClientId || '').trim());
  store.set('detailsTemplate', cfg.detailsTemplate || '{line}');
  store.set('stateTemplate', cfg.stateTemplate || '{artist} – {track}');
  store.set('largeImageKey', (cfg.largeImageKey || '').trim());
  store.set('largeImageText', cfg.largeImageText || '');
  store.set('showTrackWhenNoLyrics', Boolean(cfg.showTrackWhenNoLyrics));
  store.set('idleClearsActivity', Boolean(cfg.idleClearsActivity));
  return publicConfig();
});
ipcMain.handle('connect-spotify', () => connectSpotify());
ipcMain.handle('toggle-run', async () => {
  if (state.running) await stop(); else await start();
  return state.running;
});
ipcMain.handle('open-external', (_e, url) => shell.openExternal(url));

// ---- Lifecycle -----------------------------------------------------------
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', () => openSettings());

  app.whenReady().then(() => {
    tray = new Tray(trayIcon());
    rebuildTray();
    tray.on('click', () => openSettings());

    if (!store.get('spotifyClientId') || !store.get('discordClientId')) {
      openSettings();
    }
  });

  app.on('window-all-closed', (e) => {
    // Stay alive in the tray.
  });

  app.on('before-quit', async () => {
    app.isQuitting = true;
    try { await discord.disconnect(); } catch (_) {}
  });
}
