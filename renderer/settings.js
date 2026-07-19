'use strict';

const $ = (id) => document.getElementById(id);

function applyConfig(cfg) {
  $('spotifyClientId').value = cfg.spotifyClientId || '';
  $('discordClientId').value = cfg.discordClientId || '';
  $('detailsTemplate').value = cfg.detailsTemplate || '{line}';
  $('stateTemplate').value = cfg.stateTemplate || '{artist} – {track}';
  $('largeImageKey').value = cfg.largeImageKey || '';
  $('largeImageText').value = cfg.largeImageText || '';
  $('showTrackWhenNoLyrics').checked = Boolean(cfg.showTrackWhenNoLyrics);
  $('idleClearsActivity').checked = Boolean(cfg.idleClearsActivity);

  const pill = $('spotifyState');
  if (cfg.spotifyConnected) {
    pill.textContent = 'connected ✓';
    pill.classList.add('ok');
  } else {
    pill.textContent = 'not connected';
    pill.classList.remove('ok');
  }
  $('toggleRun').textContent = cfg.running ? 'Stop' : 'Start';
}

function readForm() {
  return {
    spotifyClientId: $('spotifyClientId').value,
    discordClientId: $('discordClientId').value,
    detailsTemplate: $('detailsTemplate').value,
    stateTemplate: $('stateTemplate').value,
    largeImageKey: $('largeImageKey').value,
    largeImageText: $('largeImageText').value,
    showTrackWhenNoLyrics: $('showTrackWhenNoLyrics').checked,
    idleClearsActivity: $('idleClearsActivity').checked,
  };
}

async function init() {
  applyConfig(await window.api.getConfig());

  $('save').addEventListener('click', async () => {
    applyConfig(await window.api.saveConfig(readForm()));
    flashStatus('Saved.');
  });

  $('connectSpotify').addEventListener('click', async () => {
    await window.api.saveConfig(readForm()); // Persist Client ID first.
    window.api.connectSpotify();
  });

  $('toggleRun').addEventListener('click', async () => {
    await window.api.saveConfig(readForm());
    const running = await window.api.toggleRun();
    $('toggleRun').textContent = running ? 'Stop' : 'Start';
  });

  document.querySelectorAll('a[data-ext]').forEach((a) => {
    a.addEventListener('click', (e) => {
      e.preventDefault();
      window.api.openExternal(a.getAttribute('data-ext'));
    });
  });

  window.api.onStatus((text) => { $('status').textContent = text; });
  window.api.onConfigChanged((cfg) => applyConfig(cfg));
}

let flashTimer = null;
function flashStatus(text) {
  $('status').textContent = text;
  clearTimeout(flashTimer);
  flashTimer = setTimeout(() => { $('status').textContent = ''; }, 2000);
}

init();
