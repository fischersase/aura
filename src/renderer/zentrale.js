// Aura Zentrale: Oberfläche.
const $ = (id) => document.getElementById(id);
const z = window.api.z;
let S = null; // letzter Zustand

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

// ---------- Navigation ----------

function show(page) {
  document.querySelectorAll('nav button[data-page]').forEach((b) => b.classList.toggle('on', b.dataset.page === page));
  document.querySelectorAll('.page').forEach((p) => p.classList.toggle('hidden', p.id !== page));
  if (page === 'log') {
    renderLog();
    renderAudit();
  }
  if (page === 'rules') loadRules();
  if (page === 'memory') loadMemory();
  if (page === 'doctor') renderDoctor();
  if (page === 'chats') renderChats();
  if (page === 'secrets') renderSecrets();
  if (page === 'profile') loadProfile();
  if (page === 'catalog') renderConnectors();
}
document.querySelectorAll('nav button[data-page]').forEach((b) => {
  b.onclick = () => show(b.dataset.page);
});
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
    load();
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
  renderOverview();
  renderTools();
  renderServers();
  renderSkills();
  if (document.activeElement !== $('agentsMd') && !mdDirty) $('agentsMd').value = S.agentsMd;
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
    ['overview', S.provider === 'ollama' ? 'lokal' : 'Gemini', esc(S.model)]
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

function renderTools() {
  const label = {
    run_command: 'Befehl ausführen',
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
}

// ---------- MCP-Server ----------

function renderServers() {
  if (!S.servers.length) {
    $('serverList').innerHTML =
      '<div class="empty">Noch keine MCP-Server. Füge einen aus dem <a href="#" id="toCatalog">MCP-Katalog</a> hinzu oder trage ihn selbst ein.</div>';
    $('toCatalog').onclick = (e) => {
      e.preventDefault();
      show('catalog');
    };
    return;
  }
  $('serverList').innerHTML = S.servers
    .map((s) => {
      const state = s.disabled
        ? '<span class="badge">aus</span>'
        : s.auth === 'oauth' && !s.signedIn
          ? ''
          : s.error
            ? '<span class="badge bad">Fehler</span>'
            : '<span class="badge ok">verbunden</span>';
      const tools =
        s.disabled || !s.tools.length
          ? ''
          : `<div class="tools">${s.tools
              .map(
                (t) => `
      <div class="tool"><div class="name">${esc(t.title)}${t.readOnly ? ' <span class="badge">nur lesend</span>' : ''}</div>
      <div class="desc">${esc(t.description.replace(/^\[[^\]]*\]\s*/, ''))}</div>${policySelect(t.name, t.policy)}</div>`
              )
              .join('')}</div>`;
      return `<div class="server">
      <div class="top"><label class="switch"><input type="checkbox" data-toggle="${esc(s.name)}"${s.disabled ? '' : ' checked'}><span></span></label>
        <span class="title">${esc(s.name)}</span>${state}<span class="badge">${s.type === 'http' ? 'Remote' : 'lokal'}</span>
        ${s.auth === 'oauth' ? (s.signedIn ? '<span class="badge ok">angemeldet</span>' : '<span class="badge bad">Anmeldung nötig</span>') : ''}
        ${s.disabled ? '' : `<span class="badge">${s.tools.length} Werkzeuge</span>`}
        <span class="grow"></span>${s.auth === 'oauth' ? (s.signedIn ? `<button class="small" data-signout="${esc(s.name)}">Abmelden</button>` : `<button class="small primary" data-signin="${esc(s.name)}">Anmelden</button>`) : ''}<button class="small" data-edit="${esc(s.name)}">Bearbeiten</button><button class="small danger" data-remove="${esc(s.name)}">Entfernen</button></div>
      <div class="cmd">${esc(s.command)}${s.env.length ? ' · Variablen: ' + esc(s.env.join(', ')) : ''}${s.secretRefs.length ? ' · Schlüssel: ' + esc(s.secretRefs.join(', ')) : ''}</div>
      ${s.plainSecrets.length ? `<div class="warnbox"><span>${esc(s.plainSecrets.join(', '))} steht im Klartext in mcp.json.</span><button class="small" data-protect="${esc(s.name)}">Verschlüsselt speichern</button></div>` : ''}
      ${s.error && !s.disabled ? `<div class="err">${esc(s.error)}</div>` : ''}${tools}</div>`;
    })
    .join('');
  // OAuth sign-in (AURA-95): opens the browser; the Zentrale waits until the user is back.
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

// ---------- Verbindungen: Aura-Katalog (AURA-96) ----------

let connectorEntries = [];
async function renderConnectors() {
  connectorEntries = await z.connectors();
  const label = { coming: 'Kommt bald', advanced: 'Für Fortgeschrittene' };
  $('connectorList').innerHTML = connectorEntries
    .map((c) => {
      const server = c.server ? S.servers.find((s) => s.name === c.server) : null;
      const state = server
        ? server.auth === 'oauth' && !server.signedIn
          ? '<span class="badge warn">Anmeldung nötig</span>'
          : '<span class="badge good">Verbunden</span>'
        : label[c.status]
          ? `<span class="badge">${esc(label[c.status])}</span>`
          : '';
      const action =
        c.status === 'coming'
          ? ''
          : c.status === 'advanced'
            ? `<a href="#" data-url="${esc(c.homepage)}" class="small">Anleitung</a>`
            : server
              ? `<button class="small" data-connect="${esc(c.id)}">Neu einrichten</button>`
              : `<button class="small primary" data-connect="${esc(c.id)}">Verbinden</button>`;
      return `<div class="result connector"><div class="top"><span class="title">${esc(c.title)}</span>
        <span class="badge good" title="Von Aura geprüft">Von Aura geprüft</span>${state}<span class="grow"></span>${action}</div>
        <div class="desc">${esc(c.description)}</div><div class="muted small">Anbieter: ${esc(c.publisher)}</div></div>`;
    })
    .join('');
  $('connectorList')
    .querySelectorAll('[data-connect]')
    .forEach((b) => {
      b.onclick = () => connectDialog(b.dataset.connect);
    });
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
      <input type="${k.secret ? 'password' : k.kind === 'email' ? 'email' : 'text'}" data-cred="${esc(k.name)}" placeholder="${esc(k.label)} hier einfügen" spellcheck="false" autocomplete="off">
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
      return null;
    },
    c.oauth ? 'Anmelden' : 'Verbinden'
  );
  const first = document.querySelector('[data-cred]');
  if (first) first.focus();
}

// From the connect card in the panel: open this page with the entry ready (catalog) or the search filled in.
window.api.onNavigate?.(async (nav) => {
  if (!S) await load();
  show(nav.page || 'catalog');
  if (!nav.connect) return;
  await renderConnectors();
  if (connectorEntries.some((c) => c.id === nav.connect)) connectDialog(nav.connect);
  else if (nav.query) {
    $('q').value = nav.query;
    $('searchForm').requestSubmit();
  }
});

// ---------- Katalog ----------

let lastResults = [];
$('searchForm').onsubmit = async (e) => {
  e.preventDefault();
  $('results').innerHTML = '<p class="muted">Suche …</p>';
  let r;
  try {
    r = await z.searchRegistry($('q').value);
  } catch (err) {
    r = { error: String(err.message || err) };
  }
  if (r.error) {
    $('results').innerHTML = `<p class="bad">${esc(r.error)}</p>`;
    return;
  }
  lastResults = r.results;
  if (!lastResults.length) {
    $('results').innerHTML = '<p class="muted">Nichts gefunden.</p>';
    return;
  }
  const installed = new Set(S.servers.map((s) => s.name));
  const reviewed = new Set(connectorEntries.map((c) => c.title.toLowerCase()));
  $('results').innerHTML = lastResults
    .map(
      (x, i) => `
    <div class="result"><div class="top"><span class="title">${esc(x.title)}</span><span class="badge">${esc(x.kind)}</span><span class="badge">v${esc(x.version)}</span>
      <span class="grow"></span>${x.repo ? `<a href="#" data-url="${esc(x.repo)}" class="small">Quellcode</a>` : ''}
      <button class="small primary" data-install="${i}"${x.kind === 'unbekannt' ? ' disabled' : ''}>${installed.has(x.title) ? 'Nochmal hinzufügen' : 'Hinzufügen'}</button></div>
      <div class="desc">${esc(x.description)}</div><div class="muted small">${esc(x.name)}</div></div>`
    )
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
      show('servers');
      return null;
    },
    'Hinzufügen'
  );
}

// ---------- Skills ----------

function renderSkills() {
  if (!S.skills.length) {
    $('skillList').innerHTML =
      '<div class="empty">Noch keine Skills. Lege einen an oder kopiere Skill-Ordner nach ~/.aura/skills.</div>';
    return;
  }
  $('skillList').innerHTML = S.skills
    .map(
      (k) => `
    <div class="item"><div class="name">${esc(k.name)}</div><div class="desc">${esc(k.description)}<br><span class="small">${esc(k.dir)}</span></div>
    <div class="side"><label class="switch"><input type="checkbox" data-skill="${esc(k.name)}"${k.enabled ? ' checked' : ''}><span></span></label>
    <button class="small" data-sedit="${esc(k.name)}">Bearbeiten</button><button class="small danger" data-sdel="${esc(k.name)}">Löschen</button></div></div>`
    )
    .join('');
  $('skillList')
    .querySelectorAll('[data-skill]')
    .forEach((c) => {
      c.onchange = async () => {
        await z.toggleSkill(c.dataset.skill, c.checked);
        load();
      };
    });
  $('skillList')
    .querySelectorAll('[data-sedit]')
    .forEach((b) => {
      b.onclick = () => skillDialog(b.dataset.sedit);
    });
  $('skillList')
    .querySelectorAll('[data-sdel]')
    .forEach((b) => {
      b.onclick = async () => {
        if (!confirm(`Skill „${b.dataset.sdel}“ mit seinem Ordner löschen?`)) return;
        const r = await z.deleteSkill(b.dataset.sdel);
        if (r.error) alert(r.error);
        load();
      };
    });
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

async function skillDialog(name) {
  const k = name ? await z.getSkill(name) : null;
  dialog(
    name ? `Skill „${name}“` : 'Neuer Skill',
    `
    <textarea id="sContent" class="editor" spellcheck="false">${esc(k ? k.content : SKILL_TEMPLATE)}</textarea>
    <div class="hint">Oben zwischen den <code>---</code>: <b>name</b> (Kleinbuchstaben, Ziffern, Minus) und <b>description</b>. Daran erkennt das Modell, wann der Skill passt.${k ? ` Ordner: ${esc(k.dir)}` : ''}</div>`,
    async () => {
      const r = await z.saveSkill({ name, content: $('sContent').value, isNew: !name });
      if (r.error) return r.error;
      load();
      return null;
    }
  );
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
  const KIND = { api_key: 'API-Key', oauth: 'Anmeldung (OAuth)', password: 'Passwort', basic: 'Benutzer + Passwort' };
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
        k.scopes && k.scopes.length ? 'Rechte: ' + esc(k.scopes.join(', ')) : '',
        k.lastUsed ? 'zuletzt genutzt ' + esc(fmtDate(k.lastUsed)) : '',
        k.expiresAt ? (k.expiresAt < Date.now() ? 'abgelaufen ' : 'läuft ab ') + esc(fmtDate(k.expiresAt)) : ''
      ].filter(Boolean);
      return `<div class="item"><div class="name">${esc(k.name)} ${status}${k.hint ? ` <span class="badge">${esc(k.hint)}</span>` : ''}</div>
      <div class="desc">${meta.length ? meta.join(' · ') + '<br>' : ''}${k.note ? esc(k.note) + ' · ' : ''}${used}${k.updated ? ' · geändert ' + esc(fmtDate(k.updated)) : ''}</div>
      <div class="side">${k.builtin ? '' : `<button class="small" data-copy="${esc(k.name)}" title="\${secret:${esc(k.name)}} kopieren">Verweis kopieren</button>`}
      <button class="small" data-replace="${esc(k.name)}">${k.builtin && !k.set ? 'Festlegen' : 'Ersetzen'}</button>
      ${k.builtin && !k.set ? '' : `<button class="small danger" data-sdel2="${esc(k.name)}">Löschen</button>`}</div></div>`;
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
  $('pStatus').textContent = '';
}
for (const id of [...Object.keys(PROFILE_FIELDS), 'pShare'])
  $(id).addEventListener('input', () => {
    $('pStatus').textContent = 'Nicht gespeichert';
  });
$('saveProfile').onclick = async () => {
  const p = { share: $('pShare').checked };
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

async function loadRules() {
  const r = await z.policy();
  $('rulesFile').textContent = r.file;
  $('rulesText').value = r.text;
  $('ruleStatus').textContent = '';
}
$('saveRules').onclick = async () => {
  const r = await z.savePolicy($('rulesText').value);
  $('ruleStatus').textContent = r.ok
    ? 'Gespeichert, gilt ab dem nächsten Auftrag'
    : 'Nicht gespeichert: ' + r.problems.join('; ');
  $('ruleStatus').className = r.ok ? 'muted small' : 'bad small';
};

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
      <div class="side"><button class="small" data-medit="${esc(f.id)}">Ändern</button><button class="small danger" data-mdel="${esc(f.id)}">Löschen</button></div></div>`
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
    <td class="args">${esc(c.fix)}${c.action ? ` <button class="small" data-doc-action="${esc(c.action)}">Installieren</button>` : ''}</td></tr>`
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
  if (!list.length) {
    $('chatList').innerHTML = '<div class="empty">Noch keine gespeicherten Chats.</div>';
    return;
  }
  $('chatList').innerHTML = list
    .map(
      (c) => `
    <div class="item"><div class="name" style="font-family:inherit">${esc(c.title)}</div><div class="desc">${esc(fmtTime(c.updated))} · ${esc(c.preview)}</div>
    <div class="side"><button class="small danger" data-cdel="${esc(c.id)}">Löschen</button></div></div>`
    )
    .join('');
  $('chatList')
    .querySelectorAll('[data-cdel]')
    .forEach((b) => {
      b.onclick = async () => {
        await z.deleteChat(b.dataset.cdel);
        renderChats();
      };
    });
}

load();
