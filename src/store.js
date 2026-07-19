'use strict';

const Store = require('electron-store');

/**
 * Persistent config. Stored under the app's userData dir (config.json).
 * Nothing here is a Spotify *password* — only a client ID (public) and an
 * OAuth refresh token, which the user can revoke any time from their
 * Spotify account page.
 */
const store = new Store({
  name: 'config',
  defaults: {
    spotifyClientId: '',
    discordClientId: '',
    spotifyRefreshToken: '',
    // How the activity is rendered. {line} = current lyric, {track}, {artist}.
    detailsTemplate: '{line}',
    stateTemplate: '{artist} – {track}',
    // Rich Presence large image. Either a URL to a public image (Discord proxies
    // it) or an asset key you uploaded under your Discord app's Rich Presence
    // art. Defaults to the pfp committed at assets/pfp.png in this repo.
    largeImageKey:
      'https://raw.githubusercontent.com/dustfillerr-code/lyric-presence/main/assets/pfp.png',
    largeImageText: '{line}',
    // Fall back to showing track/artist when no synced lyrics exist.
    showTrackWhenNoLyrics: true,
    idleClearsActivity: true,
  },
});

module.exports = store;
