// Bildschirmfotos über eine Bildschirmfreigabe statt desktopCapturer-Vorschaubild.
// Nötig unter Wayland: dort liefert desktopCapturer keine brauchbaren Vorschaubilder,
// und jede Aufnahme würde den System-Dialog neu öffnen. Die Freigabe bleibt deshalb
// ein paar Minuten offen und wird für weitere Bilder wiederverwendet.
(() => {
  const IDLE_MS = 3 * 60 * 1000;
  let stream = null;
  let video = null;
  let idleTimer = null;

  function stop() {
    if (stream) stream.getTracks().forEach((t) => t.stop());
    stream = null;
    video = null;
  }

  async function ensure() {
    if (stream && stream.getVideoTracks().some((t) => t.readyState === 'live')) return;
    stop();
    stream = await navigator.mediaDevices.getDisplayMedia({ video: { frameRate: 2 }, audio: false });
    stream.getVideoTracks()[0].addEventListener('ended', stop);
    video = document.createElement('video');
    video.muted = true;
    video.srcObject = stream;
    await video.play();
    // erstes echtes Bild abwarten
    for (let i = 0; i < 40 && !video.videoWidth; i++) await new Promise((r) => setTimeout(r, 50));
  }

  // Wird vom Hauptprozess per executeJavaScript (mit Nutzergeste) aufgerufen.
  window.__grabScreen = async (maxWidth = 1600) => {
    clearTimeout(idleTimer);
    try {
      await ensure();
      const w = video.videoWidth;
      const h = video.videoHeight;
      if (!w || !h) throw new Error('Kein Bild von der Bildschirmfreigabe.');
      const scale = Math.min(1, maxWidth / w);
      const canvas = document.createElement('canvas');
      canvas.width = Math.round(w * scale);
      canvas.height = Math.round(h * scale);
      canvas.getContext('2d').drawImage(video, 0, 0, canvas.width, canvas.height);
      return { jpeg: canvas.toDataURL('image/jpeg', 0.75).split(',')[1] };
    } catch (err) {
      stop();
      return { error: String((err && err.message) || err) };
    } finally {
      idleTimer = setTimeout(stop, IDLE_MS);
    }
  };
  window.__stopScreenGrab = stop;
})();
