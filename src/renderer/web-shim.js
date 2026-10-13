// Im Browser gibt es kein Electron-preload: window.api.z wird hier über fetch an den lokalen Aura-Server nachgebaut.
(() => {
  if (window.api && window.api.z) return;
  document.documentElement.classList.add('web');
  const KEY = 'aura-zentrale-token';
  const m = /[#&]t=([A-Za-z0-9_-]+)/.exec(location.hash);
  if (m) {
    try {
      sessionStorage.setItem(KEY, m[1]);
    } catch {}
    window.__auraToken = m[1];
    history.replaceState(null, '', location.pathname); // Token aus Adresszeile und Verlauf entfernen
  }
  const token = () => {
    try {
      return sessionStorage.getItem(KEY) || window.__auraToken || '';
    } catch {
      return window.__auraToken || '';
    }
  };

  async function call(name, arg) {
    const res = await fetch('/api/' + name, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token() },
      body: JSON.stringify({ arg }),
      cache: 'no-store',
      credentials: 'omit'
    });
    let j = {};
    try {
      j = await res.json();
    } catch {}
    if (res.status === 401) {
      document.dispatchEvent(new CustomEvent('aura-unauthorized'));
      throw Object.assign(new Error(j.error || 'Kein Zugang'), { unauthorized: true });
    }
    if (!res.ok) throw new Error(j.error || `Fehler ${res.status}`);
    return j.result;
  }

  // Abgelaufener Zugang wird als Hinweis angezeigt, nicht als Fehler in der Konsole.
  window.addEventListener('unhandledrejection', (e) => {
    if (e.reason && e.reason.unauthorized) e.preventDefault();
  });

  const z = {};
  const one = [
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
  ];
  for (const n of one) z[n] = (arg) => call(n, arg);
  z.setPolicy = (tool, policy) => call('setPolicy', { tool, policy });
  z.toggleServer = (name, enabled) => call('toggleServer', { name, enabled });
  z.toggleSkill = (name, enabled) => call('toggleSkill', { name, enabled });
  window.api = { z, web: true };
})();
