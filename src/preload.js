'use strict';

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('api', {
  getConfig: () => ipcRenderer.invoke('get-config'),
  saveConfig: (cfg) => ipcRenderer.invoke('save-config', cfg),
  connectSpotify: () => ipcRenderer.invoke('connect-spotify'),
  toggleRun: () => ipcRenderer.invoke('toggle-run'),
  openExternal: (url) => ipcRenderer.invoke('open-external', url),
  onStatus: (cb) => ipcRenderer.on('status', (_e, text) => cb(text)),
  onConfigChanged: (cb) => ipcRenderer.on('config-changed', (_e, cfg) => cb(cfg)),
});
