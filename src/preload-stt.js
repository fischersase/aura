// Preload of the hidden speech recognition window (local Whisper, AURA-18).
// Sandboxed preloads cannot require local modules, so the small helper is repeated in each preload.
const { contextBridge, ipcRenderer } = require('electron');

const on = (channel) => (fn) => {
  const h = (_e, data) => fn(data);
  ipcRenderer.on(channel, h);
  return () => ipcRenderer.removeListener(channel, h);
};

contextBridge.exposeInMainWorld('api', {
  sttReady: () => ipcRenderer.send('stt:ready'),
  sttResult: (r) => ipcRenderer.send('stt:result', r),
  sttProgress: (p) => ipcRenderer.send('stt:progress', p),
  onSttRequest: on('stt:request'),
  onSttPreload: on('stt:preload')
});
