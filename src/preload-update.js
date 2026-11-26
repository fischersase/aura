// Preload of the Aura update popup window (AURA-18).
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('api', {
  getUpdateInfo: () => ipcRenderer.invoke('update:getInfo'),
  installUpdate: () => ipcRenderer.invoke('update:install'),
  remindLater: () => ipcRenderer.send('update:later'),
  skipVersion: (version) => ipcRenderer.send('update:skip', version),
  openRelease: () => ipcRenderer.send('update:openRelease'),
  onProgress: (fn) => {
    const h = (_e, data) => fn(data);
    ipcRenderer.on('update:progress', h);
    return () => ipcRenderer.removeListener('update:progress', h);
  }
});
