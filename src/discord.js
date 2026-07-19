'use strict';

const { Client } = require('@xhayper/discord-rpc');

/**
 * Thin wrapper over Discord's local IPC (Rich Presence). This is the officially
 * supported presence channel — the desktop Discord client must be running on
 * the same machine. It sets the "Listening/Playing" activity card only; it does
 * NOT touch your custom status text and does not automate your user account.
 *
 * Discord rate-limits activity updates to ~1 every 4s per the RPC contract, so
 * the caller should only push when the displayed text actually changes and
 * throttle accordingly.
 */
class DiscordPresence {
  constructor() {
    this.client = null;
    this.clientId = null;
    this.ready = false;
  }

  async connect(clientId) {
    if (this.ready && this.clientId === clientId) return;
    await this.disconnect();
    this.clientId = clientId;
    this.client = new Client({ clientId });
    await this.client.login();
    this.ready = true;
  }

  async setActivity({
    details,
    state,
    startTimestamp,
    endTimestamp,
    largeImageKey,
    largeImageText,
    smallImageKey,
    smallImageText,
  }) {
    if (!this.ready || !this.client || !this.client.user) return;
    const activity = { type: 2 /* Listening */, instance: false };
    if (details) activity.details = clamp(details);
    if (state) activity.state = clamp(state);
    if (startTimestamp) activity.startTimestamp = Math.floor(startTimestamp / 1000);
    if (endTimestamp) activity.endTimestamp = Math.floor(endTimestamp / 1000);
    // largeImageKey may be a full https URL (Discord proxies it) or an uploaded
    // Rich Presence asset key.
    if (largeImageKey) activity.largeImageKey = largeImageKey;
    if (largeImageText) activity.largeImageText = clamp(largeImageText);
    if (smallImageKey) activity.smallImageKey = smallImageKey;
    if (smallImageText) activity.smallImageText = clamp(smallImageText);
    await this.client.user.setActivity(activity);
  }

  async clear() {
    if (this.ready && this.client && this.client.user) {
      try { await this.client.user.clearActivity(); } catch (_) {}
    }
  }

  async disconnect() {
    this.ready = false;
    if (this.client) {
      try { await this.client.destroy(); } catch (_) {}
      this.client = null;
    }
  }
}

// Discord requires details/state to be 2..128 chars; trim and pad-guard.
function clamp(s) {
  let t = String(s).trim();
  if (t.length > 128) t = t.slice(0, 127) + '…';
  if (t.length === 1) t = t + ' ';
  return t;
}

module.exports = { DiscordPresence };
