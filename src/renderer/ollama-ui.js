// Gemeinsamer Baustein für Einrichtung und Einstellungen: Ollama prüfen, Modell wählen und laden, Whisper wählen.
const WHISPER_MODELS = [
  { id: 'onnx-community/whisper-base', label: 'Whisper Base: klein und schnell' },
  { id: 'onnx-community/whisper-small', label: 'Whisper Small: guter Mittelweg (empfohlen)' },
  { id: 'onnx-community/whisper-large-v3-turbo', label: 'Whisper Large v3 Turbo: am genauesten, groß, braucht starke Grafik' }
];

function OllamaPanel(root, settings) {
  root.innerHTML = `
    <div class="ol-status status"></div>
    <div class="ol-install hint hidden">Ollama ist nicht erreichbar.
      <a href="#" data-url="https://ollama.com/download">Ollama installieren</a>, starten und dann „Erneut prüfen“ klicken.
      <span class="ol-linux hidden">Unter Linux: <code>curl -fsSL https://ollama.com/install.sh | sh</code></span></div>
    <label>Ollama-Adresse</label>
    <div class="row"><input class="ol-url" type="text" spellcheck="false"><button type="button" class="ol-check">Erneut prüfen</button></div>
    <label>Modell für Chat, Rambler und Live</label>
    <div class="row"><select class="ol-model"></select><button type="button" class="ol-pull">Herunterladen</button></div>
    <div class="ol-hint hint"></div>
    <div class="ol-progress hidden"><b><i></i></b><span></span></div>
    <label>Spracherkennung (läuft in der App, lädt beim ersten Diktat)</label>
    <select class="ol-whisper">${WHISPER_MODELS.map((m) => `<option value="${m.id}">${m.label}</option>`).join('')}</select>
    <div class="hint">Live wird lokal zum Wechselgespräch: du sprichst, das Modell sieht ein Bildschirmfoto, antwortet und liest vor.
      Kimi gibt es nur als Cloud-Modell, DeepSeek lokal nur ohne Bilderkennung.</div>`;
  const q = (c) => root.querySelector(c);
  const st = (text, ok) => { const el = q('.ol-status'); el.textContent = text; el.className = 'ol-status status ' + (ok === undefined ? '' : ok ? 'ok' : 'bad'); };
  let installed = [];
  let recommended = [];
  let pulling = false;

  q('.ol-url').value = settings.ollamaUrl || 'http://127.0.0.1:11434';
  q('.ol-whisper').value = settings.whisperModel || WHISPER_MODELS[1].id;
  if (settings.platform === 'linux') q('.ol-linux').classList.remove('hidden');

  function fillModels(selected) {
    const sel = q('.ol-model');
    const names = new Set(installed.map((m) => m.name));
    const opts = [];
    for (const m of installed) {
      const r = recommended.find((x) => x.name === m.name);
      opts.push(`<option value="${m.name}">${m.name} · installiert${r && !r.vision ? ' · nur Text' : ''}</option>`);
    }
    for (const r of recommended) {
      if (!names.has(r.name)) opts.push(`<option value="${r.name}">${r.label} · laden (${r.ram})</option>`);
    }
    sel.innerHTML = opts.join('');
    sel.value = selected && [...sel.options].some((o) => o.value === selected) ? selected : (installed[0] || recommended[0] || {}).name || '';
    updateHint();
  }

  function updateHint() {
    const name = q('.ol-model').value;
    const isInstalled = installed.some((m) => m.name === name);
    const r = recommended.find((x) => x.name === name);
    q('.ol-pull').classList.toggle('hidden', isInstalled);
    q('.ol-hint').textContent = r ? `${r.label}. Empfohlen: ${r.ram}.${r.vision ? '' : ' Versteht keine Bilder, Live und „Bildschirm“ gehen damit nicht.'}` : '';
  }

  async function check() {
    st('Prüfe Ollama …');
    const r = await window.api.ollamaStatus(q('.ol-url').value.trim());
    recommended = r.recommended || [];
    installed = r.ok ? r.models : [];
    q('.ol-install').classList.toggle('hidden', r.ok);
    if (r.ok) st(`Ollama ${r.version} läuft, ${installed.length} Modell(e) installiert.`, true);
    else st(r.message, false);
    fillModels(q('.ol-model').value || settings.ollamaModel);
    return r.ok;
  }

  q('.ol-check').onclick = check;
  q('.ol-model').onchange = updateHint;
  q('.ol-pull').onclick = async () => {
    if (pulling) { window.api.abortPull(); return; }
    const name = q('.ol-model').value;
    pulling = true;
    q('.ol-pull').textContent = 'Abbrechen';
    q('.ol-progress').classList.remove('hidden');
    const off = window.api.onOllamaProgress((p) => {
      const pct = p.total ? (p.completed || 0) / p.total : 0;
      q('.ol-progress i').style.width = (pct * 100).toFixed(1) + '%';
      q('.ol-progress span').textContent = p.total
        ? `${(p.completed / 1e9 || 0).toFixed(1)} von ${(p.total / 1e9).toFixed(1)} GB`
        : p.status || '';
    });
    const r = await window.api.ollamaPull(q('.ol-url').value.trim(), name);
    off();
    pulling = false;
    q('.ol-pull').textContent = 'Herunterladen';
    q('.ol-progress').classList.add('hidden');
    if (!r.ok) st('Laden fehlgeschlagen: ' + r.message, false);
    await check();
    q('.ol-model').value = name;
    updateHint();
  };

  return {
    check,
    isInstalled: () => installed.some((m) => m.name === q('.ol-model').value),
    values: () => ({
      ollamaUrl: q('.ol-url').value.trim() || 'http://127.0.0.1:11434',
      ollamaModel: q('.ol-model').value,
      whisperModel: q('.ol-whisper').value
    })
  };
}

window.OllamaPanel = OllamaPanel;
