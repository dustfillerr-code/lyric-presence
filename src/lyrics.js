'use strict';

/**
 * Lyrics come from LRCLIB (https://lrclib.net) — a free, open, crowd-sourced
 * lyrics database with no auth. We fetch time-synced ("LRC") lyrics keyed by
 * track/artist/duration and, at runtime, surface only the single line that
 * matches the current playback position. No lyrics are ever stored to disk or
 * bundled with the app.
 */

const USER_AGENT = 'LyricPresence/0.1.0 (https://github.com/local/lyric-presence)';

async function lrclibGet({ artist, track, album, durationSec }) {
  const params = new URLSearchParams({
    artist_name: artist,
    track_name: track,
    album_name: album || '',
    duration: String(durationSec || 0),
  });
  const res = await fetch('https://lrclib.net/api/get?' + params.toString(), {
    headers: { 'User-Agent': USER_AGENT },
  });
  if (res.status === 404) return null;
  if (!res.ok) throw new Error('lrclib get failed: ' + res.status);
  return res.json();
}

async function lrclibSearch({ artist, track }) {
  const params = new URLSearchParams({ artist_name: artist, track_name: track });
  const res = await fetch('https://lrclib.net/api/search?' + params.toString(), {
    headers: { 'User-Agent': USER_AGENT },
  });
  if (!res.ok) throw new Error('lrclib search failed: ' + res.status);
  const list = await res.json();
  return Array.isArray(list) && list.length ? list[0] : null;
}

/**
 * Parses LRC text into a sorted array of { timeMs, text } lines.
 * Handles multiple timestamps on one line, e.g. "[00:12.00][01:30.00]text".
 */
function parseLrc(lrc) {
  if (!lrc) return [];
  const out = [];
  const tag = /\[(\d{1,2}):(\d{2})(?:[.:](\d{1,3}))?\]/g;
  for (const rawLine of lrc.split(/\r?\n/)) {
    tag.lastIndex = 0;
    const text = rawLine.replace(/\[[^\]]*\]/g, '').trim();
    let m;
    const stamps = [];
    while ((m = tag.exec(rawLine)) !== null) {
      const min = parseInt(m[1], 10);
      const sec = parseInt(m[2], 10);
      const fracRaw = m[3] || '0';
      const frac = parseInt(fracRaw.padEnd(3, '0').slice(0, 3), 10);
      stamps.push(min * 60000 + sec * 1000 + frac);
    }
    for (const timeMs of stamps) out.push({ timeMs, text });
  }
  out.sort((a, b) => a.timeMs - b.timeMs);
  return out;
}

/**
 * Loads lyrics for a track. Returns:
 *   { synced: [{timeMs,text}], plain: string|null, instrumental: bool }
 * `synced` is empty when only plain (or no) lyrics exist.
 */
async function loadLyrics({ artist, track, album, durationMs }) {
  const durationSec = Math.round((durationMs || 0) / 1000);
  let data = null;
  try {
    data = await lrclibGet({ artist, track, album, durationSec });
  } catch (_) {
    // Fall through to search.
  }
  if (!data) {
    try {
      data = await lrclibSearch({ artist, track });
    } catch (_) {
      data = null;
    }
  }
  if (!data) return { synced: [], plain: null, instrumental: false };

  return {
    synced: parseLrc(data.syncedLyrics),
    plain: data.plainLyrics || null,
    instrumental: Boolean(data.instrumental),
  };
}

/**
 * Given sorted synced lines and a playback position, returns the text of the
 * line currently "active" (the last line whose timestamp has passed), or ''.
 */
function lineAt(synced, progressMs) {
  if (!synced || !synced.length) return '';
  let lo = 0;
  let hi = synced.length - 1;
  let idx = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (synced[mid].timeMs <= progressMs) {
      idx = mid;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  return idx >= 0 ? synced[idx].text : '';
}

module.exports = { loadLyrics, parseLrc, lineAt };
