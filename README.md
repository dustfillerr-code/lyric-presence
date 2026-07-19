# Lyric Presence

A small system-tray desktop app that shows the **current line of the song you're
playing on Spotify** as a **Discord Rich Presence** activity — the officially
supported "Listening to…" card.

> **Why Rich Presence and not custom status?** Setting your Discord *custom status
> text* from an app requires automating your user account (self-botting), which
> violates Discord's Terms of Service and can get your account banned. Rich
> Presence uses Discord's official local RPC and is ToS-compliant. It looks
> almost identical and carries no ban risk.

## How it works

1. **Spotify (official Web API, OAuth PKCE)** → detects the current track and
   playback position. No password is ever entered into the app; you authorize in
   your browser and Spotify returns a revocable token.
2. **[LRCLIB](https://lrclib.net)** (free, open, no-auth lyrics database) →
   provides time-synced lyrics. Only the single active line is shown at runtime;
   no lyrics are stored on disk or bundled with the app.
3. **Discord local RPC** → the current line is pushed to your presence card.

Lyric-line changes are throttled to ~1 update / 4s to respect Discord's RPC
rate limit, with local playback interpolation between Spotify polls so the line
stays roughly in sync.

## Setup

### Prerequisites
- Node.js 18+ and the **Discord desktop app** running (RPC needs the local client).
- **Spotify Premium or Free** with something actually playing.

### 1. Install
```bash
npm install
npm start
```

### 2. Create a Spotify app
- Go to the [Spotify Developer Dashboard](https://developer.spotify.com/dashboard).
- Create an app. Under **Redirect URIs** add exactly: `http://127.0.0.1:8888/callback`
- Copy the **Client ID** into the app's Settings (no client secret needed — PKCE).
- Click **Connect Spotify…** and approve in the browser.

### 3. Create a Discord app
- Go to the [Discord Developer Portal](https://discord.com/developers/applications).
- **New Application**. The application **name** is what shows after "Listening to".
- Copy the **Application ID** into the app's Settings.

### 4. Start
Hit **Start**. Play something on Spotify and check your Discord profile.

## Display templates
- Line 1 (details): defaults to `{line}` — the current lyric.
- Line 2 (state): defaults to `{artist} – {track}`.
- Placeholders: `{line}`, `{track}`, `{artist}`.

## Limitations
- Songs without synced lyrics on LRCLIB fall back to showing the track name.
- Discord's RPC rate limit means very fast lyric lines may be skipped.
- Requires the Discord **desktop** client (web/mobile can't do local RPC).

## Legal / ToS
- Uses only official Spotify and Discord APIs plus the open LRCLIB database.
- Does **not** scrape Spotify's internal lyrics endpoint and does **not**
  automate your Discord or Spotify account.
- Lyrics are copyrighted; this app displays a single line for personal presence
  only and never redistributes or stores them.

## License
MIT
