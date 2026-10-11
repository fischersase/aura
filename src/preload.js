const { contextBridge, ipcRenderer } = require('electron');

const on = (channel) => (fn) => {
  const h = (_e, data) => fn(data);
  ipcRenderer.on(channel, h);
  return () => ipcRenderer.removeListener(channel, h);
};

contextBridge.exposeInMainWorld('api', {
  // Einstellungen
  getSettings: () => ipcRenderer.invoke('settings:get'),
  saveSettings: (patch) => ipcRenderer.invoke('settings:save', patch),
  testKey: (key) => ipcRenderer.invoke('settings:testKey', key),
  openSettings: () => ipcRenderer.send('settings:open'),
  openExternal: (url) => ipcRenderer.send('open:external', url),

  // Panel
  onPanelOpen: on('panel:open'),
  onPanelClose: on('panel:close'),
  hidePanel: () => ipcRenderer.send('panel:hide'),
  ignoreMouse: (v) => ipcRenderer.send('panel:ignoreMouse', v),

  // Chat
  sendChat: (payload) => ipcRenderer.send('chat:send', payload),
  abortChat: (id) => ipcRenderer.send('chat:abort', id),
  onChatChunk: on('chat:chunk'),
  onChatDone: on('chat:done'),
  onChatError: on('chat:error'),
  onChatScreen: on('chat:screen'),

  // Live
  liveConfig: () => ipcRenderer.invoke('live:config'),
  setLiveActive: (v) => ipcRenderer.send('live:active', v),
  onLiveStart: on('live:start'),
  onLiveStop: on('live:stop'),
  glowLevel: (v) => ipcRenderer.send('glow:level', v),
  showPointer: (p) => ipcRenderer.send('pointer:show', p),
  clearPointer: () => ipcRenderer.send('pointer:clear'),

  // Overlay
  onGlowMode: on('glow:mode'),
  onGlowLevel: on('glow:level'),
  onPointerShow: on('pointer:show'),
  onPointerClear: on('pointer:clear'),
  overlayIdle: () => ipcRenderer.send('overlay:idle'),

  // Rambler
  onRamblerStart: on('rambler:start'),
  onRamblerStop: on('rambler:stop'),
  onRamblerState: on('rambler:state'),
  ramblerAudio: (wavBase64) => ipcRenderer.send('rambler:audio', { wavBase64 }),
  ramblerCancel: () => ipcRenderer.send('rambler:cancel'),
  ramblerUndo: () => ipcRenderer.send('rambler:undo'),
  ramblerFull: () => ipcRenderer.send('rambler:full'),
  ramblerError: (m) => ipcRenderer.send('rambler:error', m)
});
