// Preload of the overlay window (glow and pointer, AURA-18): receives events, can only report idle.
// Sandboxed preloads cannot require local modules, so the small helper is repeated in each preload.
const { contextBridge, ipcRenderer } = require('electron');

const on = (channel) => (fn) => {
  const h = (_e, data) => fn(data);
  ipcRenderer.on(channel, h);
  return () => ipcRenderer.removeListener(channel, h);
};

contextBridge.exposeInMainWorld('api', {
  onGlowMode: on('glow:mode'),
  onGlowLevel: on('glow:level'),
  onPointerShow: on('pointer:show'),
  onPointerClear: on('pointer:clear'),
  overlayIdle: () => ipcRenderer.send('overlay:idle')
});
