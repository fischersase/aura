const $ = (id) => document.getElementById(id);
let info = null;

function fmtMb(bytes) {
  return bytes ? `${(bytes / 1e6).toFixed(1)} MB` : '';
}

window.api.onProgress((p) => {
  $('progressWrap').classList.remove('hidden');
  $('barFill').style.width = `${Math.max(0, Math.min(100, Number(p.percent) || 0))}%`;
  const st = $('status');
  st.className = 'status';
  if (p.stage === 'verify') {
    st.textContent = 'Prüfe SHA-256 Signatur …';
  } else if (p.total > 0) {
    st.textContent = `Lade herunter … ${fmtMb(p.received)} von ${fmtMb(p.total)} (${p.percent} %)`;
  } else {
    st.textContent = `Lade herunter … ${fmtMb(p.received)}`;
  }
});

$('laterBtn').onclick = () => window.api.remindLater();
$('skipBtn').onclick = () => {
  if (info && info.latestVersion) window.api.skipVersion(info.latestVersion);
  else window.api.remindLater();
};

$('installBtn').onclick = async () => {
  if (!info) return;
  if (info.platform !== 'win32' || !info.downloadUrl) {
    window.api.openRelease();
    return;
  }
  $('installBtn').disabled = true;
  $('laterBtn').disabled = true;
  $('skipBtn').disabled = true;
  $('progressWrap').classList.remove('hidden');
  $('status').className = 'status';
  $('status').textContent = 'Starte Download von GitHub Releases …';
  const res = await window.api.installUpdate();
  if (!res || !res.ok) {
    $('status').className = 'status bad';
    $('status').textContent = (res && res.error) || 'Download fehlgeschlagen.';
    $('installBtn').disabled = false;
    $('laterBtn').disabled = false;
    $('skipBtn').disabled = false;
    return;
  }
  $('status').className = 'status ok';
  $('status').textContent = 'Installer gestartet – Aura wird für das Update beendet …';
};

window.api.getUpdateInfo().then((data) => {
  info = data;
  if (!info) return;
  $('verLine').innerHTML = `Installiert: v${info.currentVersion} → Neu: <strong>v${info.latestVersion}</strong>${
    info.sizeBytes ? ` · ${fmtMb(info.sizeBytes)}` : ''
  }`;
  $('notes').textContent = info.notes || `Aura v${info.latestVersion} steht auf GitHub Releases zum Download bereit.`;
  if (info.platform !== 'win32') {
    $('installBtn').textContent = 'Release auf GitHub öffnen';
  } else if (info.downloadUrl) {
    $('installBtn').textContent = 'Herunterladen & installieren';
  }
});
