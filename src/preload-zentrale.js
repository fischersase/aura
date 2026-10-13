// Preload of the Aura Zentrale window (AURA-18): only the z:* functions.
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('api', {
  // Same functions as renderer/web-shim.js in the browser
  z: (() => {
    const z = {};
    for (const n of [
      'state',
      'log',
      'chats',
      'deleteChat',
      'setAgent',
      'setAgentVersion',
      'policy',
      'savePolicy',
      'memory',
      'saveMemory',
      'audit',
      'doctor',
      'installExtension',
      'getServer',
      'saveServer',
      'removeServer',
      'protectServer',
      'searchRegistry',
      'installRegistry',
      'getSkill',
      'saveSkill',
      'deleteSkill',
      'saveAgentsMd',
      'secrets',
      'setSecret',
      'setSecretNote',
      'deleteSecret',
      'profile',
      'saveProfile',
      'openPath',
      'openUrl',
      'openWeb',
      'webInfo',
      'resetWeb'
    ]) {
      z[n] = (arg) => ipcRenderer.invoke('z:' + n, arg);
    }
    z.setPolicy = (tool, policy) => ipcRenderer.invoke('z:setPolicy', { tool, policy });
    z.toggleServer = (name, enabled) => ipcRenderer.invoke('z:toggleServer', { name, enabled });
    z.toggleSkill = (name, enabled) => ipcRenderer.invoke('z:toggleSkill', { name, enabled });
    return z;
  })()
});
