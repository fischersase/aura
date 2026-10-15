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
      'getChat',
      'saveChat',
      'askChat',
      'deleteChat',
      'setAgent',
      'setAgentVersion',
      'policy',
      'savePolicy',
      'memory',
      'memoryUpdate',
      'memoryDelete',
      'memoryDeleteAll',
      'memoryPause',
      'audit',
      'doctor',
      'installExtension',
      'getServer',
      'saveServer',
      'removeServer',
      'protectServer',
      'connectServer',
      'disconnectServer',
      'searchRegistry',
      'installRegistry',
      'connectors',
      'driftInfo',
      'tasks',
      'removeTask',
      'stopTask',
      'runTask',
      'addTask',
      'approveTools',
      'installConnector',
      'getSkill',
      'saveSkill',
      'deleteSkill',
      'saveAgentsMd',
      'secrets',
      'setSecret',
      'setSecretNote',
      'setLogin',
      'deleteSecret',
      'setWeakStorage',
      'profile',
      'saveProfile',
      'getSettings',
      'saveSettings',
      'testKey',
      'ollamaStatus',
      'ollamaPull',
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
    z.toggleTask = (id, enabled) => ipcRenderer.invoke('z:toggleTask', { id, enabled });
    return z;
  })(),
  onNavigate: (/** @type {(nav: any) => void} */ fn) => ipcRenderer.on('z:navigate', (_e, nav) => fn(nav))
});
