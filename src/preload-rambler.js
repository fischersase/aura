// Preload of the Rambler dictation bar (AURA-18).
// Sandboxed preloads cannot require local modules, so the small helper is repeated in each preload.
const { contextBridge, ipcRenderer } = require('electron');

const on = (channel) => (fn) => {
  const h = (_e, data) => fn(data);
  ipcRenderer.on(channel, h);
  return () => ipcRenderer.removeListener(channel, h);
};

contextBridge.exposeInMainWorld('api', {
  onRamblerStart: on('rambler:start'),
  onRamblerStop: on('rambler:stop'),
  onRamblerState: on('rambler:state'),
  onSttProgress: on('stt:progress'),
  ramblerAudio: (wavBase64) => ipcRenderer.send('rambler:audio', { wavBase64 }),
  ramblerCancel: () => ipcRenderer.send('rambler:cancel'),
  ramblerUndo: () => ipcRenderer.send('rambler:undo'),
  ramblerFull: () => ipcRenderer.send('rambler:full'),
  ramblerError: (m) => ipcRenderer.send('rambler:error', m)
});
