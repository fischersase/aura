// Kleines Gemini-Fenster: Öffnen/Schließen-Animation, Text-Chat und Live-Ansicht.
const $ = (id) => document.getElementById(id);
const card = $('card');
const messages = $('messages');
const input = $('input');
const sendBtn = $('sendBtn');
const SPRING = 'cubic-bezier(.34, 1.56, .64, 1)';

let chatHistory = [];
let streaming = null; // { id, el, text }
const newChatId = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
let chatId = newChatId(); // unter dieser ID wird der Chat im Verlauf gespeichert
// Incognito (AURA-108): no chat history, no memory; the agent's traces of the chat are deleted when it ends.
let incognito = false;
let includeScreen = false;
let live = null;

// ---------- Öffnen / Schließen (Kreis → Pille → Fenster) ----------

function setCompact() {
  card.classList.toggle('compact', chatHistory.length === 0 && !live && !streaming);
}

function openAnim() {
  card.getAnimations().forEach((a) => a.cancel());
  card.classList.remove('hidden');
  setCompact();
  const W = card.offsetWidth;
  const H = card.offsetHeight;
  const pillH = Math.min(H, 64);
  card.animate(
    [
      {
        width: '56px',
        height: '56px',
        borderRadius: '28px',
        opacity: 0,
        transform: 'translateY(20px) scale(.5)',
        easing: 'cubic-bezier(.2,.8,.2,1)'
      },
      {
        width: '56px',
        height: '56px',
        borderRadius: '28px',
        opacity: 1,
        transform: 'none',
        offset: 0.32,
        easing: SPRING
      },
      {
        width: W + 'px',
        height: pillH + 'px',
        borderRadius: pillH / 2 + 'px',
        opacity: 1,
        transform: 'none',
        offset: H > pillH ? 0.72 : 1,
        easing: SPRING
      },
      ...(H > pillH ? [{ width: W + 'px', height: H + 'px', borderRadius: '28px', opacity: 1, transform: 'none' }] : [])
    ],
    { duration: 560 }
  );
  setTimeout(() => input.focus(), 60);
}

function closeAnim() {
  const a = card.animate(
    [
      { opacity: 1, transform: 'none' },
      { opacity: 0, transform: 'translateY(12px) scale(.92)' }
    ],
    { duration: 200, easing: 'cubic-bezier(.4,0,1,1)', fill: 'forwards' }
  );
  a.onfinish = () => {
    card.classList.add('hidden');
    a.cancel();
  };
}

// Jedes Öffnen startet einen neuen Chat (außer Gemini Live läuft gerade).
function resetChat() {
  if (streaming) window.api.abortChat(streaming.id);
  // Deleting the (unsaved) incognito chat makes the agent forget its session (chat.forget, AURA-106).
  if (incognito && chatHistory.length) window.api.deleteChat(chatId).catch(() => {});
  chatHistory = [];
  streaming = null;
  chatId = newChatId();
  messages.innerHTML = '';
  input.value = '';
  showView('chat');
  autosize();
  setBusy(false);
}

window.api.onPanelOpen(({ startLive, corner }) => {
  if (!live && !streaming) resetChat(); // laufender Auftrag bleibt sichtbar
  window.api.getUsage().then(showUsage);
  document.body.classList.toggle('corner-left', /left/.test(corner || ''));
  document.body.classList.toggle('corner-top', /top/.test(corner || ''));
  window.api.ignoreMouse(!card.matches(':hover'));
  openAnim();
  if (startLive) startLiveMode();
});
window.api.onPanelClose(() => {
  if (dictation) finishDictation('keep'); // Panel zu: Text nicht verlieren, aber auch nicht ungefragt senden
  closeAnim();
});

// Klicks auf die transparenten Bereiche des Fensters gehen an die App dahinter.
card.addEventListener('mouseenter', () => window.api.ignoreMouse(false));
card.addEventListener('mouseleave', () => window.api.ignoreMouse(true));
// Unter Linux kommen Klicks neben die Karte im (durchsichtigen) Fenster an: wie ein Klick daneben schließen.
document.addEventListener('mousedown', (e) => {
  if (!card.contains(e.target) && !live && !streaming && !dictation) window.api.hidePanel();
});

document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && dictation) {
    e.preventDefault();
    finishDictation('cancel');
    return;
  }
  if (e.key === 'Escape') {
    e.preventDefault();
    if (!$('historyView').classList.contains('hidden')) showView('chat');
    else window.api.hidePanel();
  }
});

$('closeBtn').onclick = () => window.api.hidePanel();
$('openSettings').onclick = () => window.api.openSettings();
$('openZentrale').onclick = () => window.api.openZentrale();
$('newChat').onclick = () => {
  resetChat();
  setCompact();
  input.focus();
};

// ---------- Markdown (klein, sicher) ----------

function esc(s) {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
}

function inline(s) {
  return esc(s)
    .replace(/`([^`]+)`/g, '<code>$1</code>')
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/(^|[^*])\*([^*\s][^*]*)\*/g, '$1<em>$2</em>')
    .replace(/\[([^\]]+)\]\((https:\/\/[^)\s]+)\)/g, '<a href="$2">$1</a>');
}

function markdown(src) {
  const out = [];
  const blocks = src.split(/```/);
  blocks.forEach((block, i) => {
    if (i % 2 === 1) {
      out.push('<pre><code>' + esc(block.replace(/^[^\n]*\n/, '')) + '</code></pre>');
      return;
    }
    let list = null;
    let para = [];
    const flush = () => {
      if (para.length) out.push('<p>' + para.map(inline).join('<br>') + '</p>');
      para = [];
    };
    const closeList = () => {
      if (list) {
        out.push(`</${list}>`);
        list = null;
      }
    };
    for (const line of block.split('\n')) {
      const ul = line.match(/^\s*[-*•]\s+(.*)/);
      const ol = line.match(/^\s*\d+[.)]\s+(.*)/);
      const h = line.match(/^#{1,4}\s+(.*)/);
      if (ul || ol) {
        flush();
        const t = ul ? 'ul' : 'ol';
        if (list !== t) {
          closeList();
          out.push(`<${t}>`);
          list = t;
        }
        out.push('<li>' + inline((ul || ol)[1]) + '</li>');
      } else if (h) {
        flush();
        closeList();
        out.push('<p><strong>' + inline(h[1]) + '</strong></p>');
      } else if (!line.trim()) {
        flush();
        closeList();
      } else {
        closeList();
        para.push(line);
      }
    }
    flush();
    closeList();
  });
  return out.join('');
}

messages.addEventListener('click', (e) => {
  const a = e.target.closest('a');
  if (a) {
    e.preventDefault();
    window.api.openExternal(a.href);
  }
});

// ---------- Chat ----------

function addUser(text) {
  const el = document.createElement('div');
  el.className = 'msg user';
  el.textContent = text;
  messages.appendChild(el);
  return el;
}

function addModel() {
  const el = document.createElement('div');
  el.className = 'msg model thinking';
  el.innerHTML =
    '<svg class="spark" viewBox="0 0 24 24"><use href="#spark"/></svg><div class="content"><div class="steps"></div><div class="body"></div></div>';
  messages.appendChild(el);
  return el;
}

// Nur mitscrollen, wenn man unten ist; wer hochgescrollt hat, wird nicht nach unten gerissen.
let stickToBottom = true;
messages.addEventListener('scroll', () => {
  stickToBottom = messages.scrollHeight - messages.scrollTop - messages.clientHeight < 40;
});
function scrollDown(force) {
  if (force || stickToBottom) {
    messages.scrollTop = messages.scrollHeight;
    stickToBottom = true;
  }
}

function setBusy(on) {
  window.api.setBusy(on);
  card.classList.toggle('busy', on);
  sendBtn.classList.toggle('stop', on);
  sendBtn.disabled = !on && !input.value.trim();
  sendBtn.title = on ? 'Stoppen' : 'Senden';
  sendBtn.innerHTML = on
    ? '<svg viewBox="0 0 24 24"><rect x="7" y="7" width="10" height="10" rx="2"/></svg>'
    : '<svg viewBox="0 0 24 24"><path d="M5 12h14M13 6l6 6-6 6"/></svg>';
}

function send() {
  if (streaming) {
    window.api.abortChat(streaming.id);
    return;
  }
  const text = input.value.trim();
  if (!text) return;
  input.value = '';
  autosize();
  const userEl = addUser(text);
  chatHistory.push({ role: 'user', parts: [{ text }] });
  const id = Date.now() + '-' + Math.random().toString(36).slice(2);
  streaming = { id, el: addModel(), text: '', userEl, userIndex: chatHistory.length - 1 };
  setCompact();
  setBusy(true);
  scrollDown(true);
  window.api.sendChat({ id, chatId, history: chatHistory, includeScreen, incognito });
}

window.api.onChatScreen(({ id, jpeg }) => {
  if (!streaming || streaming.id !== id) return;
  chatHistory[streaming.userIndex].parts.unshift({ inlineData: { mimeType: 'image/jpeg', data: jpeg } });
  const img = document.createElement('img');
  img.src = 'data:image/jpeg;base64,' + jpeg;
  streaming.userEl.prepend(img);
});

window.api.onChatChunk(({ id, text }) => {
  if (!streaming || streaming.id !== id) return;
  streaming.text += text;
  streaming.el.classList.remove('thinking');
  streaming.el.querySelector('.body').innerHTML = markdown(streaming.text);
  scrollDown();
});

window.api.onChatDone(({ id }) => {
  if (!streaming || streaming.id !== id) return;
  if (streaming.text) chatHistory.push({ role: 'model', parts: [{ text: streaming.text }] });
  else if (!streaming.el.querySelector('.step')) streaming.el.remove();
  else streaming.el.classList.remove('thinking');
  streaming.el.querySelectorAll('.step .approve').forEach((a) => a.remove());
  streaming = null;
  setBusy(false);
  if (!incognito) window.api.saveChat({ id: chatId, history: chatHistory }).catch(() => {});
});

window.api.onChatError(({ id, message }) => {
  if (!streaming || streaming.id !== id) return;
  streaming.el.classList.remove('thinking');
  streaming.el.classList.add('error');
  streaming.el.querySelector('.body').textContent = 'Fehler: ' + message;
  chatHistory.pop(); // fehlgeschlagene Frage nicht im Verlauf behalten
  streaming = null;
  setBusy(false);
});

// ---------- Frühere Chats ----------

function showView(name) {
  $('chatView').classList.toggle('hidden', name !== 'chat');
  $('historyView').classList.toggle('hidden', name !== 'history');
  card.classList.toggle('history', name === 'history');
  if (name === 'history') card.classList.remove('compact');
  else setCompact();
  if (name === 'chat') setTimeout(() => input.focus(), 30);
}

function dayLabel(ts) {
  const d = new Date(ts);
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const diff = Math.round((today - new Date(d.getFullYear(), d.getMonth(), d.getDate())) / 86400000);
  if (diff <= 0) return 'Heute';
  if (diff === 1) return 'Gestern';
  if (diff < 7) return d.toLocaleDateString('de-DE', { weekday: 'long' });
  return d.toLocaleDateString('de-DE', { day: 'numeric', month: 'long', year: diff > 300 ? 'numeric' : undefined });
}

async function showHistory() {
  showView('history');
  const list = $('historyList');
  list.innerHTML = '';
  const all = await window.api.listChats();
  if (!all.length) {
    list.innerHTML = '<div class="hist-empty">Noch keine gespeicherten Chats.</div>';
    return;
  }
  let lastDay = '';
  for (const c of all) {
    const day = dayLabel(c.updated);
    if (day !== lastDay) {
      const h = document.createElement('div');
      h.className = 'hist-day';
      h.textContent = day;
      list.appendChild(h);
      lastDay = day;
    }
    const el = document.createElement('div');
    el.className = 'hist-item' + (c.id === chatId ? ' current' : '');
    el.innerHTML =
      '<div><div class="t"></div><div class="p"></div></div><button class="icon del" title="Löschen"><svg viewBox="0 0 24 24"><path d="M5 7h14M10 11v6M14 11v6M6 7l1 12h10l1-12M9 7V4h6v3"/></svg></button>';
    el.querySelector('.t').textContent = c.title;
    el.querySelector('.p').textContent =
      new Date(c.updated).toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit' }) +
      (c.preview ? ' · ' + c.preview : '');
    el.onclick = () => loadChat(c.id);
    el.querySelector('.del').onclick = async (e) => {
      e.stopPropagation();
      await window.api.deleteChat(c.id);
      if (c.id === chatId) chatId = newChatId(); // offener Chat wird beim nächsten Senden neu gespeichert
      showHistory();
    };
    list.appendChild(el);
  }
}

async function loadChat(id) {
  const c = await window.api.getChat(id);
  if (!c) return showHistory();
  if (streaming) window.api.abortChat(streaming.id);
  streaming = null;
  setBusy(false);
  chatId = c.id;
  chatHistory = c.history;
  messages.innerHTML = '';
  for (const m of chatHistory) {
    const text = m.parts
      .map((p) => p.text)
      .filter(Boolean)
      .join('\n');
    if (m.role === 'user') addUser(text);
    else {
      const el = addModel();
      el.classList.remove('thinking');
      el.querySelector('.body').innerHTML = markdown(text);
    }
  }
  showView('chat');
  scrollDown(true);
}

$('historyBtn').onclick = showHistory;
$('historyBack').onclick = () => showView('chat');
$('historyClose').onclick = () => window.api.hidePanel();

// ---------- Agent: Schritte und Freigaben ----------

const TOOL_NAMES = {
  run_command: 'Befehl',
  find_files: 'Suche',
  list_folder: 'Ordner',
  read_file: 'Lesen',
  write_file: 'Schreiben',
  open: 'Öffnen',
  screenshot: 'Bildschirmfoto',
  activate_skill: 'Skill',
  click: 'Klick',
  type_text: 'Tippen',
  press_keys: 'Tasten',
  // Agent v2
  launch_app: 'Programm',
  open_target: 'Öffnen',
  list_windows: 'Fenster',
  window_action: 'Fenster',
  media_status: 'Medien',
  media_control: 'Medien',
  volume: 'Lautstärke',
  settings: 'Einstellung',
  system_info: 'System',
  list_dir: 'Ordner',
  edit_file: 'Ändern',
  move_path: 'Verschieben',
  trash: 'Papierkorb',
  todo_write: 'Plan',
  ask_user: 'Frage'
};
// Frage auf der Freigabekarte je Werkzeug (Agent v1 und v2).
const APPROVE_Q = {
  write_file: 'Aura möchte diese Datei schreiben:',
  edit_file: 'Aura möchte diese Datei ändern:',
  trash: 'Aura möchte das in den Papierkorb verschieben:',
  browser_click: 'Aura möchte auf der Webseite klicken:',
  browser_type: 'Aura möchte auf der Webseite eingeben:',
  browser_fill_form: 'Aura möchte dieses Formular ausfüllen:',
  browser_press_key: 'Aura möchte auf der Webseite eine Taste drücken:',
  browser_handle_dialog: 'Aura möchte einen Dialog der Webseite bestätigen:',
  move_path: 'Aura möchte das verschieben oder kopieren:',
  open: 'Aura möchte dieses Programm starten:',
  open_target: 'Aura möchte das öffnen:',
  launch_app: 'Aura möchte dieses Programm starten:',
  window_action: 'Aura möchte dieses Fenster schließen:',
  settings: 'Aura möchte diese Einstellung ändern:',
  click: 'Aura möchte klicken:',
  type_text: 'Aura möchte tippen:',
  press_keys: 'Aura möchte Tasten drücken:'
};
const BROWSER_NAMES = {
  navigate: 'Seite öffnen',
  navigate_back: 'Zurück',
  snapshot: 'Seite lesen',
  find: 'Suchen',
  click: 'Klicken',
  type: 'Tippen',
  fill_form: 'Formular',
  select_option: 'Auswählen',
  press_key: 'Taste',
  wait_for: 'Warten',
  tabs: 'Tabs',
  handle_dialog: 'Dialog',
  take_screenshot: 'Bildschirmfoto'
};
const toolName = (t) =>
  TOOL_NAMES[t] ||
  (t === 'browser'
    ? 'Browser-Agent'
    : t.startsWith('browser_')
      ? 'Browser · ' + (BROWSER_NAMES[t.slice(8)] || t.slice(8))
      : t.startsWith('mcp_')
        ? 'MCP'
        : t);
const STEP_STATE = {
  ask: 'Wartet auf deine Freigabe',
  run: 'Läuft …',
  ok: 'Erledigt',
  error: 'Fehlgeschlagen',
  denied: 'Abgelehnt'
};

function stepEl(step) {
  let el = streaming.el.querySelector(`.step[data-id="${step.id}"]`);
  if (!el) {
    el = document.createElement('div');
    el.className = 'step';
    el.dataset.id = step.id;
    el.innerHTML = '<div class="line"><i></i><b></b><span></span></div>';
    el.querySelector('b').textContent = toolName(step.tool);
    el.querySelector('span').textContent = step.label;
    el.querySelector('span').title = step.label;
    streaming.el.querySelector('.steps').appendChild(el);
  }
  return el;
}

window.api.onAgentStep((step) => {
  if (!streaming || streaming.id !== step.chatId) return;
  streaming.el.classList.remove('thinking');
  const el = stepEl(step);
  el.className = 'step ' + step.state;
  el.querySelector('i').title = STEP_STATE[step.state] || '';
  if (step.state !== 'ask') {
    const a = el.querySelector('.approve');
    if (a) a.remove();
  }
  scrollDown();
});

window.api.onAgentApprove((step) => {
  if (!streaming || streaming.id !== step.chatId) {
    window.api.agentApproval(step.id, false);
    return;
  }
  streaming.el.classList.remove('thinking');
  const el = stepEl(step);
  el.className = 'step ask';
  const box = document.createElement('div');
  box.className = 'approve';
  box.innerHTML =
    '<div class="q"></div><pre></pre><div class="btns"><button class="deny">Ablehnen</button><button class="all" title="Alle weiteren Schritte dieses Auftrags ohne Rückfrage">Alle erlauben</button><button class="allow">Ausführen</button></div>';
  box.querySelector('.q').textContent =
    APPROVE_Q[step.tool] ||
    (step.tool.startsWith('mcp_') ? 'Aura möchte dieses Werkzeug nutzen:' : 'Aura möchte diesen Befehl ausführen:');
  box.querySelector('pre').textContent = step.label + (step.detail ? '\n\n' + step.detail : '');
  if (step.reason) {
    const why = document.createElement('div');
    why.className = 'why';
    why.textContent = 'Warum Aura fragt: ' + step.reason;
    box.insertBefore(why, box.querySelector('.btns'));
  }
  const answer = (ok) => {
    box.remove();
    window.api.agentApproval(step.id, ok);
  };
  if (step.tier !== undefined) {
    // Agent v2: dauerhaft erlauben legt eine Regel in ~/.aura/policy.toml an.
    const always = document.createElement('button');
    always.className = 'always';
    always.textContent = 'Immer erlauben';
    always.title = 'Genau diese Aktion künftig ohne Rückfrage (Regel in ~/.aura/policy.toml)';
    always.onclick = () => answer('always');
    box.querySelector('.btns').insertBefore(always, box.querySelector('.allow'));
    box.querySelector('.all').textContent = 'Für diesen Auftrag';
    box.querySelector('.allow').textContent = 'Nur jetzt';
  }
  box.querySelector('.allow').onclick = () => answer(true);
  box.querySelector('.deny').onclick = () => answer(false);
  box.querySelector('.all').onclick = () => answer('all');
  el.appendChild(box);
  scrollDown();
  box.querySelector('.allow').focus({ preventScroll: true });
});

// ---------- Agent v2: Aufgabenliste, Rückfragen, Nachprüfung ----------

const PLAN_MARK = { done: '✓', in_progress: '›', cancelled: '–', pending: '' };
window.api.onAgentPlan(({ chatId: cid, items }) => {
  if (!streaming || streaming.id !== cid) return;
  streaming.el.classList.remove('thinking');
  let plan = streaming.el.querySelector('.plan');
  if (!plan) {
    plan = document.createElement('ol');
    plan.className = 'plan';
    streaming.el.querySelector('.content').insertBefore(plan, streaming.el.querySelector('.steps'));
  }
  plan.innerHTML = '';
  for (const it of items) {
    const li = document.createElement('li');
    li.className = it.status;
    const mark = document.createElement('i');
    mark.textContent = PLAN_MARK[it.status] || '';
    const txt = document.createElement('span');
    txt.textContent = it.text;
    li.append(mark, txt);
    plan.appendChild(li);
  }
  scrollDown();
});

window.api.onAgentAsk(({ chatId: cid, id, question, options }) => {
  if (!streaming || streaming.id !== cid) {
    window.api.agentAnswer(id, '');
    return;
  }
  streaming.el.classList.remove('thinking');
  const box = document.createElement('div');
  box.className = 'ask';
  box.innerHTML =
    '<div class="q"></div><div class="opts"></div><form class="free"><input type="text" placeholder="Eigene Antwort …"><button type="submit">Senden</button></form>';
  box.querySelector('.q').textContent = question;
  const answer = (text) => {
    box.classList.add('answered');
    box.querySelector('.opts').remove();
    box.querySelector('.free').remove();
    const a = document.createElement('div');
    a.className = 'a';
    a.textContent = text || '(keine Antwort)';
    box.appendChild(a);
    window.api.agentAnswer(id, text);
  };
  for (const o of options || []) {
    const b = document.createElement('button');
    b.type = 'button';
    b.textContent = o;
    b.onclick = () => answer(o);
    box.querySelector('.opts').appendChild(b);
  }
  const form = box.querySelector('.free');
  form.onsubmit = (ev) => {
    ev.preventDefault();
    const v = form.querySelector('input').value.trim();
    if (v) answer(v);
  };
  streaming.el.querySelector('.steps').appendChild(box);
  scrollDown();
  (box.querySelector('.opts button') || form.querySelector('input')).focus({ preventScroll: true });
});

// Connect card (AURA-96): Aura suggests a connection to a service; nothing is installed without "Verbinden".
window.api.onAgentConnector((c) => {
  if (!streaming || streaming.id !== c.chatId) {
    window.api.agentConnectorAnswer(c.id, 'later');
    return;
  }
  streaming.el.classList.remove('thinking');
  const box = document.createElement('div');
  box.className = 'ask connector';
  box.innerHTML = `<div class="ctop"><b class="ctitle"></b><span class="cbadge"></span></div>
    <div class="cwhy"></div><div class="cdesc"></div><div class="cneeds"></div><div class="crisk"></div>
    <div class="opts"><button type="button" class="primary" data-d="connect">Verbinden</button>
    <button type="button" data-d="later">Später</button><button type="button" data-d="never">Nicht mehr vorschlagen</button></div>`;
  box.querySelector('.ctitle').textContent = c.title;
  const badge = box.querySelector('.cbadge');
  badge.textContent = c.verified === 'aura' ? 'Von Aura geprüft' : 'Nicht geprüft';
  badge.classList.add(c.verified === 'aura' ? 'ok' : 'warn');
  box.querySelector('.cwhy').textContent = c.reason;
  box.querySelector('.cdesc').textContent = [c.description, c.publisher && `Anbieter: ${c.publisher}`]
    .filter(Boolean)
    .join(' · ');
  box.querySelector('.cneeds').textContent = c.needs.length ? 'Du brauchst: ' + c.needs.join(', ') : '';
  box.querySelector('.crisk').textContent = c.risk;
  const labels = {
    connect: 'Verbinden: die Aura Zentrale ist offen.',
    later: 'Später.',
    never: 'Nicht mehr vorschlagen.'
  };
  box.querySelectorAll('[data-d]').forEach((b) => {
    b.onclick = () => {
      box.classList.add('answered');
      box.querySelector('.opts').remove();
      const a = document.createElement('div');
      a.className = 'a';
      a.textContent = labels[b.dataset.d];
      box.appendChild(a);
      window.api.agentConnectorAnswer(c.id, b.dataset.d);
    };
  });
  streaming.el.querySelector('.steps').appendChild(box);
  scrollDown();
  box.querySelector('[data-d="connect"]').focus({ preventScroll: true });
});

window.api.onAgentVerified(({ chatId: cid, verified }) => {
  if (!streaming || streaming.id !== cid) return;
  const badge = document.createElement('div');
  badge.className = 'verified ' + (verified ? 'yes' : 'no');
  badge.textContent = verified ? '✓ Ergebnis überprüft' : '! Nicht alles hat geklappt – Aura hat es nachgeprüft';
  streaming.el.querySelector('.content').appendChild(badge);
});

function autosize() {
  // Compact pill: the text shares the row with the buttons. As soon as it needs a second line, the buttons move
  // below the text so it gets the full width (instead of wrapping after a few characters); back once it is empty.
  if (!input.value) card.classList.remove('typing');
  else if (card.classList.contains('compact') && !card.classList.contains('typing')) {
    input.style.height = 'auto';
    if (input.scrollHeight > input.clientHeight + 2 || input.value.includes('\n')) card.classList.add('typing');
  }
  input.style.height = 'auto';
  input.style.height = Math.min(140, input.scrollHeight) + 'px';
  input.style.overflowY = input.scrollHeight > 140 ? 'auto' : 'hidden';
  if (!streaming) sendBtn.disabled = !input.value.trim();
}
input.addEventListener('input', autosize);
input.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault();
    send();
  }
});
$('composer').addEventListener('submit', (e) => {
  e.preventDefault();
  send();
});

// ---------- Spracheingabe (Mikrofon-Knopf) ----------
// Wie bei Gemini oder ChatGPT: drücken, so lange sprechen wie man will (Pausen sind egal), nochmal drücken:
// Aura erkennt den Text (lokal mit Whisper, sonst mit einem günstigen Gemini-Modell) und schickt ihn ab.
// Esc bricht ab. Wird das Panel währenddessen geschlossen, landet der Text nur im Eingabefeld.
const micBtn = $('micBtn');
const recInfo = $('recInfo');
const MIC_MAX_MS = 15 * 60 * 1000;
const MIC_SVG = micBtn.innerHTML;
const STOP_SVG = '<svg viewBox="0 0 24 24"><path d="M5 12l5 5L20 7"/></svg>';
const WAIT_SVG = '<svg viewBox="0 0 24 24"><path d="M12 3a9 9 0 1 0 9 9"/></svg>';
let dictation = null; // { chunks, start, ready, timer, stopping }
let noteTimer = null;

const clock = (ms) => {
  const s = Math.floor(ms / 1000);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
};

function micState(state) {
  $('composer').classList.toggle('dictating', state !== 'idle');
  micBtn.classList.toggle('rec', state === 'rec');
  micBtn.classList.toggle('wait', state === 'wait');
  micBtn.innerHTML = state === 'rec' ? STOP_SVG : state === 'wait' ? WAIT_SVG : MIC_SVG;
  micBtn.title =
    state === 'rec'
      ? 'Fertig: Text erkennen und senden (Esc bricht ab)'
      : state === 'wait'
        ? 'Sprache wird erkannt …'
        : 'Spracheingabe: sprechen, dann nochmal drücken zum Senden';
  micBtn.style.setProperty('--lvl', 0);
  recInfo.className = 'rec-info' + (state === 'rec' ? ' rec' : '') + (state === 'idle' ? ' hidden' : '');
  if (state === 'wait') recInfo.textContent = 'Wird erkannt …';
}

function micNote(text) {
  clearTimeout(noteTimer);
  recInfo.className = 'rec-info err';
  recInfo.textContent = text;
  noteTimer = setTimeout(() => {
    if (!dictation) recInfo.className = 'rec-info hidden';
  }, 6000);
}

function startDictation() {
  if (dictation || live) return;
  clearTimeout(noteTimer);
  const d = { chunks: [], start: Date.now(), stopping: false };
  d.ready = Audio16.openMic((samples, rms) => {
    if (dictation !== d) return;
    d.chunks.push(samples);
    micBtn.style.setProperty('--lvl', Math.min(1, rms * 12).toFixed(2));
  });
  dictation = d;
  window.api.setBusy(true); // Panel bleibt offen, auch wenn der Fokus woanders hin wandert
  micState('rec');
  recInfo.textContent = '● 0:00';
  d.timer = setInterval(() => {
    const ms = Date.now() - d.start;
    recInfo.textContent = '● ' + clock(ms);
    if (ms >= MIC_MAX_MS) finishDictation('send');
  }, 250);
  d.ready.catch((err) => {
    if (dictation !== d) return;
    clearInterval(d.timer);
    dictation = null;
    window.api.setBusy(!!streaming);
    micState('idle');
    micNote('Kein Mikrofon: ' + (err && err.message ? err.message : err));
  });
}

// mode: 'send' (Knopf), 'keep' (Panel geschlossen: nur ins Eingabefeld), 'cancel' (Esc)
async function finishDictation(mode) {
  const d = dictation;
  if (!d || d.stopping) return;
  d.stopping = true;
  clearInterval(d.timer);
  const mic = await d.ready.catch(() => null);
  if (mic) mic.close();
  dictation = null;
  const seconds = d.chunks.reduce((n, c) => n + c.length, 0) / 16000;
  if (mode === 'cancel' || seconds < 0.4) {
    window.api.setBusy(!!streaming);
    micState('idle');
    if (mode !== 'cancel') micNote('Nichts aufgenommen.');
    return;
  }
  micState('wait');
  const r = await window.api.transcribe(Audio16.wavBase64(d.chunks));
  window.api.setBusy(!!streaming);
  micState('idle');
  const text = ((r && r.text) || '').trim();
  if (r && r.error) return micNote(r.error);
  if (!text) return micNote('Nichts verstanden, bitte noch einmal.');
  input.value = input.value.trim() ? input.value.trim() + ' ' + text : text;
  autosize();
  // Läuft noch eine Antwort, würde send() sie abbrechen: dann bleibt der Text im Feld.
  if (mode === 'send' && !streaming) send();
  else input.focus();
}

micBtn.onclick = () => (dictation ? finishDictation('send') : startDictation());
window.api.onSttProgress((p) => {
  if (micBtn.classList.contains('wait') && p.total)
    recInfo.textContent = `Lade Spracherkennung … ${Math.round((p.loaded / p.total) * 100)} %`;
});

$('incognitoBtn').onclick = () => {
  // A chat is either incognito or not: switching starts a new chat.
  if (chatHistory.length) resetChat();
  incognito = !incognito;
  $('incognitoBtn').classList.toggle('on', incognito);
  document.body.classList.toggle('incognito', incognito);
};

$('screenToggle').onclick = () => {
  includeScreen = !includeScreen;
  $('screenToggle').classList.toggle('on', includeScreen);
  window.api.saveSettings({ includeScreenInChat: includeScreen });
};

window.api.getSettings().then((s) => {
  includeScreen = !!s.includeScreenInChat;
  $('appVer').textContent = s.version ? 'v' + s.version : '';
  $('screenToggle').classList.toggle('on', includeScreen);
});

// ---------- Live ----------

const liveTranscript = $('liveTranscript');
let turnEls = { you: null, gem: null };

const liveUi = {
  status: (t) => {
    $('liveStatus').textContent = t;
  },
  transcript: (role, text) => {
    if (role === 'turn') {
      turnEls = { you: null, gem: null };
      return;
    }
    if (!turnEls[role]) {
      if (role === 'you') turnEls.gem = null;
      const p = document.createElement('div');
      p.className = role;
      liveTranscript.appendChild(p);
      turnEls[role] = p;
      while (liveTranscript.children.length > 6) liveTranscript.firstChild.remove();
    }
    turnEls[role].textContent += text;
    liveTranscript.scrollTop = liveTranscript.scrollHeight;
  },
  level: (v) => {
    $('orb').style.setProperty('--s', (1 + v * 0.45).toFixed(3));
  },
  ended: (err) => {
    live = null;
    window.api.setLiveActive(false);
    $('liveView').classList.add('hidden');
    $('chatView').classList.remove('hidden');
    card.classList.remove('live');
    if (err) {
      const el = addModel();
      el.classList.remove('thinking');
      el.classList.add('error');
      el.querySelector('.body').textContent = 'Live: ' + err;
    }
    setCompact();
    input.focus();
  }
};

async function startLiveMode() {
  if (live) return;
  if (dictation) await finishDictation('keep'); // Mikrofon freigeben, Diktiertes bleibt im Eingabefeld
  $('chatView').classList.add('hidden');
  $('historyView').classList.add('hidden');
  $('liveView').classList.remove('hidden');
  card.classList.add('live');
  card.classList.remove('compact');
  liveTranscript.innerHTML = '';
  turnEls = { you: null, gem: null };
  $('liveMute').classList.remove('muted');
  $('liveScreen').classList.add('on');
  const cfg = await window.api.liveConfig();
  live = cfg.provider === 'ollama' ? new LocalLiveSession(liveUi) : new LiveSession(liveUi);
  window.api.setLiveActive(true);
  try {
    await live.start({ screen: true });
    $('liveScreen').classList.toggle('on', live.screenOn);
  } catch (err) {
    const l = live;
    if (l) l.stop(String(err.message || err));
    else liveUi.ended(String(err.message || err));
  }
}

function stopLiveMode(reason) {
  if (live) live.stop(typeof reason === 'string' ? reason : undefined);
}

$('liveBtn').onclick = startLiveMode;
$('liveEnd').onclick = stopLiveMode;
$('liveMute').onclick = () => {
  if (live) $('liveMute').classList.toggle('muted', live.toggleMute());
};
$('liveScreen').onclick = async () => {
  if (live) $('liveScreen').classList.toggle('on', await live.toggleScreen());
};
window.api.onLiveStart(() => startLiveMode());
window.api.onLiveStop((reason) => stopLiveMode(reason));

// ---------- Kosten im laufenden Monat ----------

const costEl = $('cost');
function showUsage(u) {
  if (!u) return;
  costEl.classList.toggle('local', !!u.local);
  if (u.local) {
    costEl.querySelector('span').textContent = 'lokal · 0 $';
    costEl.querySelector('i').style.width = '0%';
    costEl.classList.remove('warn', 'over');
    costEl.title = 'Läuft lokal über Ollama, ohne Kosten. Klick = Einstellungen';
    return;
  }
  const fmt = (v) => v.toLocaleString('de-DE', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  costEl.querySelector('span').textContent =
    u.budgetUsd > 0 ? `≈ ${fmt(u.costUsd)} $ / ${fmt(u.budgetUsd)} $` : `≈ ${fmt(u.costUsd)} $`;
  costEl.querySelector('i').style.width = Math.min(100, u.ratio * 100).toFixed(1) + '%';
  costEl.classList.toggle('warn', u.ratio >= 0.8 && !u.overBudget);
  costEl.classList.toggle('over', u.overBudget);
  costEl.title = `Geschätzte Gemini-Kosten im ${u.month} (${u.requests} Anfragen). Genaue Zahlen: AI Studio → Spend. Klick = Einstellungen`;
}
window.api.onUsage(showUsage);
costEl.onclick = () => window.api.openSettings();
