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

  // Einrichtung und Kosten
  setupDone: () => ipcRenderer.send('setup:done'),
  getUsage: () => ipcRenderer.invoke('usage:get'),
  onUsage: on('usage:update'),
  liveUsage: (secs) => ipcRenderer.send('live:usage', secs),

  // Panel
  onPanelOpen: on('panel:open'),
  onPanelClose: on('panel:close'),
  hidePanel: () => ipcRenderer.send('panel:hide'),
  ignoreMouse: (v) => ipcRenderer.send('panel:ignoreMouse', v),
  setBusy: (v) => ipcRenderer.send('panel:busy', v),

  // Chat-Verlauf
  listChats: () => ipcRenderer.invoke('chats:list'),
  getChat: (id) => ipcRenderer.invoke('chats:get', id),
  saveChat: (chat) => ipcRenderer.invoke('chats:save', chat),
  deleteChat: (id) => ipcRenderer.invoke('chats:delete', id),

  // Chat
  sendChat: (payload) => ipcRenderer.send('chat:send', payload),
  abortChat: (id) => ipcRenderer.send('chat:abort', id),
  onChatChunk: on('chat:chunk'),
  onChatDone: on('chat:done'),
  onChatError: on('chat:error'),
  onChatScreen: on('chat:screen'),

  // Aura Zentrale: gleiche Funktionen wie renderer/web-shim.js im Browser
  z: (() => {
    const z = {};
    for (const n of ['state', 'log', 'chats', 'deleteChat', 'setAgent', 'setAgentVersion', 'policy', 'savePolicy', 'memory', 'saveMemory', 'audit', 'doctor', 'getServer', 'saveServer', 'removeServer', 'protectServer', 'searchRegistry', 'installRegistry',
      'getSkill', 'saveSkill', 'deleteSkill', 'saveAgentsMd', 'secrets', 'setSecret', 'setSecretNote', 'deleteSecret', 'profile', 'saveProfile', 'openPath', 'openUrl', 'openWeb', 'webInfo', 'resetWeb']) {
      z[n] = (arg) => ipcRenderer.invoke('z:' + n, arg);
    }
    z.setPolicy = (tool, policy) => ipcRenderer.invoke('z:setPolicy', { tool, policy });
    z.toggleServer = (name, enabled) => ipcRenderer.invoke('z:toggleServer', { name, enabled });
    z.toggleSkill = (name, enabled) => ipcRenderer.invoke('z:toggleSkill', { name, enabled });
    return z;
  })(),
  openZentrale: () => ipcRenderer.send('zentrale:open'),

  // Agent
  onAgentStep: on('agent:step'),
  onAgentApprove: on('agent:approve'),
  onAgentStopped: on('agent:stopped'),
  agentApproval: (stepId, ok) => ipcRenderer.send('agent:approval', { stepId, ok }),
  onAgentAsk: on('agent:ask'),
  agentAnswer: (id, answer) => ipcRenderer.send('agent:answer', { id, answer }),
  onAgentPlan: on('agent:plan'),
  onAgentVerified: on('agent:verified'),
  agentVoiceTask: (request) => ipcRenderer.invoke('agent:voiceTask', { request }),
  stopAgent: () => ipcRenderer.send('agent:stop'),
  openAgentLog: () => ipcRenderer.send('agent:openLog'),
  agentExtensions: (force) => ipcRenderer.invoke('agent:extensions', force),
  openAgentFile: (which) => ipcRenderer.send('agent:openFile', which),

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

  // Lokal (Ollama + Whisper)
  ollamaStatus: (url) => ipcRenderer.invoke('ollama:status', url),
  ollamaPull: (url, name) => ipcRenderer.invoke('ollama:pull', { url, name }),
  abortPull: () => ipcRenderer.send('ollama:abortPull'),
  onOllamaProgress: on('ollama:progress'),
  liveTurn: (payload) => ipcRenderer.invoke('live:turn', payload),
  abortLiveTurn: () => ipcRenderer.send('live:abortTurn'),
  onLiveHeard: on('live:heard'),
  onSttProgress: on('stt:progress'),

  // Spracherkennungs-Fenster
  sttReady: () => ipcRenderer.send('stt:ready'),
  sttResult: (r) => ipcRenderer.send('stt:result', r),
  sttProgress: (p) => ipcRenderer.send('stt:progress', p),
  onSttRequest: on('stt:request'),
  onSttPreload: on('stt:preload'),

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
