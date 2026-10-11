// Kleines Gemini-Fenster: Öffnen/Schließen-Animation, Text-Chat und Live-Ansicht.
const $ = (id) => document.getElementById(id);
const card = $('card');
const messages = $('messages');
const input = $('input');
const sendBtn = $('sendBtn');
const SPRING = 'cubic-bezier(.34, 1.56, .64, 1)';

let history = [];
let streaming = null; // { id, el, text }
let includeScreen = false;
let live = null;

// ---------- Öffnen / Schließen (Kreis → Pille → Fenster) ----------

function setCompact() {
  card.classList.toggle('compact', history.length === 0 && !live && !streaming);
}

function openAnim() {
  card.getAnimations().forEach((a) => a.cancel());
  card.classList.remove('hidden');
  setCompact();
  const W = card.offsetWidth;
  const H = card.offsetHeight;
  const pillH = Math.min(H, 64);
  card.animate([
    { width: '56px', height: '56px', borderRadius: '28px', opacity: 0, transform: 'translateY(20px) scale(.5)', easing: 'cubic-bezier(.2,.8,.2,1)' },
    { width: '56px', height: '56px', borderRadius: '28px', opacity: 1, transform: 'none', offset: 0.32, easing: SPRING },
    { width: W + 'px', height: pillH + 'px', borderRadius: pillH / 2 + 'px', opacity: 1, transform: 'none', offset: H > pillH ? 0.72 : 1, easing: SPRING },
    ...(H > pillH ? [{ width: W + 'px', height: H + 'px', borderRadius: '28px', opacity: 1, transform: 'none' }] : [])
  ], { duration: 560 });
  setTimeout(() => input.focus(), 60);
}

function closeAnim() {
  const a = card.animate([
    { opacity: 1, transform: 'none' },
    { opacity: 0, transform: 'translateY(12px) scale(.92)' }
  ], { duration: 200, easing: 'cubic-bezier(.4,0,1,1)', fill: 'forwards' });
  a.onfinish = () => { card.classList.add('hidden'); a.cancel(); };
}

// Jedes Öffnen startet einen neuen Chat (außer Gemini Live läuft gerade).
function resetChat() {
  if (streaming) window.api.abortChat(streaming.id);
  history = [];
  streaming = null;
  messages.innerHTML = '';
  input.value = '';
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
window.api.onPanelClose(() => closeAnim());

// Klicks auf die transparenten Bereiche des Fensters gehen an die App dahinter.
card.addEventListener('mouseenter', () => window.api.ignoreMouse(false));
card.addEventListener('mouseleave', () => window.api.ignoreMouse(true));

document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') {
    e.preventDefault();
    window.api.hidePanel();
  }
});

$('closeBtn').onclick = () => window.api.hidePanel();
$('openSettings').onclick = () => window.api.openSettings();
$('newChat').onclick = () => {
  if (streaming) window.api.abortChat(streaming.id);
  history = [];
  streaming = null;
  messages.innerHTML = '';
  setCompact();
  input.focus();
};

// ---------- Markdown (klein, sicher) ----------

function esc(s) {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
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
    const closeList = () => { if (list) { out.push(`</${list}>`); list = null; } };
    for (const line of block.split('\n')) {
      const ul = line.match(/^\s*[-*•]\s+(.*)/);
      const ol = line.match(/^\s*\d+[.)]\s+(.*)/);
      const h = line.match(/^#{1,4}\s+(.*)/);
      if (ul || ol) {
        flush();
        const t = ul ? 'ul' : 'ol';
        if (list !== t) { closeList(); out.push(`<${t}>`); list = t; }
        out.push('<li>' + inline((ul || ol)[1]) + '</li>');
      } else if (h) {
        flush(); closeList();
        out.push('<p><strong>' + inline(h[1]) + '</strong></p>');
      } else if (!line.trim()) {
        flush(); closeList();
      } else {
        closeList();
        para.push(line);
      }
    }
    flush(); closeList();
  });
  return out.join('');
}

messages.addEventListener('click', (e) => {
  const a = e.target.closest('a');
  if (a) { e.preventDefault(); window.api.openExternal(a.href); }
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
  el.innerHTML = '<svg class="spark" viewBox="0 0 24 24"><use href="#spark"/></svg><div class="content"><div class="steps"></div><div class="body"></div></div>';
  messages.appendChild(el);
  return el;
}

function scrollDown() {
  messages.scrollTop = messages.scrollHeight;
}

function setBusy(on) {
  card.classList.toggle('busy', on);
  sendBtn.classList.toggle('stop', on);
  sendBtn.disabled = !on && !input.value.trim();
  sendBtn.title = on ? 'Stoppen' : 'Senden';
  sendBtn.innerHTML = on
    ? '<svg viewBox="0 0 24 24"><rect x="7" y="7" width="10" height="10" rx="2"/></svg>'
    : '<svg viewBox="0 0 24 24"><path d="M5 12h14M13 6l6 6-6 6"/></svg>';
}

function send() {
  if (streaming) { window.api.abortChat(streaming.id); return; }
  const text = input.value.trim();
  if (!text) return;
  input.value = '';
  autosize();
  const userEl = addUser(text);
  history.push({ role: 'user', parts: [{ text }] });
  const id = Date.now() + '-' + Math.random().toString(36).slice(2);
  streaming = { id, el: addModel(), text: '', userEl, userIndex: history.length - 1 };
  setCompact();
  setBusy(true);
  scrollDown();
  window.api.sendChat({ id, history, includeScreen });
}

window.api.onChatScreen(({ id, jpeg }) => {
  if (!streaming || streaming.id !== id) return;
  history[streaming.userIndex].parts.unshift({ inlineData: { mimeType: 'image/jpeg', data: jpeg } });
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
  if (streaming.text) history.push({ role: 'model', parts: [{ text: streaming.text }] });
  else if (!streaming.el.querySelector('.step')) streaming.el.remove();
  else streaming.el.classList.remove('thinking');
  streaming.el.querySelectorAll('.step .approve').forEach((a) => a.remove());
  streaming = null;
  setBusy(false);
});

window.api.onChatError(({ id, message }) => {
  if (!streaming || streaming.id !== id) return;
  streaming.el.classList.remove('thinking');
  streaming.el.classList.add('error');
  streaming.el.querySelector('.body').textContent = 'Fehler: ' + message;
  history.pop(); // fehlgeschlagene Frage nicht im Verlauf behalten
  streaming = null;
  setBusy(false);
});

// ---------- Agent: Schritte und Freigaben ----------

const TOOL_NAMES = {
  run_command: 'Befehl', find_files: 'Suche', list_folder: 'Ordner', read_file: 'Lesen',
  write_file: 'Schreiben', open: 'Öffnen', screenshot: 'Bildschirmfoto', activate_skill: 'Skill'
};
const toolName = (t) => TOOL_NAMES[t] || (t.startsWith('mcp_') ? 'MCP' : t);
const STEP_STATE = { ask: 'Wartet auf deine Freigabe', run: 'Läuft …', ok: 'Erledigt', error: 'Fehlgeschlagen', denied: 'Abgelehnt' };

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
  if (step.state !== 'ask') { const a = el.querySelector('.approve'); if (a) a.remove(); }
  scrollDown();
});

window.api.onAgentApprove((step) => {
  if (!streaming || streaming.id !== step.chatId) { window.api.agentApproval(step.id, false); return; }
  streaming.el.classList.remove('thinking');
  const el = stepEl(step);
  el.className = 'step ask';
  const box = document.createElement('div');
  box.className = 'approve';
  box.innerHTML = '<div class="q"></div><pre></pre><div class="btns"><button class="deny">Ablehnen</button><button class="allow">Ausführen</button></div>';
  box.querySelector('.q').textContent = step.tool === 'write_file' ? 'Aura möchte diese Datei schreiben:' : step.tool === 'open' ? 'Aura möchte dieses Programm starten:'
    : step.tool.startsWith('mcp_') ? 'Aura möchte dieses Werkzeug nutzen:' : 'Aura möchte diesen Befehl ausführen:';
  box.querySelector('pre').textContent = step.label + (step.detail ? '\n\n' + step.detail : '');
  const answer = (ok) => { box.remove(); window.api.agentApproval(step.id, ok); };
  box.querySelector('.allow').onclick = () => answer(true);
  box.querySelector('.deny').onclick = () => answer(false);
  el.appendChild(box);
  scrollDown();
  box.querySelector('.allow').focus({ preventScroll: true });
});

function autosize() {
  input.style.height = 'auto';
  input.style.height = Math.min(140, input.scrollHeight) + 'px';
  input.style.overflowY = input.scrollHeight > 140 ? 'auto' : 'hidden';
  if (!streaming) sendBtn.disabled = !input.value.trim();
}
input.addEventListener('input', autosize);
input.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); }
});
$('composer').addEventListener('submit', (e) => { e.preventDefault(); send(); });

$('screenToggle').onclick = () => {
  includeScreen = !includeScreen;
  $('screenToggle').classList.toggle('on', includeScreen);
  window.api.saveSettings({ includeScreenInChat: includeScreen });
};

window.api.getSettings().then((s) => {
  includeScreen = !!s.includeScreenInChat;
  $('screenToggle').classList.toggle('on', includeScreen);
});

// ---------- Live ----------

const liveTranscript = $('liveTranscript');
let turnEls = { you: null, gem: null };

const liveUi = {
  status: (t) => { $('liveStatus').textContent = t; },
  transcript: (role, text) => {
    if (role === 'turn') { turnEls = { you: null, gem: null }; return; }
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
  level: (v) => { $('orb').style.setProperty('--s', (1 + v * 0.45).toFixed(3)); },
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
  $('chatView').classList.add('hidden');
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
$('liveMute').onclick = () => { if (live) $('liveMute').classList.toggle('muted', live.toggleMute()); };
$('liveScreen').onclick = async () => { if (live) $('liveScreen').classList.toggle('on', await live.toggleScreen()); };
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
  costEl.querySelector('span').textContent = u.budgetUsd > 0 ? `≈ ${fmt(u.costUsd)} $ / ${fmt(u.budgetUsd)} $` : `≈ ${fmt(u.costUsd)} $`;
  costEl.querySelector('i').style.width = Math.min(100, u.ratio * 100).toFixed(1) + '%';
  costEl.classList.toggle('warn', u.ratio >= 0.8 && !u.overBudget);
  costEl.classList.toggle('over', u.overBudget);
  costEl.title = `Geschätzte Gemini-Kosten im ${u.month} (${u.requests} Anfragen). Genaue Zahlen: AI Studio → Spend. Klick = Einstellungen`;
}
window.api.onUsage(showUsage);
costEl.onclick = () => window.api.openSettings();
