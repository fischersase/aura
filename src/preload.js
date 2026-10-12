// Preload of the panel, setup and settings windows (AURA-18). Overlay, Rambler, speech recognition and the Zentrale
// have their own preloads; main checks every channel's sender anyway (src/security.js IPC_ACCESS).
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
  transcribe: (wavBase64) => ipcRenderer.invoke('chat:transcribe', { wavBase64 }),
  abortChat: (id) => ipcRenderer.send('chat:abort', id),
  onChatChunk: on('chat:chunk'),
  onChatDone: on('chat:done'),
  onChatError: on('chat:error'),
  onChatScreen: on('chat:screen'),

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

  // Lokal (Ollama + Whisper)
  ollamaStatus: (url) => ipcRenderer.invoke('ollama:status', url),
  ollamaPull: (url, name) => ipcRenderer.invoke('ollama:pull', { url, name }),
  abortPull: () => ipcRenderer.send('ollama:abortPull'),
  onOllamaProgress: on('ollama:progress'),
  liveTurn: (payload) => ipcRenderer.invoke('live:turn', payload),
  abortLiveTurn: () => ipcRenderer.send('live:abortTurn'),
  onLiveHeard: on('live:heard'),
  onSttProgress: on('stt:progress')
});
