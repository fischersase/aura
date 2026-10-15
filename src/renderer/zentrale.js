// Aura Zentrale: Oberfläche im minimalistischen Google-Gemini-Stil.
const $ = (id) => document.getElementById(id);
const z = window.api.z;
let S = null; // letzter Zustand
let connectorEntries = [];

const esc = (s) =>
  String(s ?? '').replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]
  );
const POLICIES = [
  ['default', 'Standard'],
  ['ask', 'Immer fragen'],
  ['auto', 'Nie fragen'],
  ['off', 'Aus']
];
const policySelect = (tool, value) =>
  `<select data-policy="${esc(tool)}">${POLICIES.map(([v, l]) => `<option value="${v}"${v === value ? ' selected' : ''}>${l}</option>`).join('')}</select>`;

const ICON_PLUS = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 5v14M5 12h14"/></svg>';
const ICON_DOTS =
  '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="5" cy="12" r="1.6" fill="currentColor"/><circle cx="12" cy="12" r="1.6" fill="currentColor"/><circle cx="19" cy="12" r="1.6" fill="currentColor"/></svg>';

const CONNECTOR_ICONS = {
  'google-workspace':
    '<svg viewBox="0 0 24 24" aria-hidden="true"><path fill="#4285F4" d="M21.35 11.1h-9.17v2.73h6.51c-.33 1.81-1.5 3.34-3.2 4.37v3.62h5.18c3.03-2.79 4.78-6.9 4.78-11.72 0-.8-.08-1.57-.23-2.3z"/><path fill="#34A853" d="M12.18 22c4.32 0 7.95-1.43 10.6-3.88l-5.18-3.62c-1.43.96-3.26 1.53-5.42 1.53-4.17 0-7.7-2.81-8.96-6.6H-2.1v3.73C.54 18.4 5.94 22 12.18 22z" transform="translate(2 0) scale(.88)"/><circle cx="12" cy="12" r="8.5" fill="none" stroke="#4285F4" stroke-width="2"/><path d="M8 12h8M12 8v8" stroke="#34A853" stroke-width="1.8" stroke-linecap="round"/></svg>',
  github:
    '<svg viewBox="0 0 24 24" aria-hidden="true"><path fill="#e3e3e3" d="M12 2C6.48 2 2 6.58 2 12.23c0 4.52 2.87 8.35 6.84 9.7.5.1.68-.22.68-.49 0-.24-.01-.88-.01-1.72-2.78.62-3.37-1.37-3.37-1.37-.45-1.18-1.11-1.5-1.11-1.5-.91-.64.07-.63.07-.63 1 .07 1.53 1.05 1.53 1.05.9 1.57 2.35 1.12 2.92.85.09-.67.35-1.12.63-1.38-2.22-.26-4.56-1.14-4.56-5.07 0-1.12.39-2.03 1.03-2.75-.1-.26-.45-1.3.1-2.71 0 0 .84-.28 2.75 1.05a9.3 9.3 0 0 1 5 0c1.91-1.33 2.75-1.05 2.75-1.05.55 1.41.2 2.45.1 2.71.64.72 1.03 1.63 1.03 2.75 0 3.94-2.34 4.81-4.57 5.06.36.32.68.94.68 1.9 0 1.37-.01 2.48-.01 2.82 0 .27.18.6.69.49A10.25 10.25 0 0 0 22 12.23C22 6.58 17.52 2 12 2z"/></svg>',
  atlassian:
    '<svg viewBox="0 0 24 24" aria-hidden="true"><path fill="#2684FF" d="M7.12 11.43a.68.68 0 0 0-1.15.08L2.09 19.3a.7.7 0 0 0 .63 1.01h6.77a.68.68 0 0 0 .63-.42c1.45-3.32.57-6.83-3-8.46zm4.3-7.77a13.4 13.4 0 0 0-.82 13.22l2.63 5.02c.12.24.37.4.64.4h6.77a.7.7 0 0 0 .63-1.01L12.62 3.64a.66.66 0 0 0-1.2.02z"/></svg>',
  mail: '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="3" y="5" width="18" height="14" rx="2.5" fill="none" stroke="#f28b82" stroke-width="1.8"/><path d="m4 7 8 6 8-6" fill="none" stroke="#f28b82" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>'
};

function connectorIcon(id) {
  const key = String(id || '').toLowerCase();
  if (CONNECTOR_ICONS[key]) return CONNECTOR_ICONS[key];
  if (key.includes('github')) return CONNECTOR_ICONS.github;
  if (key.includes('atlassian') || key.includes('jira')) return CONNECTOR_ICONS.atlassian;
  if (key.includes('google') || key.includes('workspace')) return CONNECTOR_ICONS['google-workspace'];
  if (key.includes('mail')) return CONNECTOR_ICONS.mail;
  return '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="3" y="4" width="18" height="16" rx="3" fill="none" stroke="#a8c7fa" stroke-width="1.8"/><path d="m8 10 3 2-3 2M13 14h3" fill="none" stroke="#a8c7fa" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>';
}

// Empfohlene Starter-Skills im Stil von Google Gemini („Erste Schritte“).
const STARTER_SKILLS = [
  {
    name: 'schreibstil-anpassen',
    title: 'Schreibstil anpassen',
    description: 'Texte auf den eigenen Kommunikationsstil abstimmen',
    icon: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 6h10M18 6h2M4 12h4M12 12h8M4 18h12" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/><circle cx="16" cy="6" r="2" fill="none" stroke="currentColor" stroke-width="1.8"/><circle cx="10" cy="12" r="2" fill="none" stroke="currentColor" stroke-width="1.8"/></svg>',
    content: `---
name: schreibstil-anpassen
description: Passt Entwürfe, E-Mails und Texte an meinen persönlichen Schreib- und Kommunikationsstil an
---

# Schreibstil anpassen

Wenn du Texte, E-Mails oder Nachrichten für mich formulierst oder überarbeitest:

1. Schreibe klar, präzise und natürlich – ohne Floskeln oder künstliche Einleitungen.
2. Behalte meine Kernaussage bei und passe den Tonfall an den Adressaten an (kollegial-direkt oder sachlich-höflich).
3. Schlage bei längeren Entwürfen eine kurze und eine ausführlichere Variante vor.
`
  },
  {
    name: 'energie-fokussieren',
    title: 'Energie fokussieren',
    description: 'Aufgaben priorisieren, Zeit einteilen und den Überblick behalten',
    icon: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="m12 3 1.9 5.1L19 10l-5.1 1.9L12 17l-1.9-5.1L5 10l5.1-1.9L12 3z" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"/></svg>',
    content: `---
name: energie-fokussieren
description: Hilft beim Priorisieren von Aufgaben, Tagesplanung und Fokus-Blöcken
---

# Energie fokussieren

Wenn ich viele Aufgaben habe oder meinen Tag strukturieren möchte:

1. Ordne Aufgaben nach Wirkung und Dringlichkeit (maximal 3 Hauptprioritäten für heute).
2. Zerlege große Vorhaben in den nächsten konkreten 15-Minuten-Schritt.
3. Halte den Plan übersichtlich und realistisch.
`
  },
  {
    name: 'neue-ideen-generieren',
    title: 'Neue Ideen generieren',
    description: 'Kreative Ansätze finden und den eigenen Horizont erweitern',
    icon: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M9 18h6M10 21h4M12 3a6 6 0 0 0-4 10.5c.7.6 1 1.5 1 2.5h6c0-1 .3-1.9 1-2.5A6 6 0 0 0 12 3z" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>',
    content: `---
name: neue-ideen-generieren
description: Entwickelt strukturierte, kreative Ideen und Lösungsansätze beim Brainstorming
---

# Neue Ideen generieren

Beim Brainstorming oder wenn ich nach neuen Ideen frage:

1. Liefere unterschiedliche Richtungen (pragmatisch, ungewöhnlich, schnell umsetzbar).
2. Begründe kurz pro Idee, warum sie funktioniert und was der erste Schritt wäre.
3. Stelle am Ende eine gezielte Rückfrage, um die beste Richtung zu vertiefen.
`
  },
  {
    name: 'weitere-perspektiven',
    title: 'Weitere Perspektiven',
    description: 'Entwürfe und Pläne aus verschiedenen Blickwinkeln prüfen',
    icon: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"/></svg>',
    content: `---
name: weitere-perspektiven
description: Prüft Pläne, Entscheidungen oder Texte kritisch aus mehreren Blickwinkeln
---

# Weitere Perspektiven

Wenn ich einen Plan, eine Entscheidung oder ein Konzept vorstelle:

1. Beleuchte das Vorhaben aus mindestens drei relevanten Perspektiven (z. B. Nutzer, Technik/Umsetzung, Risiken).
2. Benenne blinde Flecken oder Annahmen konstruktiv und konkret.
3. Schlage vor, wie sich die wichtigsten Risiken einfach absichern lassen.
`
  },
  {
    name: 'besprechungen-vorbereiten',
    title: 'Vorbereitung auf Besprechungen',
    description: 'Wichtige Punkte, Fragen und Agenden vorab zusammenstellen',
    icon: '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="3" y="4" width="18" height="17" rx="2" fill="none" stroke="currentColor" stroke-width="1.8"/><path d="M8 2v4M16 2v4M3 10h18" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/></svg>',
    content: `---
name: besprechungen-vorbereiten
description: Bereitet Termine und Besprechungen mit Agenda, Kontext und offenen Fragen vor
---

# Vorbereitung auf Besprechungen

Wenn ich mich auf ein Meeting oder Gespräch vorbereite:

1. Fasse das Ziel des Gesprächs in einem Satz zusammen.
2. Erstelle eine knappe Agenda mit den 3–5 wichtigsten Gesprächspunkten und klaren Fragen.
3. Falls Kalender, Mails oder Tickets verbunden sind, berücksichtige den aktuellen Stand.
`
  },
  {
    name: 'rechnungen-sortieren',
    title: 'Rechnungen sortieren',
    description: 'Rechnungen aus ~/Downloads prüfen und nach Monat ablegen',
    icon: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" fill="none" stroke="currentColor" stroke-width="1.8"/><path d="M14 2v6h6M8 13h8M8 17h5" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/></svg>',
    content: `---
name: rechnungen-sortieren
description: Sortiert PDF-Rechnungen und Belege aus ~/Downloads übersichtlich nach Jahr und Monat
---

# Rechnungen sortieren

1. Suche im Ordner ~/Downloads nach PDF-Rechnungen oder Belegen.
2. Lies Rechnungsdatum und Aussteller aus dem Dokument.
3. Schlage eine saubere Benennung (YYYY-MM-DD_Aussteller.pdf) und den Zielordner vor, bevor Dateien verschoben werden.
`
  }
];

function skillIcon(name) {
  const starter = STARTER_SKILLS.find((s) => s.name === name);
  if (starter) return starter.icon;
  return '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="m12 3 1.9 5.1L19 10l-5.1 1.9L12 17l-1.9-5.1L5 10l5.1-1.9L12 3z" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"/></svg>';
}

// ---------- Theme (Darkmode / Brightmode) ----------

const ICON_SUN =
  '<circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.93 4.93l1.41 1.41M17.66 17.66l1.41 1.41M2 12h2M20 12h2M4.93 19.07l1.41-1.41M17.66 6.34l1.41-1.41"/>';
const ICON_MOON = '<path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z"/>';

function currentTheme() {
  try {
    return localStorage.getItem('aura-theme') === 'light' ? 'light' : 'dark';
  } catch {
    return 'dark';
  }
}

function applyTheme(theme, persist = false) {
  const t = theme === 'light' ? 'light' : 'dark';
  document.documentElement.dataset.theme = t;
  try {
    localStorage.setItem('aura-theme', t);
  } catch {}
  if (persist && z && typeof z.saveSettings === 'function') {
    z.saveSettings({ theme: t }).catch(() => {});
  }
  if ($('themeIconSun')) {
    $('themeIconSun').innerHTML = t === 'light' ? ICON_MOON : ICON_SUN;
  }
  if ($('themeToggle')) {
    $('themeToggle').title = t === 'light' ? 'Zu Dunkelmodus wechseln' : 'Zu Hellmodus (Brightmode) wechseln';
  }
  if ($('cfgThemeSelect')) {
    $('cfgThemeSelect').value = t;
  }
}
applyTheme(currentTheme(), false);

if ($('themeToggle')) {
  $('themeToggle').onclick = () => applyTheme(currentTheme() === 'light' ? 'dark' : 'light', true);
}

// ---------- Eingebauter Gemini-Chat in der Zentrale ----------

const newZChatId = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
let activeChatId = newZChatId();
let activeChatHistory = [];
let zChatBusy = false;

function zMarkdown(src) {
  const out = [];
  const blocks = String(src || '').split(/```/);
  blocks.forEach((block, i) => {
    if (i % 2 === 1) {
      out.push('<pre><code>' + esc(block.replace(/^[^\n]*\n/, '')) + '</code></pre>');
      return;
    }
    const paragraphs = block
      .trim()
      .split(/\n{2,}/)
      .filter(Boolean);
    for (const p of paragraphs) {
      const formatted = esc(p)
        .replace(/`([^`]+)`/g, '<code>$1</code>')
        .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
        .replace(/\n/g, '<br>');
      out.push(`<p>${formatted}</p>`);
    }
  });
  return out.join('') || `<p>${esc(src)}</p>`;
}

function renderZChatMessages() {
  const emptyEl = $('zChatEmpty');
  const listEl = $('zChatMessages');
  const clearBtn = $('zChatClearBtn');
  const delBtn = $('zChatDeleteBtn');
  if (!emptyEl || !listEl) return;
  const hasMessages = activeChatHistory.length > 0;
  emptyEl.classList.toggle('hidden', hasMessages);
  listEl.classList.toggle('hidden', !hasMessages);
  if (clearBtn) clearBtn.classList.toggle('hidden', !hasMessages);
  if (delBtn) delBtn.classList.toggle('hidden', !hasMessages);
  if (!hasMessages) {
    listEl.innerHTML = '';
    return;
  }
  listEl.innerHTML = activeChatHistory
    .map((m) => {
      const text = (m.parts || [])
        .map((p) => p.text)
        .filter(Boolean)
        .join('\n');
      if (m.role === 'user') {
        return `<div class="zchat-msg user">${esc(text)}</div>`;
      }
      return `<div class="zchat-msg model">${zMarkdown(text)}</div>`;
    })
    .join('');
  listEl.scrollTop = listEl.scrollHeight;
}

function resetZentraleChat() {
  activeChatId = newZChatId();
  activeChatHistory = [];
  renderZChatMessages();
  renderSidebarChats();
  if ($('zChatInput')) $('zChatInput').focus();
}

async function openChatInZentrale(id) {
  show('chat');
  if (!id) {
    resetZentraleChat();
    return;
  }
  try {
    const c = await z.getChat(id);
    if (c && Array.isArray(c.history)) {
      activeChatId = c.id;
      activeChatHistory = c.history;
      renderZChatMessages();
      renderSidebarChats();
    } else {
      resetZentraleChat();
    }
  } catch {
    resetZentraleChat();
  }
}

async function sendZentraleChat(textOverride) {
  if (zChatBusy) return;
  const inputEl = $('zChatInput');
  const text = (textOverride !== undefined ? textOverride : inputEl ? inputEl.value : '').trim();
  if (!text) return;
  if (inputEl && textOverride === undefined) inputEl.value = '';
  activeChatHistory.push({ role: 'user', parts: [{ text }] });
  renderZChatMessages();
  zChatBusy = true;
  if ($('zChatSendBtn')) {
    $('zChatSendBtn').disabled = true;
    $('zChatSendBtn').textContent = 'Antwortet …';
  }
  try {
    const res = await z.askChat({ chatId: activeChatId, history: activeChatHistory });
    if (res && res.error) {
      activeChatHistory.push({ role: 'model', parts: [{ text: `Fehler: ${res.error}` }] });
    } else if (res && Array.isArray(res.history)) {
      activeChatHistory = res.history;
    } else if (res && res.text) {
      activeChatHistory.push({ role: 'model', parts: [{ text: res.text }] });
    }
    renderZChatMessages();
    renderSidebarChats();
  } finally {
    zChatBusy = false;
    if ($('zChatSendBtn')) {
      $('zChatSendBtn').disabled = false;
      $('zChatSendBtn').textContent = 'Senden';
    }
  }
}

if ($('navNewChat')) {
  $('navNewChat').onclick = () => {
    show('chat');
    resetZentraleChat();
  };
}
if ($('zChatClearBtn')) {
  $('zChatClearBtn').onclick = () => resetZentraleChat();
}
if ($('zChatDeleteBtn')) {
  $('zChatDeleteBtn').onclick = async () => {
    const idToDelete = activeChatId;
    resetZentraleChat();
    await z.deleteChat(idToDelete).catch(() => {});
    renderSidebarChats();
  };
}
if ($('zChatForm')) {
  $('zChatForm').onsubmit = (e) => {
    e.preventDefault();
    sendZentraleChat();
  };
}
if ($('zChatInput')) {
  $('zChatInput').addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      sendZentraleChat();
    }
  });
}
document.querySelectorAll('[data-prompt]').forEach((b) => {
  b.onclick = () => sendZentraleChat(b.dataset.prompt);
});

// ---------- Navigation ----------

const CUSTOMIZE_PAGES = new Set(['discover', 'catalog', 'skills']);
const MORE_PAGES = new Set([
  'servers',
  'tools',
  'instructions',
  'memory',
  'rules',
  'secrets',
  'log',
  'doctor',
  'profile'
]);

function show(page) {
  const target = page || 'chat';
  const isCustomize = CUSTOMIZE_PAGES.has(target);
  document.querySelectorAll('nav button[data-page]').forEach((b) => {
    if (b.id === 'navCustomize') b.classList.toggle('on', isCustomize);
    else b.classList.toggle('on', b.dataset.page === target);
  });
  if (MORE_PAGES.has(target) && $('moreMenu').classList.contains('hidden')) {
    $('moreMenu').classList.remove('hidden');
    $('moreToggle').setAttribute('aria-expanded', 'true');
  }
  const tabs = $('customizeTabs');
  if (tabs) {
    tabs.style.visibility = isCustomize ? 'visible' : 'hidden';
    tabs.querySelectorAll('.gem-tab').forEach((t) => t.classList.toggle('on', t.dataset.tab === target));
  }
  document.querySelectorAll('.page').forEach((p) => p.classList.toggle('hidden', p.id !== target));
  if (target === 'log') {
    renderLog();
    renderAudit();
  }
  if (target === 'rules') loadRules();
  if (target === 'memory') loadMemory();
  if (target === 'doctor') renderDoctor();
  if (target === 'chats') renderChats();
  if (target === 'secrets') renderSecrets();
  if (target === 'profile') loadProfile();
  if (target === 'settings') loadSettingsPage();
  if (target === 'catalog' || target === 'discover') renderConnectors();
  if (target === 'skills' || target === 'discover') renderSkills();
  if (target === 'tasks') renderTasks();
}

document.querySelectorAll('nav button[data-page]').forEach((b) => {
  b.onclick = () => show(b.dataset.page);
});
document.querySelectorAll('.gem-tab[data-tab]').forEach((b) => {
  b.onclick = () => show(b.dataset.tab);
});
document.querySelectorAll('[data-go-tab]').forEach((b) => {
  b.onclick = () => show(b.dataset.goTab);
});
if ($('moreToggle')) {
  $('moreToggle').onclick = () => {
    const open = $('moreMenu').classList.toggle('hidden');
    $('moreToggle').setAttribute('aria-expanded', String(!open));
  };
}
if ($('logoHome')) $('logoHome').onclick = () => show('chat');
if ($('topModelBadge')) $('topModelBadge').onclick = () => show('settings');
if ($('toolsToRulesLink')) {
  $('toolsToRulesLink').onclick = (e) => {
    e.preventDefault();
    show('rules');
  };
}
if ($('navSearchBtn')) {
  $('navSearchBtn').onclick = () => {
    show('catalog');
    setTimeout(() => $('q')?.focus(), 30);
  };
}
if ($('profileAvatarBtn')) $('profileAvatarBtn').onclick = () => show('profile');
if ($('navProfileLoc')) $('navProfileLoc').onclick = () => show('profile');
if ($('discoverNewSkill')) $('discoverNewSkill').onclick = () => skillDialog(null);
if ($('addCustomConnector')) $('addCustomConnector').onclick = () => serverDialog(null);

document.addEventListener('click', (e) => {
  const o = e.target.closest('[data-open]');
  if (o) {
    e.preventDefault();
    z.openPath(o.dataset.open);
  }
  const u = e.target.closest('a[data-url]');
  if (u) {
    e.preventDefault();
    z.openUrl(u.dataset.url);
  }
});
document.addEventListener('change', async (e) => {
  const sel = e.target.closest('select[data-policy]');
  if (sel) {
    await z.setPolicy(sel.dataset.policy, sel.value);
    await load();
    if (!$('rules').classList.contains('hidden')) renderQuickRules();
  }
});

// ---------- Laden ----------

async function load(force) {
  S = await z.state(force);
  $('ver').textContent = `Version ${S.version}`;
  $('verBadge').textContent = `Version ${S.version}`;
  document.title = `Aura Zentrale ${S.version}`;
  $('auraDir').textContent = S.auraDir;
  $('agentOn').checked = S.agentEnabled;
  $('agentVersion').value = S.agentVersion;
  const modelLabel = `${S.provider === 'ollama' ? 'Ollama' : 'Gemini'} · ${S.model || ''}`;
  if ($('topModelBadge')) $('topModelBadge').textContent = modelLabel;
  if ($('zChatModelInfo')) {
    $('zChatModelInfo').textContent = `${modelLabel}${S.agentEnabled ? ` · Agent ${S.agentVersion}` : ' · Nur Chat'}`;
  }
  if ($('zChatGreetTitle')) {
    $('zChatGreetTitle').textContent = S.profileName
      ? `Hallo ${S.profileName}! Wie kann ich dir helfen?`
      : 'Hallo! Wie kann ich dir heute helfen?';
  }
  if ($('profileAvatarBtn')) {
    const initial = (S.profileName || 'Aura').trim().charAt(0).toUpperCase() || 'A';
    $('profileAvatarBtn').textContent = initial;
    $('profileAvatarBtn').title = S.profileName ? `Profil: ${S.profileName}` : 'Profil';
  }
  if ($('navLocText')) {
    $('navLocText').textContent = S.profileName ? `${S.profileName} · Aus deinem Profil` : 'Aus deinem Profil';
  }
  renderOverview();
  renderTools();
  renderServers();
  await renderConnectors();
  renderSkills();
  renderSidebarChats();
  if (document.activeElement !== $('agentsMd') && !mdDirty) $('agentsMd').value = S.agentsMd;
}

async function renderSidebarChats() {
  const box = $('sidebarChats');
  if (!box) return;
  try {
    const list = await z.chats();
    if (!list.length) {
      box.innerHTML = '<div class="sidebar-chat-empty">Noch keine gespeicherten Chats</div>';
      return;
    }
    box.innerHTML = list
      .slice(0, 15)
      .map(
        (c) =>
          `<div class="sidebar-chat-row${c.id === activeChatId && activeChatHistory.length ? ' on' : ''}">` +
          `<button type="button" class="sidebar-chat-item" data-side-chat="${esc(c.id)}" title="${esc(c.title)}">${esc(c.title)}</button>` +
          `<button type="button" class="sidebar-chat-del" data-side-del="${esc(c.id)}" title="Chat löschen" aria-label="Chat löschen"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 7h14M10 11v6M14 11v6M6 7l1 12h10l1-12M9 7V4h6v3"/></svg></button>` +
          `</div>`
      )
      .join('');
    box.querySelectorAll('[data-side-chat]').forEach((b) => {
      b.onclick = () => openChatInZentrale(b.dataset.sideChat);
    });
    box.querySelectorAll('[data-side-del]').forEach((b) => {
      b.onclick = async (e) => {
        e.stopPropagation();
        const delId = b.dataset.sideDel;
        await z.deleteChat(delId);
        if (delId === activeChatId) resetZentraleChat();
        else renderSidebarChats();
      };
    });
  } catch {
    box.innerHTML = '';
  }
}

function activeToolCount() {
  const on = (p) => p !== 'off';
  return (
    S.builtin.filter((t) => on(t.policy)).length +
    S.servers.filter((s) => !s.disabled).reduce((n, s) => n + s.tools.filter((t) => on(t.policy)).length, 0) +
    (S.skills.some((k) => k.enabled) ? 1 : 0)
  );
}

// HTML-Kommentare entfernen, wiederholt bis nichts mehr übrig ist (auch verschachtelte wie "<!-<!-- -->-->").
function stripComments(t) {
  let prev;
  do {
    prev = t;
    t = t.replace(/<!--[\s\S]*?-->/g, '');
  } while (t !== prev);
  return t;
}

function renderOverview() {
  const running = S.servers.filter((s) => s.running).length;
  const broken = S.servers.filter((s) => s.error && !s.disabled).length;
  const n = activeToolCount();
  const tiles = [
    ['tools', n, 'aktive Werkzeuge' + (S.provider === 'ollama' && n > 40 ? ' (viele für lokale Modelle)' : '')],
    ['servers', `${running}/${S.servers.length}`, 'MCP-Server verbunden' + (broken ? `, ${broken} mit Fehler` : '')],
    ['skills', `${S.skills.filter((k) => k.enabled).length}/${S.skills.length}`, 'Skills aktiv'],
    ['instructions', stripComments(S.agentsMd).replace(/^#.*$/gm, '').trim() ? 'ja' : '–', 'eigene Anweisungen'],
    ['secrets', S.secretCount, 'gespeicherte Schlüssel'],
    ['profile', S.profileName ? esc(S.profileName) : '–', 'Profil'],
    ['settings', S.provider === 'ollama' ? 'lokal' : 'Gemini', esc(S.model)]
  ];
  $('tiles').innerHTML = tiles
    .map(([p, b, s]) => `<div class="tile" data-go="${p}"><b>${esc(b)}</b><span>${s}</span></div>`)
    .join('');
  $('tiles')
    .querySelectorAll('[data-go]')
    .forEach((t) => {
      t.onclick = () => show(t.dataset.go);
    });
  $('webState').textContent = window.api.web
    ? 'Du bist gerade im Browser verbunden.'
    : S.web && S.web.running
      ? `Läuft unter ${S.web.url}`
      : 'Noch nicht gestartet; startet beim ersten Öffnen.';
}
$('openWeb').onclick = $('openWeb2').onclick = async () => {
  await z.openWeb();
  load();
};
$('resetWeb').onclick = async () => {
  if (!confirm('Alle offenen Browser-Tabs der Zentrale abmelden? Danach brauchst du einen neuen Link aus Aura.'))
    return;
  await z.resetWeb();
  load();
};
document.addEventListener('aura-unauthorized', () => $('noAccess').classList.remove('hidden'));
$('agentOn').onchange = async () => {
  await z.setAgent($('agentOn').checked);
  load();
};
$('agentVersion').onchange = async () => {
  await z.setAgentVersion($('agentVersion').value);
  load();
};

const V2_EXTRA_TOOLS = [
  ['launch_app / open_target', 'Programme, Ordner oder URLs gezielt starten', 'T1 (fragt bei Programmen)'],
  ['list_windows / window_action', 'Offene Fenster auflisten, fokussieren oder schließen', 'T0 / T1'],
  [
    'list_dir / edit_file / move_path / trash',
    'Gezielte Datei-Änderungen, Verschieben und Papierkorb',
    'T0 / T2 (fragt)'
  ],
  ['media_status / media_control / volume', 'Musik/Medien abspielen, pausieren und Systemlautstärke regeln', 'T0 / T1'],
  ['system_info / settings', 'Systemzustand lesen und Desktop-Einstellungen anpassen', 'T0 / T2'],
  ['browser_* (Playwright)', 'Webseiten öffnen, lesen, klicken und Formulare ausfüllen', 'Lesen frei, Klicks fragen'],
  ['schedule_task', 'Geplante Aufgaben und Cronjobs aus dem Chat heraus anlegen', 'T2 (fragt)'],
  ['todo_write / ask_user', 'Aufgabenplan erstellen und gezielte Rückfragen stellen', 'T0 (immer aktiv)']
];

function renderTools() {
  const label = {
    run_command: 'Terminal-Befehl ausführen (alle Shell-Befehle)',
    find_files: 'Dateien suchen',
    list_folder: 'Ordner anzeigen',
    read_file: 'Datei lesen',
    write_file: 'Datei schreiben',
    open: 'Öffnen',
    screenshot: 'Bildschirmfoto',
    click: 'Klicken',
    type_text: 'Tippen',
    press_keys: 'Tasten drücken'
  };
  $('toolList').innerHTML = S.builtin
    .map(
      (t) => `
    <div class="item"><div class="name">${esc(label[t.name] || t.name)} <span class="badge">${esc(t.name)}</span> <span class="badge">fragt standardmäßig: ${esc(t.asksByDefault)}</span></div>
    <div class="desc">${esc(t.description)}</div><div class="side">${policySelect(t.name, t.policy)}</div></div>`
    )
    .join('');
  if ($('v2ToolList')) {
    $('v2ToolList').innerHTML = V2_EXTRA_TOOLS.map(
      ([name, desc, tier]) => `
      <div class="item">
        <div class="name">${esc(name)} <span class="badge">${esc(tier)}</span></div>
        <div class="desc">${esc(desc)}</div>
        <div class="side"><button type="button" class="small" data-go-rules="1">In Regeln anpassen</button></div>
      </div>`
    ).join('');
    $('v2ToolList')
      .querySelectorAll('[data-go-rules]')
      .forEach((b) => {
        b.onclick = () => show('rules');
      });
  }
}

// ---------- MCP-Server (Standardmäßig eingeklappt, per Klick aufklappbar) ----------

const expandedServers = new Set();

async function driftDialog(name) {
  const d = await z.driftInfo(name);
  if (d.error) return alert(d.error);
  const tool = (t) => `<b>${esc(t.name)}</b>: ${esc(t.description || '(ohne Beschreibung)')}`;
  const list = (title, items) => (items.length ? `<h3>${title}</h3><ul class="drift">${items.join('')}</ul>` : '');
  dialog(
    `„${name}“: Werkzeuge geändert`,
    `<p class="small">Seit deiner Freigabe hat der Server seine Werkzeuge geändert. Prüfe, ob das zu dem passt, was der Dienst tun soll. Eine Beschreibung, die etwas anderes verlangt (z. B. Daten woandershin zu schicken), ist ein Warnzeichen.</p>
    ${list(
      'Neu',
      d.added.map((t) => `<li>${tool(t)}</li>`)
    )}
    ${list(
      'Entfernt',
      d.removed.map((n) => `<li><b>${esc(n)}</b></li>`)
    )}
    ${list(
      'Geändert',
      d.changed.map(
        (c) =>
          `<li><b>${esc(c.name)}</b><div class="before">vorher: ${esc(c.before.description)}</div><div class="after">jetzt: ${esc(c.after.description)}</div>${
            JSON.stringify(c.before.inputSchema) !== JSON.stringify(c.after.inputSchema)
              ? '<div class="small muted">Eingaben geändert</div>'
              : ''
          }</li>`
      )
    )}
    <div class="hint">Bis zur Freigabe nutzt Aura diesen Server nicht.</div>`,
    async () => {
      const r = await z.approveTools(name);
      if (r && r.error) return r.error;
      await load();
      return null;
    },
    'Freigeben'
  );
}

// Sandbox of local catalog/registry servers (AURA-97).
const SANDBOX_BADGE = {
  on: '<span class="badge ok" title="Läuft abgeschottet: sieht nur seinen eigenen Ordner, nicht deine Dateien">Sandbox</span>',
  missing:
    '<span class="badge bad" title="bubblewrap fehlt: sudo apt install bubblewrap, dann Aura neu starten">Sandbox fehlt</span>',
  unsupported:
    '<span class="badge" title="Auf diesem System gibt es noch keine Sandbox; der Server sieht deine Dateien">ohne Sandbox</span>',
  disabled: '<span class="badge bad" title="In mcp.json ausgeschaltet (sandbox: false)">ohne Sandbox</span>'
};

function renderServers() {
  if (!S.servers.length) {
    $('serverList').innerHTML =
      '<div class="empty">Noch keine MCP-Server. Füge einen über <a href="#" id="toCatalog">Connectors</a> hinzu oder trage ihn selbst ein.</div>';
    $('toCatalog').onclick = (e) => {
      e.preventDefault();
      show('catalog');
    };
    return;
  }
  $('serverList').innerHTML = S.servers
    .map((s) => {
      const isExpanded = expandedServers.has(s.name);
      const state = s.disabled
        ? '<span class="badge">aus</span>'
        : s.auth === 'oauth' && !s.signedIn
          ? ''
          : s.error
            ? '<span class="badge bad">Fehler</span>'
            : '<span class="badge ok">verbunden</span>';
      const tools =
        s.disabled || !s.tools.length || !isExpanded
          ? ''
          : `<div class="tools">${s.tools
              .map(
                (t) => `
      <div class="tool"><div class="name">${esc(t.title)}${t.readOnly ? ' <span class="badge">nur lesend</span>' : ''}</div>
      <div class="desc">${esc(t.description.replace(/^\[[^\]]*\]\s*/, ''))}</div>${policySelect(t.name, t.policy)}</div>`
              )
              .join('')}</div>`;
      const expandBtn =
        !s.disabled && s.tools.length
          ? `<button type="button" class="tools-toggle" data-expand-server="${esc(s.name)}" aria-expanded="${isExpanded}">${s.tools.length} Werkzeuge ${isExpanded ? '▴' : '▾'}</button>`
          : '';
      return `<div class="server">
      <div class="top"><label class="switch"><input type="checkbox" data-toggle="${esc(s.name)}"${s.disabled ? '' : ' checked'}><span></span></label>
        <span class="title" data-expand-server="${esc(s.name)}" title="Klicken zum Auf-/Zuklappen der Werkzeuge">${esc(s.name)}</span>${state}<span class="badge">${s.type === 'http' ? 'Remote' : 'lokal'}</span>
        ${s.auth === 'oauth' ? (s.signedIn ? '<span class="badge ok">angemeldet</span>' : '<span class="badge bad">Anmeldung nötig</span>') : ''}
        ${SANDBOX_BADGE[s.sandbox] || ''}
        ${expandBtn}
        <span class="grow"></span>${s.auth === 'oauth' ? (s.signedIn ? `<button type="button" class="small" data-signout="${esc(s.name)}">Abmelden</button>` : `<button type="button" class="small primary" data-signin="${esc(s.name)}">Anmelden</button>`) : ''}<button type="button" class="small" data-edit="${esc(s.name)}">Bearbeiten</button><button type="button" class="small danger" data-remove="${esc(s.name)}">Entfernen</button></div>
      <div class="cmd">${esc(s.command)}${s.env.length ? ' · Variablen: ' + esc(s.env.join(', ')) : ''}${s.secretRefs.length ? ' · Schlüssel: ' + esc(s.secretRefs.join(', ')) : ''}</div>
      ${s.plainSecrets.length ? `<div class="warnbox"><span>${esc(s.plainSecrets.join(', '))} steht im Klartext in mcp.json.</span><button type="button" class="small" data-protect="${esc(s.name)}">Verschlüsselt speichern</button></div>` : ''}
      ${s.error && !s.disabled ? `<div class="err">${esc(s.error)}${s.drift ? ` <button type="button" class="small primary" data-drift="${esc(s.name)}">Änderung prüfen</button>` : ''}</div>` : ''}${tools}</div>`;
    })
    .join('');
  $('serverList')
    .querySelectorAll('[data-expand-server]')
    .forEach((el) => {
      el.onclick = () => {
        const name = el.dataset.expandServer;
        if (expandedServers.has(name)) expandedServers.delete(name);
        else expandedServers.add(name);
        renderServers();
      };
    });
  $('serverList')
    .querySelectorAll('[data-drift]')
    .forEach((b) => {
      b.onclick = () => driftDialog(b.dataset.drift);
    });
  $('serverList')
    .querySelectorAll('[data-signin]')
    .forEach((b) => {
      b.onclick = async () => {
        b.disabled = true;
        b.textContent = 'Im Browser anmelden …';
        const r = await z.connectServer(b.dataset.signin);
        if (r && r.error) alert(r.error);
        load();
      };
    });
  $('serverList')
    .querySelectorAll('[data-signout]')
    .forEach((b) => {
      b.onclick = async () => {
        if (!confirm(`Bei „${b.dataset.signout}“ abmelden? Aura löscht die Anmeldung und widerruft sie beim Dienst.`))
          return;
        await z.disconnectServer(b.dataset.signout);
        load();
      };
    });
  $('serverList')
    .querySelectorAll('[data-toggle]')
    .forEach((c) => {
      c.onchange = async () => {
        c.disabled = true;
        S = await z.toggleServer(c.dataset.toggle, c.checked);
        load();
      };
    });
  $('serverList')
    .querySelectorAll('[data-remove]')
    .forEach((b) => {
      b.onclick = async () => {
        if (confirm(`Server „${b.dataset.remove}“ entfernen?`)) {
          await z.removeServer(b.dataset.remove);
          load();
        }
      };
    });
  $('serverList')
    .querySelectorAll('[data-edit]')
    .forEach((b) => {
      b.onclick = () => serverDialog(b.dataset.edit);
    });
  $('serverList')
    .querySelectorAll('[data-protect]')
    .forEach((b) => {
      b.onclick = async () => {
        b.disabled = true;
        const r = await z.protectServer(b.dataset.protect);
        if (r && r.error) alert(r.error);
        load();
      };
    });
}

$('reloadServers').onclick = async () => {
  $('reloadServers').textContent = 'Verbinde …';
  await load(true);
  $('reloadServers').textContent = 'Neu verbinden';
};
$('addServer').onclick = () => serverDialog(null);

// ---------- Dialog ----------

function dialog(title, html, onOk, okLabel = 'Speichern') {
  $('dlgTitle').textContent = title;
  $('dlgBody').innerHTML = html;
  $('dlgError').textContent = '';
  $('dlgOk').textContent = okLabel;
  $('dlg').classList.remove('hidden');
  const close = () => $('dlg').classList.add('hidden');
  $('dlgCancel').onclick = close;
  $('dlgOk').onclick = async () => {
    $('dlgOk').disabled = true;
    try {
      const err = await onOk();
      if (err) $('dlgError').textContent = err;
      else close();
    } catch (e) {
      $('dlgError').textContent = String(e.message || e);
    } finally {
      $('dlgOk').disabled = false;
    }
  };
}
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') $('dlg').classList.add('hidden');
});

function splitArgs(s) {
  const out = [];
  String(s || '').replace(/"([^"]*)"|'([^']*)'|(\S+)/g, (_m, a, b, c) => {
    out.push(a ?? b ?? c);
    return '';
  });
  return out;
}
const quoteArg = (a) => (/\s/.test(a) ? `"${a}"` : a);

async function serverDialog(name) {
  const cfg = name ? await z.getServer(name) : null;
  const isHttp = cfg ? !!cfg.url : false;
  const kv = (o) =>
    Object.entries(o || {})
      .map(([k, v]) => `${k}=${v}`)
      .join('\n');
  dialog(
    name ? `Server „${name}“ bearbeiten` : 'MCP-Server hinzufügen',
    `
    <label>Name</label><input type="text" id="fName" value="${esc(name || '')}" placeholder="z. B. playwright" spellcheck="false">
    <label>Art</label><div class="seg" id="fKind"><button type="button" data-k="stdio" class="${isHttp ? '' : 'on'}">Programm (lokal)</button><button type="button" data-k="http" class="${isHttp ? 'on' : ''}">Remote (URL)</button></div>
    <div id="fStdio" class="${isHttp ? 'hidden' : ''}">
      <label>Befehl mit Argumenten</label><input type="text" id="fCmd" value="${esc(cfg && cfg.command ? [cfg.command, ...(cfg.args || [])].map(quoteArg).join(' ') : '')}" placeholder="npx -y @playwright/mcp@latest --isolated" spellcheck="false">
      <label>Umgebungsvariablen (eine pro Zeile, NAME=wert)</label><textarea id="fEnv" rows="3" spellcheck="false">${esc(kv(cfg && cfg.env))}</textarea>
    </div>
    <div id="fHttp" class="${isHttp ? '' : 'hidden'}">
      <label>URL</label><input type="text" id="fUrl" value="${esc((cfg && cfg.url) || '')}" placeholder="https://example.com/mcp" spellcheck="false">
      <label class="check"><input type="checkbox" id="fOauth"${cfg && cfg.auth === 'oauth' ? ' checked' : ''}> Anmeldung über den Browser (OAuth)</label>
      <label>Client-ID (nur falls der Dienst eine eigene verlangt, z. B. Google)</label><input type="text" id="fClientId" value="${esc((cfg && cfg.clientId) || '')}" spellcheck="false">
      <label>Header (einer pro Zeile, Name=Wert, z. B. Authorization=Bearer …)</label><textarea id="fHeaders" rows="3" spellcheck="false">${esc(kv(cfg && cfg.headers))}</textarea>
    </div>
    <label>Ohne Nachfrage erlaubte Werkzeuge (optional, durch Komma getrennt; * = alle)</label>
    <input type="text" id="fAuto" value="${esc(((cfg && cfg.autoApprove) || []).join(', '))}" spellcheck="false">
    <div class="hint">Werte, die nach Schlüsseln aussehen (Namen mit KEY, TOKEN, SECRET, PASSWORD, Authorization), legt Aura beim Speichern verschlüsselt unter „Schlüssel“ ab; in mcp.json steht dann nur <code>\${secret:NAME}</code>. Gespeicherte Schlüssel trägst du selbst so ein.</div>`,
    async () => {
      const http = $('fKind').querySelector('.on').dataset.k === 'http';
      const parseKv = (t) =>
        Object.fromEntries(
          String(t || '')
            .split('\n')
            .map((l) => l.trim())
            .filter(Boolean)
            .map((l) => {
              const i = l.indexOf('=');
              return i > 0 ? [l.slice(0, i).trim(), l.slice(i + 1).trim()] : [l, ''];
            })
        );
      const config = {};
      if (http) {
        config.url = $('fUrl').value.trim();
        if (!/^https?:\/\//.test(config.url)) return 'Die URL muss mit https:// beginnen.';
        const h = parseKv($('fHeaders').value);
        if (Object.keys(h).length) config.headers = h;
        if ($('fOauth').checked) config.auth = 'oauth';
        if ($('fClientId').value.trim()) config.clientId = $('fClientId').value.trim();
        if (cfg && cfg.clientSecretRef) config.clientSecretRef = cfg.clientSecretRef;
      } else {
        const parts = splitArgs($('fCmd').value.trim());
        if (!parts.length) return 'Bitte einen Befehl eintragen.';
        config.command = parts[0];
        if (parts.length > 1) config.args = parts.slice(1);
        const env = parseKv($('fEnv').value);
        if (Object.keys(env).length) config.env = env;
      }
      const auto = $('fAuto')
        .value.split(',')
        .map((x) => x.trim())
        .filter(Boolean);
      if (auto.length) config.autoApprove = auto;
      if (cfg && cfg.disabled) config.disabled = true;
      const r = await z.saveServer({ name: $('fName').value.trim(), oldName: name, config });
      if (r && r.error) return r.error;
      load();
      return null;
    }
  );
  $('fKind')
    .querySelectorAll('button')
    .forEach((b) => {
      b.onclick = () => {
        $('fKind')
          .querySelectorAll('button')
          .forEach((x) => x.classList.toggle('on', x === b));
        $('fStdio').classList.toggle('hidden', b.dataset.k !== 'stdio');
        $('fHttp').classList.toggle('hidden', b.dataset.k !== 'http');
      };
    });
}

// ---------- Geplante Aufgaben (AURA-121) ----------

async function renderTasks() {
  const tasks = await z.tasks();
  if (!tasks.length) {
    $('taskList').innerHTML = '<div class="empty">Noch keine geplanten Aufgaben oder Cronjobs.</div>';
    return;
  }
  const when = (ms) => (ms ? new Date(ms).toLocaleString('de-DE', { dateStyle: 'medium', timeStyle: 'short' }) : '–');
  $('taskList').innerHTML = tasks
    .map(
      (t) => `<div class="server"><div class="top">
        <label class="switch"><input type="checkbox" data-task-toggle="${esc(t.id)}"${t.enabled ? ' checked' : ''}><span></span></label>
        <span class="title">${esc(t.title)}</span><span class="badge">${esc(t.when)}</span>
        ${t.watch ? '<span class="badge">Prüfauftrag</span>' : ''}
        ${t.running ? '<span class="badge ok">läuft</span>' : ''}
        ${t.waiting ? '<span class="badge bad" title="Freigabe im Aura-Fenster (Wartet auf dich)">wartet auf dich</span>' : ''}
        ${t.lastStatus === 'error' ? '<span class="badge bad">Fehler</span>' : ''}
        <span class="grow"></span>
        ${t.running ? `<button type="button" class="small" data-task-stop="${esc(t.id)}">Stoppen</button>` : `<button type="button" class="small" data-task-run="${esc(t.id)}">Jetzt starten</button>`}
        <button type="button" class="small danger" data-task-remove="${esc(t.id)}">Löschen</button></div>
        <div class="cmd">${esc(t.prompt)}</div>
        <div class="muted small" style="padding:0 18px 12px">Nächster Lauf: ${esc(when(t.nextRun))}${t.lastRun ? ` · Zuletzt: ${esc(when(t.lastRun))}` : ''}</div>
        ${t.lastText ? `<div class="desc" style="padding:0 18px 14px">${esc(t.lastText)}</div>` : ''}</div>`
    )
    .join('');
  $('taskList')
    .querySelectorAll('[data-task-toggle]')
    .forEach((c) => {
      c.onchange = async () => {
        await z.toggleTask(c.dataset.taskToggle, c.checked);
        renderTasks();
      };
    });
  $('taskList')
    .querySelectorAll('[data-task-run]')
    .forEach((b) => {
      b.onclick = async () => {
        b.disabled = true;
        b.textContent = 'Startet …';
        await z.runTask(b.dataset.taskRun);
        renderTasks();
      };
    });
  $('taskList')
    .querySelectorAll('[data-task-stop]')
    .forEach((b) => {
      b.onclick = async () => {
        await z.stopTask(b.dataset.taskStop);
        renderTasks();
      };
    });
  $('taskList')
    .querySelectorAll('[data-task-remove]')
    .forEach((b) => {
      b.onclick = async () => {
        if (!confirm('Diese geplante Aufgabe löschen?')) return;
        await z.removeTask(b.dataset.taskRemove);
        renderTasks();
      };
    });
}

if ($('addCronTask')) {
  $('addCronTask').onclick = () => {
    dialog(
      'Aufgabe / Cronjob erstellen',
      `<label>Titel</label>
      <input type="text" id="tTitle" placeholder="z. B. Server-Status prüfen oder Wochenbericht" maxlength="100">
      <label>Zeitplan-Art</label>
      <div class="seg" id="tKind">
        <button type="button" data-tk="daily" class="on">Täglich</button>
        <button type="button" data-tk="interval">Intervall</button>
        <button type="button" data-tk="cron">Cronjob (5 Felder)</button>
        <button type="button" data-tk="once">Einmalig</button>
      </div>
      <div id="tBoxDaily">
        <label>Uhrzeit (HH:MM)</label>
        <input type="text" id="tDailyTime" value="08:00" maxlength="5">
        <label class="check"><input type="checkbox" id="tDailyWeekdays"> Nur werktags (Mo–Fr)</label>
      </div>
      <div id="tBoxInterval" class="hidden">
        <label>Alle wie viele Minuten? (5 bis 1440)</label>
        <input type="number" id="tIntervalMin" value="60" min="5" max="1440">
      </div>
      <div id="tBoxCron" class="hidden">
        <label>Cron-Ausdruck (Minute Stunde Tag Monat Wochentag)</label>
        <input type="text" id="tCronExpr" value="0 8 * * 1-5" placeholder="z. B. */15 * * * * oder 0 9 * * 1" spellcheck="false">
        <div class="hint">Beispiele: <code>0 8 * * 1-5</code> (Mo–Fr 08:00), <code>*/30 * * * *</code> (alle 30 Min.), <code>0 18 * * 5</code> (Freitag 18:00).</div>
      </div>
      <div id="tBoxOnce" class="hidden">
        <label>Zeitpunkt</label>
        <input type="datetime-local" id="tOnceAt">
      </div>
      <label>Auftrag an Aura (Prompt)</label>
      <textarea id="tPrompt" rows="4" placeholder="Was soll Aura ausführen? (Alle aktivierten Werkzeuge, Skills und Connectors stehen bereit)"></textarea>
      <label class="check"><input type="checkbox" id="tWatch"> Prüfauftrag: Nur benachrichtigen, wenn es wirklich Neuigkeiten gibt (sonst still)</label>`,
      async () => {
        const title = $('tTitle').value.trim();
        const prompt = $('tPrompt').value.trim();
        if (!prompt) return 'Bitte einen Auftrag (Prompt) eingeben.';
        const kind = $('tKind').querySelector('.on').dataset.tk;
        let trigger;
        if (kind === 'daily') {
          trigger = {
            kind: 'daily',
            time: $('tDailyTime').value.trim(),
            ...($('tDailyWeekdays').checked ? { days: [1, 2, 3, 4, 5] } : {})
          };
        } else if (kind === 'interval') {
          trigger = { kind: 'interval', minutes: Number($('tIntervalMin').value) || 60 };
        } else if (kind === 'cron') {
          trigger = { kind: 'cron', expr: $('tCronExpr').value.trim() };
        } else {
          const val = $('tOnceAt').value;
          if (!val) return 'Bitte Datum und Uhrzeit wählen.';
          trigger = { kind: 'once', at: new Date(val).toISOString() };
        }
        const r = await z.addTask({
          title: title || prompt.slice(0, 60),
          prompt,
          trigger,
          watch: $('tWatch').checked
        });
        if (r && r.error) return r.error;
        renderTasks();
        return null;
      },
      'Erstellen'
    );
    $('tKind')
      .querySelectorAll('button')
      .forEach((b) => {
        b.onclick = () => {
          $('tKind')
            .querySelectorAll('button')
            .forEach((x) => x.classList.toggle('on', x === b));
          const k = b.dataset.tk;
          $('tBoxDaily').classList.toggle('hidden', k !== 'daily');
          $('tBoxInterval').classList.toggle('hidden', k !== 'interval');
          $('tBoxCron').classList.toggle('hidden', k !== 'cron');
          $('tBoxOnce').classList.toggle('hidden', k !== 'once');
        };
      });
  };
}

// Daily briefing (AURA-123): a ready-made recurring task; it uses whatever is connected and allowed.
const BRIEFING_PROMPT =
  'Tagesbriefing für mich, kurz und in Stichpunkten: das Wetter heute an meinem Ort (weather); meine Termine heute, ' +
  'falls ein Kalender verbunden ist; neue wichtige Mails und offene Tickets, falls verbunden. Was nicht verbunden ist, ' +
  'lässt du weg, ohne es aufzuzählen.';
$('addBriefing').onclick = () =>
  dialog(
    'Tagesbriefing einrichten',
    `<p class="small muted">Aura fasst dir morgens zusammen, was für den Tag wichtig ist: Wetter, Termine, Mails und Tickets (soweit verbunden). Das Ergebnis kommt als Benachrichtigung und steht als Chat „Hintergrund: Tagesbriefing“ bereit.</p>
    <label>Uhrzeit</label><input type="text" id="bTime" value="07:30" maxlength="5">
    <label class="check"><input type="checkbox" id="bWeekdays" checked> nur werktags (Mo–Fr)</label>`,
    async () => {
      const r = await z.addTask({
        title: 'Tagesbriefing',
        prompt: BRIEFING_PROMPT,
        trigger: {
          kind: 'daily',
          time: $('bTime').value.trim(),
          ...($('bWeekdays').checked ? { days: [1, 2, 3, 4, 5] } : {})
        }
      });
      if (r.error) return r.error;
      renderTasks();
      return null;
    },
    'Einrichten'
  );

// ---------- Connectors (Google-Gemini-Stil, 2-Spalten-Grid) ----------

function buildConnectorItems(filterQuery = '') {
  const q = filterQuery.trim().toLowerCase();
  const usedServers = new Set();
  const items = [];

  for (const c of connectorEntries) {
    const server = c.server && S ? S.servers.find((s) => s.name === c.server) : null;
    if (server) usedServers.add(server.name);
    const connected = !!server && !server.disabled && (!server.auth || server.signedIn) && !server.error;
    const needsAttention = !!server && (server.error || (server.auth === 'oauth' && !server.signedIn));
    let badge = '';
    if (server) {
      if (server.disabled) badge = '<span class="badge">pausiert</span>';
      else if (server.auth === 'oauth' && !server.signedIn) badge = '<span class="badge bad">Anmeldung nötig</span>';
      else if (server.error) badge = '<span class="badge bad">Fehler</span>';
      else badge = '<span class="badge ok">Verbunden</span>';
    } else if (c.status === 'advanced') {
      badge = '<span class="badge">Anleitung</span>';
    } else if (c.status === 'coming') {
      badge = '<span class="badge">Kommt bald</span>';
    }
    items.push({
      kind: 'catalog',
      id: c.id,
      title: c.title,
      description: c.description,
      icon: connectorIcon(c.id),
      connected,
      needsAttention,
      hasServer: !!server,
      serverName: server ? server.name : null,
      badge
    });
  }

  // Eigene MCP-Server ebenfalls direkt unter Connectors anzeigen
  if (S && S.servers) {
    for (const s of S.servers) {
      if (usedServers.has(s.name)) continue;
      const connected = !s.disabled && (!s.auth || s.signedIn) && !s.error;
      const needsAttention = !s.disabled && (!!s.error || (s.auth === 'oauth' && !s.signedIn));
      const badge = s.disabled
        ? '<span class="badge">pausiert</span>'
        : needsAttention
          ? '<span class="badge bad">Prüfen</span>'
          : '<span class="badge ok">Verbunden</span>';
      items.push({
        kind: 'server',
        id: s.name,
        title: s.name,
        description: s.tools.length ? `${s.tools.length} Werkzeuge · ${s.command}` : s.command,
        icon: connectorIcon(s.name),
        connected,
        needsAttention,
        hasServer: true,
        serverName: s.name,
        badge
      });
    }
  }

  if (!q) return items;
  return items.filter(
    (it) =>
      it.title.toLowerCase().includes(q) ||
      String(it.description || '')
        .toLowerCase()
        .includes(q)
  );
}

function renderConnectorGrid(container, items) {
  if (!container) return;
  if (!items.length) {
    container.innerHTML = '<div class="empty" style="grid-column:1/-1">Keine passenden Connectors gefunden.</div>';
    return;
  }
  container.innerHTML = items
    .map((it) => {
      const dot = it.connected
        ? '<span class="gem-dot" title="Verbunden"></span>'
        : it.needsAttention
          ? '<span class="gem-dot bad" title="Prüfung nötig"></span>'
          : '';
      const actIcon = it.hasServer ? ICON_DOTS : ICON_PLUS;
      const actTitle = it.hasServer ? `${it.title} verwalten` : `${it.title} verbinden`;
      return `<div class="gem-item" data-c-kind="${esc(it.kind)}" data-c-id="${esc(it.id)}" data-c-server="${esc(it.serverName || '')}">
        <div class="gem-icon">${it.icon}${dot}</div>
        <div class="gem-body">
          <div class="gem-title">${esc(it.title)}${it.badge}</div>
          <div class="gem-desc" title="${esc(it.description)}">${esc(it.description)}</div>
        </div>
        <button type="button" class="gem-act" title="${esc(actTitle)}" aria-label="${esc(actTitle)}">${actIcon}</button>
      </div>`;
    })
    .join('');

  container.querySelectorAll('.gem-item').forEach((row) => {
    row.onclick = () => {
      const kind = row.dataset.cKind;
      const id = row.dataset.cId;
      const serverName = row.dataset.cServer;
      if (kind === 'server') {
        connectorManageDialog(null, serverName);
        return;
      }
      const entry = connectorEntries.find((c) => c.id === id);
      if (!entry) return;
      if (serverName) {
        connectorManageDialog(entry, serverName);
      } else if (entry.status === 'advanced' && entry.homepage) {
        dialog(
          entry.title,
          `<p class="small muted">${esc(entry.description)}</p>
          <p class="small">Für ${esc(entry.title)} ist ein eigenes Google-Cloud-OAuth-Projekt nötig. Du kannst den Server über die Anleitung einrichten oder einen eigenen MCP-Server eintragen.</p>
          <p><a href="#" data-url="${esc(entry.homepage)}" class="button-link">Anleitung öffnen ↗</a></p>`,
          async () => {
            serverDialog(entry.title);
            return null;
          },
          'Als MCP-Server eintragen'
        );
      } else {
        connectDialog(entry.id);
      }
    };
  });
}

async function renderConnectors() {
  connectorEntries = await z.connectors();
  const query = $('q') ? $('q').value : '';
  const allItems = buildConnectorItems(query);
  renderConnectorGrid($('connectorList'), allItems);
  renderConnectorGrid($('discoverConnectors'), buildConnectorItems('').slice(0, 6));
}

function connectorManageDialog(entry, serverName) {
  const s = S && S.servers ? S.servers.find((x) => x.name === serverName) : null;
  if (!s) {
    if (entry) connectDialog(entry.id);
    return;
  }
  const title = entry ? entry.title : s.name;
  const desc = entry ? entry.description : s.command;
  const statusBadge = s.disabled
    ? '<span class="badge">Pausiert</span>'
    : s.error
      ? '<span class="badge bad">Fehler</span>'
      : '<span class="badge ok">Verbunden</span>';

  dialog(
    `${title} ${s.disabled ? '(pausiert)' : ''}`,
    `<p class="small muted">${esc(desc)} ${statusBadge}</p>
    ${s.error && !s.disabled ? `<div class="warnbox" style="margin:0 0 12px"><span>${esc(s.error)}</span></div>` : ''}
    <div style="display:flex;align-items:center;justify-content:space-between;padding:10px 0;border-bottom:1px solid var(--line)">
      <span>Connector aktiv</span>
      <label class="switch"><input type="checkbox" id="mConnToggle"${s.disabled ? '' : ' checked'}><span></span></label>
    </div>
    ${
      s.tools.length
        ? `<p class="small muted" style="margin:12px 0 6px">${s.tools.length} freigegebene Werkzeuge: ${esc(
            s.tools
              .slice(0, 10)
              .map((t) => t.title)
              .join(', ')
          )}${s.tools.length > 10 ? ' …' : ''}</p>`
        : ''
    }
    <div class="row" style="margin-top:16px;flex-wrap:wrap">
      ${entry && (entry.status === 'available' || entry.status === 'ready') && entry.credentials && entry.credentials.length ? `<button type="button" id="mConnReconf" class="small">Zugangsdaten ändern</button>` : ''}
      ${s.auth === 'oauth' ? `<button type="button" id="mConnOauth" class="small">${s.signedIn ? 'Abmelden' : 'Im Browser anmelden'}</button>` : ''}
      <button type="button" id="mConnEdit" class="small">Technisch bearbeiten</button>
      <button type="button" id="mConnServers" class="small">Werkzeug-Regeln</button>
      <span class="grow"></span>
      <button type="button" id="mConnRemove" class="small danger">Trennen</button>
    </div>`,
    async () => {
      const wantEnabled = $('mConnToggle').checked;
      if (wantEnabled === !!s.disabled) {
        await z.toggleServer(s.name, wantEnabled);
        await load();
      }
      return null;
    },
    'Fertig'
  );

  if ($('mConnReconf')) {
    $('mConnReconf').onclick = () => connectDialog(entry.id);
  }
  if ($('mConnOauth')) {
    $('mConnOauth').onclick = async () => {
      if (s.signedIn) await z.disconnectServer(s.name);
      else await z.connectServer(s.name);
      $('dlg').classList.add('hidden');
      await load();
    };
  }
  if ($('mConnEdit')) {
    $('mConnEdit').onclick = () => serverDialog(s.name);
  }
  if ($('mConnServers')) {
    $('mConnServers').onclick = () => {
      $('dlg').classList.add('hidden');
      show('servers');
    };
  }
  if ($('mConnRemove')) {
    $('mConnRemove').onclick = async () => {
      if (!confirm(`Verbindung zu „${title}“ trennen?`)) return;
      await z.removeServer(s.name);
      $('dlg').classList.add('hidden');
      await load();
    };
  }
}

// Guided setup: steps, a link to where the token is made, one field per value. OAuth entries sign in right away.
function connectDialog(id) {
  const c = connectorEntries.find((x) => x.id === id);
  if (!c) return;
  const steps = (list) => `<ol class="steps">${list.map((s) => `<li>${esc(s)}</li>`).join('')}</ol>`;
  const creds = c.credentials
    .map(
      (k) => `
    <fieldset class="cred"><legend>${esc(k.label)}</legend>
      ${k.tokenUrl ? `<p><a href="#" data-url="${esc(k.tokenUrl)}" class="button-link">${k.kind === 'api-token' ? 'Token erstellen' : 'Öffnen'} ↗</a></p>` : ''}
      ${steps(k.help)}
      <input type="${k.secret ? 'password' : k.kind === 'email' ? 'email' : 'text'}" data-cred="${esc(k.name)}" placeholder="${esc(k.label)}${k.required === false ? ' (optional)' : ' hier einfügen'}" spellcheck="false" autocomplete="off">
    </fieldset>`
    )
    .join('');
  dialog(
    `${c.title} verbinden`,
    `<p class="small muted">${esc(c.description)}</p>
    ${c.setup.length ? steps(c.setup) : ''}
    ${creds}
    <div class="hint">${c.credentials.some((k) => k.secret) ? 'Zugangsschlüssel speichert Aura verschlüsselt unter „Schlüssel &amp; Konten“; der Agent sieht sie nie. ' : ''}Lesen geht ohne Rückfrage; Senden, Ändern und Löschen fragt Aura immer vorher.</div>`,
    async () => {
      const values = {};
      for (const el of document.querySelectorAll('[data-cred]')) values[el.dataset.cred] = el.value;
      const r = await z.installConnector({ id: c.id, values });
      if (r.error) return r.error;
      if (r.oauth) {
        $('dlgOk').textContent = 'Im Browser anmelden …';
        const s = await z.connectServer(r.name);
        if (s && s.error) return `Gespeichert, aber die Anmeldung hat nicht geklappt: ${s.error}`;
      }
      await load(true);
      renderConnectors();
      // Test call (AURA-97): the first listing of the tools; its result is shown right away.
      const s = S.servers.find((x) => x.name === r.name);
      setTimeout(
        () =>
          dialog(
            s && !s.error ? `${c.title} ist verbunden` : `${c.title}: Verbindung nicht geklappt`,
            s && !s.error
              ? `<p>Test erfolgreich: ${s.tools.length} Werkzeuge.</p><p class="small muted">${esc(s.tools.map((t) => t.title).join(', '))}</p><div class="hint">Diese Werkzeuge hast du damit freigegeben. Ändert der Server sie später, fragt Aura dich erneut.</div>`
              : `<p class="bad">${esc((s && s.error) || 'Server nicht gefunden.')}</p>`,
            async () => null,
            'OK'
          ),
        0
      );
      return null;
    },
    c.oauth ? 'Anmelden' : 'Verbinden'
  );
  const first = document.querySelector('[data-cred]');
  if (first) first.focus();
}

// From the corner panel or tray: open a specific page or hand over the active chat directly.
window.api.onNavigate?.(async (nav) => {
  if (!S) await load();
  if (nav && nav.chatId) {
    await openChatInZentrale(nav.chatId);
    return;
  }
  show((nav && nav.page) || 'chat');
  if (!nav || !nav.connect) return;
  await renderConnectors();
  if (connectorEntries.some((c) => c.id === nav.connect)) connectDialog(nav.connect);
  else if (nav.query) {
    $('q').value = nav.query;
    $('searchForm').requestSubmit();
  }
});

// ---------- Katalog & MCP-Registry-Suche ----------

let lastResults = [];
if ($('q')) {
  $('q').addEventListener('input', () => {
    renderConnectors();
    if (!$('q').value.trim() && $('registryBlock')) {
      $('registryBlock').classList.add('hidden');
    }
  });
}

$('searchForm').onsubmit = async (e) => {
  e.preventDefault();
  renderConnectors();
  const query = $('q').value.trim();
  if (!query) return;
  if ($('registryBlock')) $('registryBlock').classList.remove('hidden');
  $('results').innerHTML = '<div class="muted small" style="grid-column:1/-1">Suche im MCP-Verzeichnis …</div>';
  let r;
  try {
    r = await z.searchRegistry(query);
  } catch (err) {
    r = { error: String(err.message || err) };
  }
  if (r.error) {
    $('results').innerHTML = `<div class="bad small" style="grid-column:1/-1">${esc(r.error)}</div>`;
    return;
  }
  lastResults = r.results;
  if (!lastResults.length) {
    $('results').innerHTML =
      '<div class="muted small" style="grid-column:1/-1">Keine weiteren Server im Verzeichnis gefunden.</div>';
    return;
  }
  const installed = new Set(S.servers.map((s) => s.name));
  $('results').innerHTML = lastResults
    .map((x, i) => {
      const isInstalled = installed.has(x.title);
      return `<div class="gem-item" data-install="${i}">
        <div class="gem-icon">${connectorIcon(x.title)}${isInstalled ? '<span class="gem-dot"></span>' : ''}</div>
        <div class="gem-body">
          <div class="gem-title">${esc(x.title)} <span class="badge">${esc(x.kind)}</span></div>
          <div class="gem-desc" title="${esc(x.description)}">${esc(x.description || x.name)}</div>
        </div>
        <button type="button" class="gem-act" title="${isInstalled ? 'Erneut einrichten' : 'Hinzufügen'}"${x.kind === 'unbekannt' ? ' disabled' : ''}>${isInstalled ? ICON_DOTS : ICON_PLUS}</button>
      </div>`;
    })
    .join('');
  $('results')
    .querySelectorAll('[data-install]')
    .forEach((b) => {
      b.onclick = () => installDialog(lastResults[Number(b.dataset.install)]);
    });
};

function installDialog(x) {
  const fields = x.env
    .map(
      (v, i) => `
    <label>${esc(v.name)}${v.required ? ' *' : ''}</label>
    <input type="${v.secret ? 'password' : 'text'}" data-env="${i}" value="${esc(v.default)}" spellcheck="false">
    ${v.description ? `<div class="hint">${esc(v.description)}</div>` : ''}`
    )
    .join('');
  dialog(
    `„${x.title}“ hinzufügen`,
    `
    <p class="small muted">${esc(x.description)}</p>
    <label>Name in Aura</label><input type="text" id="iName" value="${esc(x.title.replace(/[^A-Za-z0-9_.-]/g, '-'))}" spellcheck="false">
    ${fields || '<p class="small muted">Keine Einstellungen nötig.</p>'}
    <div class="hint">Wird beim ersten Start über ${x.kind === 'npm' ? 'npx (Node.js nötig)' : x.kind === 'pypi' ? 'uvx (uv nötig)' : x.kind === 'oci' ? 'Docker' : 'das Internet'} geladen. Geheime Felder speichert Aura verschlüsselt unter „Schlüssel“.</div>`,
    async () => {
      const env = {};
      for (const el of document.querySelectorAll('[data-env]')) {
        const v = x.env[Number(el.dataset.env)];
        if (v.required && !el.value.trim()) return `${v.name} fehlt.`;
        env[v.name] = { value: el.value.trim(), secret: v.secret || /KEY|TOKEN|SECRET|PASSWORD|AUTH/i.test(v.name) };
      }
      const r = await z.installRegistry({ name: $('iName').value.trim(), server: x.server, env });
      if (r.error) return r.error;
      await load();
      show('catalog');
      return null;
    },
    'Hinzufügen'
  );
}

// ---------- Skills (Google-Gemini-Stil, 2-Spalten-Grid) ----------

function buildSkillItems(filterQuery = '') {
  const q = filterQuery.trim().toLowerCase();
  const installedByName = new Map((S ? S.skills : []).map((k) => [k.name, k]));
  const items = [];

  // Zuerst alle installierten Skills
  for (const k of S ? S.skills : []) {
    const starter = STARTER_SKILLS.find((st) => st.name === k.name);
    items.push({
      installed: true,
      name: k.name,
      title: starter ? starter.title : k.name,
      description: k.description || 'Eigener Skill',
      enabled: k.enabled,
      icon: skillIcon(k.name)
    });
  }

  // Danach Starter-Skills, die noch nicht installiert sind
  for (const st of STARTER_SKILLS) {
    if (installedByName.has(st.name)) continue;
    items.push({
      installed: false,
      name: st.name,
      title: st.title,
      description: st.description,
      enabled: false,
      icon: st.icon,
      starterContent: st.content
    });
  }

  if (!q) return items;
  return items.filter(
    (it) =>
      it.title.toLowerCase().includes(q) ||
      it.name.toLowerCase().includes(q) ||
      String(it.description || '')
        .toLowerCase()
        .includes(q)
  );
}

function renderSkillGrid(container, items) {
  if (!container) return;
  if (!items.length) {
    container.innerHTML = '<div class="empty" style="grid-column:1/-1">Keine passenden Skills gefunden.</div>';
    return;
  }
  container.innerHTML = items
    .map((it) => {
      const dot = it.installed ? (it.enabled ? '<span class="gem-dot" title="Aktiv"></span>' : '') : '';
      const badge = it.installed
        ? it.enabled
          ? '<span class="badge ok">Aktiv</span>'
          : '<span class="badge">Aus</span>'
        : '';
      const actIcon = it.installed ? ICON_DOTS : ICON_PLUS;
      const actTitle = it.installed ? `Skill „${it.title}“ bearbeiten` : `Skill „${it.title}“ hinzufügen`;
      return `<div class="gem-item" data-sk-name="${esc(it.name)}" data-sk-installed="${it.installed ? '1' : '0'}">
        <div class="gem-icon">${it.icon}${dot}</div>
        <div class="gem-body">
          <div class="gem-title">${esc(it.title)}${badge}</div>
          <div class="gem-desc" title="${esc(it.description)}">${esc(it.description)}</div>
        </div>
        <button type="button" class="gem-act" title="${esc(actTitle)}" aria-label="${esc(actTitle)}">${actIcon}</button>
      </div>`;
    })
    .join('');

  container.querySelectorAll('.gem-item').forEach((row) => {
    row.onclick = async (e) => {
      const name = row.dataset.skName;
      const isInstalled = row.dataset.skInstalled === '1';
      if (isInstalled) {
        skillDialog(name);
      } else {
        const starter = STARTER_SKILLS.find((s) => s.name === name);
        if (!starter) return;
        const clickedAct = e.target.closest('.gem-act');
        if (clickedAct) {
          const r = await z.saveSkill({ name: null, content: starter.content, isNew: true });
          if (r && r.error) alert(r.error);
          await load();
        } else {
          skillDialog(null, starter.content, starter.title);
        }
      }
    };
  });
}

function renderSkills() {
  const q = $('skillSearch') ? $('skillSearch').value : '';
  renderSkillGrid($('skillList'), buildSkillItems(q));
  renderSkillGrid($('discoverSkills'), buildSkillItems('').slice(0, 6));
}

if ($('skillSearch')) {
  $('skillSearch').addEventListener('input', () => renderSkills());
}

const SKILL_TEMPLATE = `---
name: mein-skill
description: Wann Aura diesen Skill nutzen soll, z. B. "Sortiert Rechnungen aus ~/Downloads in Monatsordner"
---

# Mein Skill

Schritt für Schritt, was Aura tun soll:

1. …
2. …
`;

async function skillDialog(name, initialContent = null, customTitle = null) {
  const k = name ? await z.getSkill(name) : null;
  const meta = name && S && S.skills ? S.skills.find((x) => x.name === name) : null;
  dialog(
    customTitle ? `Skill „${customTitle}“ hinzufügen` : name ? `Skill „${name}“` : 'Skill erstellen',
    `
    ${
      meta
        ? `<div style="display:flex;align-items:center;justify-content:space-between;padding:4px 0 12px;margin-bottom:8px;border-bottom:1px solid var(--line)">
            <span>Skill aktivieren</span>
            <label class="switch"><input type="checkbox" id="sEnabled"${meta.enabled ? ' checked' : ''}><span></span></label>
          </div>`
        : ''
    }
    <textarea id="sContent" class="editor" spellcheck="false">${esc(k ? k.content : initialContent || SKILL_TEMPLATE)}</textarea>
    <div class="hint">Oben zwischen den <code>---</code>: <b>name</b> (Kleinbuchstaben, Ziffern, Minus) und <b>description</b>. Daran erkennt das Modell, wann der Skill passt.${k ? ` Ordner: ${esc(k.dir)}` : ''}</div>
    ${meta ? `<div style="margin-top:12px"><button type="button" id="sDeleteBtn" class="small danger">Skill löschen</button></div>` : ''}`,
    async () => {
      if (meta && $('sEnabled')) {
        const want = $('sEnabled').checked;
        if (want !== meta.enabled) await z.toggleSkill(name, want);
      }
      const r = await z.saveSkill({ name, content: $('sContent').value, isNew: !name });
      if (r.error) return r.error;
      await load();
      return null;
    },
    name ? 'Speichern' : 'Hinzufügen'
  );
  if ($('sDeleteBtn')) {
    $('sDeleteBtn').onclick = async () => {
      if (!confirm(`Skill „${name}“ mit seinem Ordner löschen?`)) return;
      const r = await z.deleteSkill(name);
      if (r.error) alert(r.error);
      $('dlg').classList.add('hidden');
      await load();
    };
  }
}
$('newSkill').onclick = () => skillDialog(null);

// ---------- Anweisungen ----------

let mdDirty = false;
$('agentsMd').addEventListener('input', () => {
  mdDirty = true;
  $('mdStatus').textContent = 'Nicht gespeichert';
});
$('saveMd').onclick = async () => {
  await z.saveAgentsMd($('agentsMd').value);
  mdDirty = false;
  $('mdStatus').textContent = 'Gespeichert';
  load();
};

// ---------- Schlüssel ----------

const fmtDate = (ms) =>
  ms ? new Date(ms).toLocaleDateString('de-DE', { day: '2-digit', month: '2-digit', year: 'numeric' }) : '';

async function renderSecrets() {
  const r = await z.secrets();
  const prot = {
    strong: [
      'banner-ok',
      'Verschlüsselt mit dem Schlüsselspeicher des Betriebssystems (Windows: DPAPI deines Benutzerkontos, Linux: GNOME-Schlüsselbund bzw. KWallet). Andere Benutzer und Programme ohne Zugriff auf dein Konto können die Datei nicht lesen.'
    ],
    weak: [
      'banner-warn',
      r.allowWeak
        ? 'Kein Schlüsselbund gefunden. Du hast erlaubt, Schlüssel trotzdem zu speichern; sie sind nur mit einem festen Kennwort verschlüsselt. Besser: gnome-keyring oder KWallet installieren bzw. entsperren und Aura neu starten.'
        : 'Kein Schlüsselbund gefunden: Aura würde nur mit einem festen Kennwort verschlüsseln und nimmt deshalb keine neuen Schlüssel an. Installiere bzw. entsperre gnome-keyring oder KWallet und starte Aura neu.'
    ],
    none: [
      'banner-bad',
      'Verschlüsselung ist hier nicht verfügbar, deshalb nimmt Aura keine neuen Schlüssel an. Unter Linux: gnome-keyring oder KWallet installieren und Aura neu starten.'
    ]
  }[r.protection];
  const weakToggle =
    r.protection === 'weak'
      ? `<label class="check"><input type="checkbox" id="allowWeak"${r.allowWeak ? ' checked' : ''}> Trotzdem schwach geschützt speichern (nicht empfohlen)</label>`
      : '';
  const plainWarn = r.geminiPlaintext
    ? '<div class="banner-bad">Der Gemini-Key liegt noch unverschlüsselt in den Einstellungen (von einer älteren Aura-Version). Sobald ein Schlüsselbund verfügbar ist, verschlüsselt Aura ihn automatisch; oder ersetze ihn hier.</div>'
    : '';
  $('secretProtection').innerHTML = `<span class="${prot[0]}">${esc(prot[1])}</span>${weakToggle}${plainWarn}`;
  if ($('allowWeak')) {
    $('allowWeak').onchange = async (e) => {
      await z.setWeakStorage(e.target.checked);
      renderSecrets();
    };
  }
  const KIND = {
    api_key: 'API-Key',
    oauth: 'Anmeldung (OAuth)',
    password: 'Passwort',
    basic: 'Benutzer + Passwort',
    login: 'Website-Login'
  };
  $('secretList').innerHTML = r.list
    .map((k) => {
      const status = k.builtin
        ? k.set
          ? `<span class="badge ok">gesetzt${k.fromEnv ? ' (Umgebungsvariable)' : ''}</span>`
          : '<span class="badge">nicht gesetzt</span>'
        : k.broken
          ? '<span class="badge bad">nicht lesbar</span>'
          : '<span class="badge ok">verschlüsselt</span>';
      const used = k.usedBy.length ? `Genutzt von ${esc(k.usedBy.join(', '))}` : 'Von keinem Server genutzt';
      const meta = [
        KIND[k.kind] || '',
        k.provider ? esc(k.provider) : '',
        k.origin ? 'nur für ' + esc(k.origin) : '',
        k.scopes && k.scopes.length ? 'Rechte: ' + esc(k.scopes.join(', ')) : '',
        k.lastUsed ? 'zuletzt genutzt ' + esc(fmtDate(k.lastUsed)) : '',
        k.expiresAt ? (k.expiresAt < Date.now() ? 'abgelaufen ' : 'läuft ab ') + esc(fmtDate(k.expiresAt)) : ''
      ].filter(Boolean);
      return `<div class="item"><div class="name">${esc(k.name)} ${status}${k.hint ? ` <span class="badge">${esc(k.hint)}</span>` : ''}</div>
      <div class="desc">${meta.length ? meta.join(' · ') + '<br>' : ''}${k.note ? esc(k.note) + ' · ' : ''}${used}${k.updated ? ' · geändert ' + esc(fmtDate(k.updated)) : ''}</div>
      <div class="side">${k.builtin || k.kind === 'login' ? '' : `<button type="button" class="small" data-copy="${esc(k.name)}" title="\${secret:${esc(k.name)}} kopieren">Verweis kopieren</button>`}
      <button type="button" class="small" data-replace="${esc(k.name)}">${k.builtin && !k.set ? 'Festlegen' : 'Ersetzen'}</button>
      ${k.builtin && !k.set ? '' : `<button type="button" class="small danger" data-sdel2="${esc(k.name)}">Löschen</button>`}</div></div>`;
    })
    .join('');
  const list = $('secretList');
  list.querySelectorAll('[data-copy]').forEach((b) => {
    b.onclick = async () => {
      const ref = '${secret:' + b.dataset.copy + '}';
      try {
        await navigator.clipboard.writeText(ref);
        b.textContent = 'Kopiert';
      } catch {
        prompt('Verweis zum Kopieren:', ref);
      }
      setTimeout(() => {
        b.textContent = 'Verweis kopieren';
      }, 1500);
    };
  });
  list.querySelectorAll('[data-replace]').forEach((b) => {
    b.onclick = () => secretDialog(r.list.find((k) => k.name === b.dataset.replace));
  });
  list.querySelectorAll('[data-sdel2]').forEach((b) => {
    b.onclick = async () => {
      const k = r.list.find((x) => x.name === b.dataset.sdel2);
      const warn =
        k.usedBy.length && !k.builtin
          ? `\n\nAchtung: ${k.usedBy.join(', ')} nutzt diesen Schlüssel und startet danach nicht mehr.`
          : '';
      if (!confirm(`Schlüssel „${k.name}“ endgültig löschen?${warn}`)) return;
      await z.deleteSecret(k.name);
      renderSecrets();
      load();
    };
  });
}

function secretDialog(existing) {
  dialog(
    existing ? `Schlüssel „${existing.name}“ ersetzen` : 'Schlüssel hinzufügen',
    `
    <label>Name</label><input type="text" id="kName" value="${esc(existing ? existing.name : '')}" placeholder="z. B. GITHUB_TOKEN" spellcheck="false" autocomplete="off"${existing ? ' disabled' : ''}>
    <label>Wert</label><input type="password" id="kValue" placeholder="${existing ? 'Neuen Wert einfügen' : 'Wert einfügen'}" spellcheck="false" autocomplete="new-password">
    ${existing && existing.builtin ? '' : `<label>Notiz (optional)</label><input type="text" id="kNote" value="${esc(existing ? existing.note : '')}" placeholder="z. B. GitHub, nur Lesezugriff, läuft im März ab" maxlength="200">`}
    <div class="hint">Der Wert wird verschlüsselt gespeichert und danach nie wieder angezeigt.${existing && existing.builtin ? ' Er ersetzt den Gemini-Key aus den Einstellungen.' : ' Verwende ihn in einem MCP-Server als <code>${secret:NAME}</code>.'}</div>`,
    async () => {
      const name = existing ? existing.name : $('kName').value.trim();
      const value = $('kValue').value;
      if (!name) return 'Bitte einen Namen eintragen.';
      if (!value.trim()) return 'Bitte einen Wert einfügen.';
      const note = $('kNote') ? $('kNote').value.trim() : undefined;
      const r = await z.setSecret({ name, value, note });
      $('kValue').value = '';
      if (r && r.error) return r.error;
      renderSecrets();
      load();
      return null;
    }
  );
  setTimeout(() => (existing ? $('kValue') : $('kName')).focus(), 30);
}
$('newSecret').onclick = () => secretDialog(null);
// Website login (AURA-124): Aura fills it in its browser only on this website; the model never sees the password.
$('newLogin').onclick = () =>
  dialog(
    'Website-Login hinzufügen',
    `<p class="small muted">Aura trägt diese Zugangsdaten nur auf genau dieser Website ein, nach deiner Freigabe. Das Sprachmodell sieht das Passwort nie; es kennt nur den Namen.</p>
    <label>Website</label><input type="text" id="lUrl" placeholder="https://www.bahn.de" spellcheck="false">
    <label>Name</label><input type="text" id="lName" placeholder="z. B. BAHN_LOGIN" spellcheck="false">
    <label>Benutzername oder E-Mail</label><input type="text" id="lUser" spellcheck="false" autocomplete="off">
    <label>Passwort</label><input type="password" id="lPass" autocomplete="new-password">`,
    async () => {
      const r = await z.setLogin({
        name: $('lName').value.trim(),
        url: $('lUrl').value.trim(),
        username: $('lUser').value.trim(),
        password: $('lPass').value
      });
      if (r && r.error) return r.error;
      renderSecrets();
      return null;
    },
    'Speichern'
  );

// ---------- Profil ----------

const PROFILE_FIELDS = {
  pName: 'name',
  pLocation: 'location',
  pOccupation: 'occupation',
  pAbout: 'about',
  pPrefs: 'preferences'
};
async function loadProfile() {
  const p = await z.profile();
  for (const [id, key] of Object.entries(PROFILE_FIELDS)) $(id).value = p[key] || '';
  $('pShare').checked = !!p.share;
  for (const r of document.querySelectorAll('input[name=locMode]'))
    r.checked = r.value === (p.locationMode || 'device');
  $('pStatus').textContent = '';
}
for (const r of document.querySelectorAll('input[name=locMode]'))
  r.addEventListener('change', () => {
    $('pStatus').textContent = 'Nicht gespeichert';
  });
for (const id of [...Object.keys(PROFILE_FIELDS), 'pShare'])
  $(id).addEventListener('input', () => {
    $('pStatus').textContent = 'Nicht gespeichert';
  });
$('saveProfile').onclick = async () => {
  const mode = document.querySelector('input[name=locMode]:checked');
  const p = { share: $('pShare').checked, locationMode: mode ? mode.value : 'device' };
  for (const [id, key] of Object.entries(PROFILE_FIELDS)) p[key] = $(id).value.trim();
  await z.saveProfile(p);
  $('pStatus').textContent = 'Gespeichert';
  load();
};

// ---------- Protokoll und Chats ----------

const fmtTime = (iso) =>
  new Date(iso).toLocaleString('de-DE', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });

async function renderLog() {
  const rows = await z.log();
  if (!rows.length) {
    $('logList').innerHTML = '<div class="empty">Noch keine Aktionen.</div>';
    return;
  }
  $('logList').innerHTML =
    `<table><tr><th>Zeit</th><th>Werkzeug</th><th>Details</th><th>Freigabe</th><th>Ergebnis</th></tr>${rows
      .map(
        (r) => `
    <tr><td>${esc(fmtTime(r.ts))}</td><td>${esc(r.tool)}</td><td class="args">${esc(JSON.stringify(r.args || {}).slice(0, 400))}</td>
    <td>${esc(r.decision || '')}</td><td class="${r.ok ? 'ok' : r.decision === 'abgelehnt' ? 'muted' : 'bad'}">${r.ok ? 'ok' : r.decision === 'abgelehnt' ? '–' : esc(r.error || 'Fehler')}</td></tr>`
      )
      .join('')}</table>`;
}
$('reloadLog').onclick = () => {
  renderLog();
  renderAudit();
};

// ---------- Agent v2: Protokoll, Regeln, Gedächtnis, Systemprüfung ----------

async function renderAudit() {
  const rows = await z.audit();
  if (!rows.length) {
    $('auditList').innerHTML = '<div class="empty">Noch keine Aufträge mit Agent v2.</div>';
    return;
  }
  $('auditList').innerHTML =
    `<table><tr><th>Zeit</th><th>Ereignis</th><th>Werkzeug</th><th>Details</th><th>Ergebnis</th></tr>${rows
      .map(
        (r) => `
    <tr><td>${esc(fmtTime(r.ts))}</td><td>${esc(r.kind)}</td><td>${esc(r.tool)}</td><td class="args">${esc(String(r.detail).slice(0, 300))}</td>
    <td class="${r.bad ? 'bad' : 'ok'}">${esc(r.result)}</td></tr>`
      )
      .join('')}</table>`;
}

function parsePolicyBlocks(text) {
  const src = String(text || '');
  const parts = src.split(/(?=\[\[rule\]\])/g);
  const preamble = parts.length && !parts[0].trimStart().startsWith('[[rule]]') ? parts.shift() : '';
  const blocks = parts.map((raw) => {
    const kv = {};
    for (const line of raw.split('\n')) {
      const m = line.match(/^\s*([a-z_]+)\s*=\s*"([^"]*)"/);
      if (m) kv[m[1]] = m[2];
    }
    return {
      raw,
      tool: kv.tool || '',
      decision: kv.decision || 'ask',
      commandPrefix: kv.command_prefix || '',
      pathUnder: kv.path_under || '',
      domain: kv.domain || '',
      reason: kv.reason || ''
    };
  });
  return { preamble, blocks };
}

function serializeRuleBlock(r) {
  const lines = ['[[rule]]'];
  if (r.tool) lines.push(`tool = ${JSON.stringify(String(r.tool))}`);
  lines.push(`decision = ${JSON.stringify(String(r.decision || 'ask'))}`);
  if (r.commandPrefix) lines.push(`command_prefix = ${JSON.stringify(String(r.commandPrefix))}`);
  if (r.pathUnder) lines.push(`path_under = ${JSON.stringify(String(r.pathUnder))}`);
  if (r.domain) lines.push(`domain = ${JSON.stringify(String(r.domain))}`);
  if (r.reason) lines.push(`reason = ${JSON.stringify(String(r.reason))}`);
  return lines.join('\n') + '\n';
}

function renderQuickRules() {
  if (!$('rulesQuickList') || !S) return;
  const builtins = S.builtins || [];
  const getToolState = (name) => {
    const t = builtins.find((b) => b.name === name);
    if (!t) return 'default';
    if (!t.enabled) return 'deny';
    if (t.policy === 'allow') return 'allow';
    if (t.policy === 'ask') return 'ask';
    return 'default';
  };
  const items = [
    {
      name: 'run_command',
      title: 'Terminal-Befehle ausführen (run_command)',
      desc: 'Gilt für alle Shell-Programme (git, npm, ls, python …), sofern keine Feinregel greift.'
    },
    {
      name: 'write_file',
      title: 'Dateien schreiben & ändern (write_file)',
      desc: 'Erstellen oder Überschreiben von Dateien auf deiner Festplatte.'
    },
    {
      name: 'read_file',
      title: 'Dateien & Ordner lesen (read_file)',
      desc: 'Lesen von lokalen Textdateien und Projektordnern.'
    },
    {
      name: 'fetch_url',
      title: 'Webseiten & APIs abrufen (fetch_url)',
      desc: 'Abrufen öffentlicher Webseiten und Dokumentationen.'
    }
  ];
  $('rulesQuickList').innerHTML = items
    .map((it) => {
      const cur = getToolState(it.name);
      return `<div class="item">
        <div class="name">${esc(it.title)}</div>
        <div class="desc">${esc(it.desc)}</div>
        <div class="side">
          <select class="policy-select" data-quick-rule="${esc(it.name)}">
            <option value="default"${cur === 'default' ? ' selected' : ''}>Standard (Nachfragen wenn nötig)</option>
            <option value="allow"${cur === 'allow' ? ' selected' : ''}>Immer erlauben (Nie fragen)</option>
            <option value="ask"${cur === 'ask' ? ' selected' : ''}>Immer fragen</option>
            <option value="deny"${cur === 'deny' ? ' selected' : ''}>Nie erlauben (Aus)</option>
          </select>
        </div>
      </div>`;
    })
    .join('');

  $('rulesQuickList')
    .querySelectorAll('[data-quick-rule]')
    .forEach((sel) => {
      sel.onchange = async () => {
        const name = sel.dataset.quickRule;
        const v = sel.value;
        if (v === 'deny') {
          await z.toggleBuiltin(name, false);
        } else {
          await z.toggleBuiltin(name, true);
          await z.setBuiltinPolicy(name, v === 'default' ? null : v);
        }
        await load(true);
        renderQuickRules();
      };
    });
}

function renderVisualRules(policyText) {
  if (!$('rulesVisualList')) return;
  const { preamble, blocks } = parsePolicyBlocks(policyText);
  if (!blocks.length) {
    $('rulesVisualList').innerHTML =
      '<div class="empty">Noch keine einzelnen Feinregeln in policy.toml definiert. Über „+ Feinregel hinzufügen“ kannst du z. B. bestimmte Terminal-Befehle wie <code>git status</code> immer erlauben.</div>';
    return;
  }
  $('rulesVisualList').innerHTML = blocks
    .map((b, idx) => {
      const conds = [
        b.tool ? `Werkzeug: <code>${esc(b.tool)}</code>` : 'Alle Werkzeuge',
        b.commandPrefix ? `Befehl beginnt mit: <code>${esc(b.commandPrefix)}</code>` : '',
        b.pathUnder ? `Ordner: <code>${esc(b.pathUnder)}</code>` : '',
        b.domain ? `Domain: <code>${esc(b.domain)}</code>` : ''
      ]
        .filter(Boolean)
        .join(' · ');
      return `<div class="item">
        <div class="name">${conds}</div>
        <div class="desc">${b.reason ? esc(b.reason) : 'Benutzerdefinierte Regel in policy.toml'}</div>
        <div class="side">
          <select class="policy-select" data-vrule-dec="${idx}">
            <option value="allow"${b.decision === 'allow' ? ' selected' : ''}>Immer erlauben (allow)</option>
            <option value="ask"${b.decision === 'ask' ? ' selected' : ''}>Nachfragen (ask)</option>
            <option value="deny"${b.decision === 'deny' ? ' selected' : ''}>Verbieten (deny)</option>
          </select>
          <button type="button" class="small danger" data-vrule-del="${idx}">Löschen</button>
        </div>
      </div>`;
    })
    .join('');

  const saveUpdatedBlocks = async (newBlocks) => {
    const newText = (preamble ? preamble.trimEnd() + '\n\n' : '') + newBlocks.map(serializeRuleBlock).join('\n');
    $('rulesText').value = newText;
    const res = await z.savePolicy(newText);
    if ($('ruleStatus')) {
      $('ruleStatus').textContent = res.ok
        ? 'Gespeichert, gilt ab dem nächsten Auftrag'
        : 'Nicht gespeichert: ' + res.problems.join('; ');
      $('ruleStatus').className = res.ok ? 'muted small' : 'bad small';
    }
    renderVisualRules(newText);
  };

  $('rulesVisualList')
    .querySelectorAll('[data-vrule-dec]')
    .forEach((sel) => {
      sel.onchange = () => {
        const idx = Number(sel.dataset.vruleDec);
        blocks[idx].decision = sel.value;
        saveUpdatedBlocks(blocks);
      };
    });

  $('rulesVisualList')
    .querySelectorAll('[data-vrule-del]')
    .forEach((btn) => {
      btn.onclick = () => {
        const idx = Number(btn.dataset.vruleDel);
        blocks.splice(idx, 1);
        saveUpdatedBlocks(blocks);
      };
    });
}

if ($('addRuleBtn')) {
  $('addRuleBtn').onclick = () => {
    dialog(
      'Feinregel hinzufügen',
      `<label>Werkzeug</label>
      <select id="nrTool">
        <option value="shell">Terminal-Befehl (shell / run_command)</option>
        <option value="fs.write">Dateien schreiben (fs.write)</option>
        <option value="fs.delete">Dateien löschen (fs.delete)</option>
        <option value="http.get">Web-Abruf (http.get)</option>
        <option value="">Alle Werkzeuge</option>
      </select>
      <label>Entscheidung</label>
      <select id="nrDecision">
        <option value="allow">Immer erlauben (Nie fragen)</option>
        <option value="ask">Immer nachfragen (Standard)</option>
        <option value="deny">Nie erlauben (Blockieren)</option>
      </select>
      <label>Befehl beginnt mit (optional, z. B. <code>git status</code> oder <code>npm test</code>)</label>
      <input type="text" id="nrCmd" placeholder="z. B. git status" spellcheck="false">
      <label>Nur in diesem Ordner (optional, z. B. <code>~/Projekte</code>)</label>
      <input type="text" id="nrPath" placeholder="z. B. ~/workspace" spellcheck="false">
      <label>Notiz / Grund (optional)</label>
      <input type="text" id="nrReason" placeholder="z. B. Lese-Befehle im Git-Repo ohne Nachfrage">`,
      async () => {
        const rule = {
          tool: $('nrTool').value.trim(),
          decision: $('nrDecision').value,
          commandPrefix: $('nrCmd').value.trim(),
          pathUnder: $('nrPath').value.trim(),
          reason: $('nrReason').value.trim()
        };
        const current = $('rulesText').value || '';
        const nextText = (current.trimEnd() ? current.trimEnd() + '\n\n' : '') + serializeRuleBlock(rule);
        const r = await z.savePolicy(nextText);
        if (!r.ok) return 'Nicht gespeichert: ' + r.problems.join('; ');
        $('rulesText').value = nextText;
        renderVisualRules(nextText);
        return null;
      },
      'Regel speichern'
    );
  };
}

async function loadRules() {
  const r = await z.policy();
  $('rulesFile').textContent = r.file;
  $('rulesText').value = r.text;
  $('ruleStatus').textContent = '';
  renderQuickRules();
  renderVisualRules(r.text);
}
$('saveRules').onclick = async () => {
  const r = await z.savePolicy($('rulesText').value);
  $('ruleStatus').textContent = r.ok
    ? 'Gespeichert, gilt ab dem nächsten Auftrag'
    : 'Nicht gespeichert: ' + r.problems.join('; ');
  $('ruleStatus').className = r.ok ? 'muted small' : 'bad small';
  if (r.ok) renderVisualRules($('rulesText').value);
};

// ---------- Einstellungen & Modelle (integriert in Aura Zentrale) ----------

let currentSettingsData = null;
const HOTKEY_MODIFIERS = new Set(['Control', 'Alt', 'Shift', 'Meta']);

function eventToAccelerator(e) {
  if (HOTKEY_MODIFIERS.has(e.key)) return null;
  const parts = [];
  if (e.ctrlKey || e.metaKey) parts.push('CommandOrControl');
  if (e.altKey) parts.push('Alt');
  if (e.shiftKey) parts.push('Shift');
  if (parts.length === 0) return null;
  const keyMap = {
    ' ': 'Space',
    ArrowUp: 'Up',
    ArrowDown: 'Down',
    ArrowLeft: 'Left',
    ArrowRight: 'Right',
    Escape: 'Escape',
    Enter: 'Return',
    Backspace: 'Backspace',
    Delete: 'Delete',
    Tab: 'Tab'
  };
  let key = keyMap[e.key];
  if (!key) {
    if (e.key.length === 1) key = e.key.toUpperCase();
    else if (/^F\d{1,2}$/.test(e.key)) key = e.key;
    else return null;
  }
  parts.push(key);
  return parts.join('+');
}

function updateProviderVisibility(provider) {
  if ($('cfgGeminiCard')) $('cfgGeminiCard').classList.toggle('hidden', provider === 'ollama');
  if ($('cfgOllamaCard')) $('cfgOllamaCard').classList.toggle('hidden', provider !== 'ollama');
}

async function refreshOllamaInZentrale(preferredModel) {
  if (!$('cfgOllamaHint')) return;
  $('cfgOllamaHint').textContent = 'Prüfe Ollama …';
  $('cfgOllamaHint').className = 'hint';
  const st = await z.ollamaStatus($('cfgOllamaUrl').value);
  const select = $('cfgOllamaModel');
  select.innerHTML = '';
  const current = preferredModel ?? (currentSettingsData && currentSettingsData.ollamaModel) ?? '';
  if (!st || !st.running) {
    const opt = document.createElement('option');
    opt.value = current || 'gemma4:e4b';
    opt.textContent = `${opt.value} (Ollama nicht erreichbar)`;
    select.appendChild(opt);
    $('cfgOllamaHint').textContent =
      'Ollama läuft nicht oder ist unter dieser Adresse nicht erreichbar. Starte Ollama oder lade es unter ollama.com herunter.';
    $('cfgOllamaHint').className = 'bad small';
    return;
  }
  if (!st.models.length) {
    const opt = document.createElement('option');
    opt.value = current || 'gemma4:e4b';
    opt.textContent = `${opt.value} (noch nicht geladen)`;
    select.appendChild(opt);
    $('cfgOllamaHint').textContent =
      'Ollama läuft, aber es ist noch kein Modell geladen. Nutze unten „Laden“, um z. B. gemma4:e4b herunterzuladen.';
    $('cfgOllamaHint').className = 'hint';
    return;
  }
  for (const m of st.models) {
    const opt = document.createElement('option');
    opt.value = m;
    opt.textContent = m;
    select.appendChild(opt);
  }
  if (current && !st.models.includes(current)) {
    const opt = document.createElement('option');
    opt.value = current;
    opt.textContent = `${current} (nicht installiert)`;
    select.appendChild(opt);
  }
  select.value = current || st.models[0];
  $('cfgOllamaHint').textContent = `Verbunden — ${st.models.length} Modell(e) verfügbar.`;
  $('cfgOllamaHint').className = 'ok small';
}

async function loadSettingsPage() {
  if (!$('cfgProvider')) return;
  const s = await z.getSettings();
  currentSettingsData = s;
  $('cfgProvider').value = s.provider || 'gemini';
  updateProviderVisibility($('cfgProvider').value);
  $('cfgApiKey').value = '';
  $('cfgApiKey').placeholder = s.apiKeyHint ? `Gespeichert (${s.apiKeyHint})` : 'AIza...';
  $('cfgKeyHint').textContent = s.apiKeyFromEnv
    ? 'Wird aktuell aus Umgebungsvariable GEMINI_API_KEY geladen.'
    : s.hasApiKey
      ? `Gespeicherter Schlüssel: ${s.apiKeyHint}`
      : 'Noch kein API-Key hinterlegt.';
  $('cfgKeyHint').className = 'hint';
  $('cfgMonthlyBudget').value = s.monthlyBudget > 0 ? String(s.monthlyBudget) : '';
  if (s.usage) {
    const spent = s.usage.spentEur.toFixed(2).replace('.', ',');
    const tok = Math.round(s.usage.inputTokens + s.usage.outputTokens).toLocaleString('de-DE');
    $('cfgUsageInfo').textContent =
      s.monthlyBudget > 0
        ? `Diesen Monat (${s.usage.month}): ca. ${spent} € von ${s.monthlyBudget.toFixed(2).replace('.', ',')} € (${s.usage.calls} Anfragen, ${tok} Token)`
        : `Diesen Monat (${s.usage.month}): ca. ${spent} € (${s.usage.calls} Anfragen, ${tok} Token)`;
  }
  $('cfgOllamaUrl').value = s.ollamaUrl || 'http://127.0.0.1:11434';
  if ($('cfgProvider').value === 'ollama') {
    refreshOllamaInZentrale(s.ollamaModel);
  }
  $('cfgWhisperModel').value = s.whisperModel || 'Xenova/whisper-small';
  $('cfgLanguage').value = s.language || '';
  if (s.hotkeys) {
    $('cfgHkListen').value = s.hotkeys.listen || '';
    $('cfgHkAsk').value = s.hotkeys.ask || '';
    $('cfgHkRead').value = s.hotkeys.read || '';
  }
  if ($('cfgThemeSelect')) {
    $('cfgThemeSelect').value = document.documentElement.getAttribute('data-theme') || 'dark';
  }
  $('cfgPanelCorner').value = s.panelCorner || 'bottom-right';
  $('cfgGlowEnabled').checked = s.glowEnabled !== false;
  $('cfgAutostart').checked = Boolean(s.autostart);
}

if ($('cfgProvider')) {
  $('cfgProvider').onchange = () => {
    const p = $('cfgProvider').value;
    updateProviderVisibility(p);
    if (p === 'ollama') refreshOllamaInZentrale();
  };
}

if ($('cfgThemeSelect')) {
  $('cfgThemeSelect').onchange = () => {
    applyTheme($('cfgThemeSelect').value, true);
  };
}

if ($('cfgTestKey')) {
  $('cfgTestKey').onclick = async () => {
    $('cfgTestKey').disabled = true;
    $('cfgKeyHint').textContent = 'Prüfe API-Key …';
    $('cfgKeyHint').className = 'hint';
    const res = await z.testKey($('cfgApiKey').value.trim());
    $('cfgTestKey').disabled = false;
    $('cfgKeyHint').textContent = res.ok ? 'API-Key funktioniert!' : `Fehler: ${res.error}`;
    $('cfgKeyHint').className = res.ok ? 'ok small' : 'bad small';
  };
}

if ($('cfgOllamaCheck')) {
  $('cfgOllamaCheck').onclick = () => refreshOllamaInZentrale($('cfgOllamaModel').value);
}

if ($('cfgOllamaPull')) {
  $('cfgOllamaPull').onclick = async () => {
    const name = $('cfgOllamaPullName').value.trim() || $('cfgOllamaModel').value.trim();
    if (!name) return;
    $('cfgOllamaPull').disabled = true;
    $('cfgOllamaHint').textContent = `Lade „${name}“ herunter …`;
    $('cfgOllamaHint').className = 'hint';
    const res = await z.ollamaPull({ url: $('cfgOllamaUrl').value, model: name });
    $('cfgOllamaPull').disabled = false;
    if (res && res.ok) {
      $('cfgOllamaPullName').value = '';
      await refreshOllamaInZentrale(name);
      $('cfgOllamaHint').textContent = `„${name}“ ist bereit.`;
      $('cfgOllamaHint').className = 'ok small';
    } else {
      $('cfgOllamaHint').textContent = `Fehler: ${(res && res.error) || 'Unbekannt'}`;
      $('cfgOllamaHint').className = 'bad small';
    }
  };
}

document.querySelectorAll('.cfg-hotkey').forEach((input) => {
  input.addEventListener('keydown', (e) => {
    e.preventDefault();
    e.stopPropagation();
    const acc = eventToAccelerator(e);
    if (acc) {
      input.value = acc;
      input.blur();
    }
  });
});

if ($('cfgSaveBtn')) {
  $('cfgSaveBtn').onclick = async () => {
    const patch = {
      provider: $('cfgProvider').value,
      ollamaUrl: $('cfgOllamaUrl').value.trim() || 'http://127.0.0.1:11434',
      ollamaModel:
        $('cfgOllamaModel').value || (currentSettingsData && currentSettingsData.ollamaModel) || 'gemma4:e4b',
      monthlyBudget: Number($('cfgMonthlyBudget').value) || 0,
      whisperModel: $('cfgWhisperModel').value,
      language: $('cfgLanguage').value,
      theme: ($('cfgThemeSelect') && $('cfgThemeSelect').value) || currentTheme(),
      panelCorner: $('cfgPanelCorner').value,
      glowEnabled: $('cfgGlowEnabled').checked,
      autostart: $('cfgAutostart').checked,
      hotkeys: {
        listen: $('cfgHkListen').value,
        ask: $('cfgHkAsk').value,
        read: $('cfgHkRead').value
      }
    };
    const typedKey = $('cfgApiKey').value.trim();
    if (typedKey) patch.apiKey = typedKey;
    const res = await z.saveSettings(patch);
    if (res && res.ok) {
      $('cfgSaveStatus').textContent = 'Einstellungen gespeichert!';
      $('cfgSaveStatus').className = 'ok small';
      await load(true);
      await loadSettingsPage();
      setTimeout(() => {
        if ($('cfgSaveStatus')) $('cfgSaveStatus').textContent = '';
      }, 2500);
    } else {
      $('cfgSaveStatus').textContent = (res && res.error) || 'Fehler beim Speichern';
      $('cfgSaveStatus').className = 'bad small';
    }
  };
}

// Memory page (AURA-108): facts with provenance; edit, delete, pause.
const MEM_SOURCE = { explicit: 'gesagt', learned: 'gelernt', imported: 'übernommen', edited: 'bearbeitet' };
async function loadMemory() {
  $('memStatus').textContent = '';
  const r = await z.memory();
  $('memPause').checked = !!r.paused;
  if (r.unavailable) {
    $('memList').innerHTML =
      '<div class="empty">Das Gedächtnis gehört zu Agent v2, der hier nicht installiert ist.</div>';
    return;
  }
  if (!r.facts.length) {
    $('memList').innerHTML = '<div class="empty">Noch nichts gemerkt.</div>';
    return;
  }
  const topics = new Map();
  for (const f of r.facts) topics.set(f.topic, [...(topics.get(f.topic) || []), f]);
  $('memList').innerHTML = [...topics]
    .map(
      ([topic, facts]) =>
        `<h3>${esc(topic)}</h3>${facts
          .map(
            (f) => `<div class="item"><div class="name">${esc(f.text)}</div>
      <div class="desc"><span class="badge">${esc(MEM_SOURCE[f.source] || f.source)}</span> ${esc(fmtDate(f.created * 1000))}${f.last_used ? ' · zuletzt genutzt ' + esc(fmtDate(f.last_used * 1000)) : ''}</div>
      <div class="side"><button type="button" class="small" data-medit="${esc(f.id)}">Ändern</button><button type="button" class="small danger" data-mdel="${esc(f.id)}">Löschen</button></div></div>`
          )
          .join('')}`
    )
    .join('');
  const byId = new Map(r.facts.map((f) => [f.id, f]));
  $('memList')
    .querySelectorAll('[data-medit]')
    .forEach((b) => {
      b.onclick = () => {
        const f = byId.get(b.dataset.medit);
        dialog(
          'Eintrag ändern',
          `<label>Eintrag</label><input type="text" id="memEdit" value="${esc(f.text)}" maxlength="500">`,
          async () => {
            const res = await z.memoryUpdate({ id: f.id, text: $('memEdit').value });
            if (res && res.error) return res.error;
            loadMemory();
            return null;
          }
        );
      };
    });
  $('memList')
    .querySelectorAll('[data-mdel]')
    .forEach((b) => {
      b.onclick = async () => {
        await z.memoryDelete(b.dataset.mdel);
        loadMemory();
      };
    });
}
$('memPause').onchange = async (e) => {
  await z.memoryPause(e.target.checked);
  $('memStatus').textContent = e.target.checked
    ? 'Pausiert: gilt ab dem nächsten Auftrag'
    : 'Eingeschaltet: gilt ab dem nächsten Auftrag';
};
$('memClear').onclick = async () => {
  if (!confirm('Wirklich alles löschen, was Aura sich gemerkt hat? Das lässt sich nicht rückgängig machen.')) return;
  const r = await z.memoryDeleteAll();
  $('memStatus').textContent = `${r.removed} Einträge gelöscht`;
  loadMemory();
};

const DOC_ICON = { ok: '✓', warn: '!', bad: '✗' };
async function renderDoctor() {
  $('doctorList').innerHTML = '<div class="empty">Prüfe …</div>';
  const checks = await z.doctor();
  $('doctorList').innerHTML = `<table><tr><th></th><th>Bereich</th><th>Befund</th><th>Was tun</th></tr>${checks
    .map(
      (c) => `
    <tr><td class="${c.state === 'ok' ? 'ok' : 'bad'}">${DOC_ICON[c.state] || ''}</td><td>${esc(c.name)}</td><td>${esc(c.detail)}</td>
    <td class="args">${esc(c.fix)}${c.action ? ` <button type="button" class="small" data-doc-action="${esc(c.action)}">Installieren</button>` : ''}</td></tr>`
    )
    .join('')}</table>`;
  $('doctorList')
    .querySelectorAll('[data-doc-action]')
    .forEach((b) => {
      b.onclick = async () => {
        const r = await z[b.dataset.docAction]();
        b.replaceWith(document.createTextNode(' ' + r.message));
      };
    });
}
$('runDoctor').onclick = renderDoctor;

async function renderChats() {
  const list = await z.chats();
  renderSidebarChats();
  if ($('deleteAllChats')) $('deleteAllChats').classList.toggle('hidden', !list.length);
  if (!list.length) {
    $('chatList').innerHTML = '<div class="empty">Noch keine gespeicherten Chats.</div>';
    return;
  }
  $('chatList').innerHTML = list
    .map(
      (c) => `
    <div class="item" data-copen-row="${esc(c.id)}" style="cursor:pointer"><div class="name" style="font-family:inherit">${esc(c.title)}</div><div class="desc">${esc(fmtTime(c.updated))} · ${esc(c.preview)}</div>
    <div class="side"><button type="button" class="small" data-copen="${esc(c.id)}">Im Chat öffnen</button><button type="button" class="small danger" data-cdel="${esc(c.id)}">Löschen</button></div></div>`
    )
    .join('');
  $('chatList')
    .querySelectorAll('[data-copen]')
    .forEach((b) => {
      b.onclick = (e) => {
        e.stopPropagation();
        openChatInZentrale(b.dataset.copen);
      };
    });
  $('chatList')
    .querySelectorAll('[data-copen-row]')
    .forEach((row) => {
      row.onclick = () => openChatInZentrale(row.dataset.copenRow);
    });
  $('chatList')
    .querySelectorAll('[data-cdel]')
    .forEach((b) => {
      b.onclick = async (e) => {
        e.stopPropagation();
        const delId = b.dataset.cdel;
        await z.deleteChat(delId);
        if (delId === activeChatId) {
          activeChatId = newZChatId();
          activeChatHistory = [];
          renderZChatMessages();
        }
        renderChats();
      };
    });
}
if ($('deleteAllChats')) {
  $('deleteAllChats').onclick = async () => {
    const list = await z.chats();
    if (!list.length) return;
    for (const c of list) await z.deleteChat(c.id);
    activeChatId = newZChatId();
    activeChatHistory = [];
    renderZChatMessages();
    renderChats();
  };
}

load();
