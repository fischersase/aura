// Tests für Hardware-/VRAM-Modellverfügbarkeit, Windows-Update-Popup, Feedback-Helfer und Erst-Einrichtung.
const test = require('node:test');
const assert = require('node:assert');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const hardware = require('../src/hardware');
const updater = require('../src/updater');
const feedback = require('../src/feedback');
const ollama = require('../src/ollama');

const SRC = path.join(__dirname, '..', 'src');
const read = (rel) => fs.readFileSync(path.join(SRC, rel), 'utf8');

test('hardware: Gemini models are disabled without API key and enabled with API key', () => {
  const noKey = hardware.evaluateModelAvailability({
    provider: 'gemini',
    model: { id: 'gemini-2.5-flash' },
    hasApiKey: false,
    hardware: { ramGb: 16, vramGb: 8 }
  });
  assert.strictEqual(noKey.available, false);
  assert.match(noKey.reason, /API-Key/i);
  assert.strictEqual(noKey.badge, 'API-Key fehlt');

  const withKey = hardware.evaluateModelAvailability({
    provider: 'gemini',
    model: { id: 'gemini-2.5-pro' },
    hasApiKey: true,
    hardware: { ramGb: 8, vramGb: null }
  });
  assert.strictEqual(withKey.available, true);
  assert.strictEqual(withKey.reason, '');
});

test('hardware: Ollama models respect VRAM and RAM limits', () => {
  // Recommended models all carry explicit minVramGb/minRamGb metadata.
  assert.ok(ollama.RECOMMENDED.length >= 4);
  for (const m of ollama.RECOMMENDED) {
    assert.strictEqual(typeof m.minVramGb, 'number', m.name);
    assert.strictEqual(typeof m.minRamGb, 'number', m.name);
  }

  // Fits directly into VRAM.
  const gpuFit = hardware.evaluateModelAvailability({
    provider: 'ollama',
    model: { name: 'gemma4:e4b', minVramGb: 6, minRamGb: 12 },
    hasApiKey: false,
    hardware: { ramGb: 16, vramGb: 8, gpuName: 'RTX 4060' }
  });
  assert.strictEqual(gpuFit.available, true);
  assert.match(gpuFit.badge, /VRAM/);

  // No dedicated GPU, but plenty of RAM.
  const ramFit = hardware.evaluateModelAvailability({
    provider: 'ollama',
    model: { name: 'gemma4:e2b', minVramGb: 4, minRamGb: 8 },
    hasApiKey: false,
    hardware: { ramGb: 16, vramGb: null }
  });
  assert.strictEqual(ramFit.available, true);
  assert.match(ramFit.badge, /RAM/);

  // Neither VRAM nor RAM suffices -> grayed out / unavailable.
  const tooBig = hardware.evaluateModelAvailability({
    provider: 'ollama',
    model: { name: 'qwen2.5vl:7b', minVramGb: 10, minRamGb: 16 },
    hasApiKey: false,
    hardware: { ramGb: 8, vramGb: 2, gpuName: 'MX250' }
  });
  assert.strictEqual(tooBig.available, false);
  assert.match(tooBig.reason, /Zu wenig Speicher/i);
  assert.match(tooBig.reason, /10 GB VRAM/);
  assert.match(tooBig.reason, /16 GB RAM/);

  // Parameter-count fallback heuristic for arbitrary Ollama models.
  assert.deepStrictEqual(hardware.requirementsForLocalModel({ name: 'llama3.1:70b' }), {
    minVramGb: 40,
    minRamGb: 64
  });
  assert.deepStrictEqual(hardware.requirementsForLocalModel({ name: 'qwen2.5:14b' }), {
    minVramGb: 12,
    minRamGb: 24
  });
  assert.match(
    hardware.formatHardwareSummary({ ramGb: 32, vramGb: 12, gpuName: 'RTX 4070', platform: 'win32' }),
    /32 GB RAM/
  );
  assert.match(
    hardware.formatHardwareSummary({ ramGb: 32, vramGb: 12, gpuName: 'RTX 4070', platform: 'win32' }),
    /12 GB VRAM/
  );
});

test('updater: compareVersions, isAllowedDownloadUrl, and parseExpectedSha256', () => {
  assert.strictEqual(updater.compareVersions('0.21.0', '0.20.0'), 1);
  assert.strictEqual(updater.compareVersions('v0.21.0', '0.21.0'), 0);
  assert.strictEqual(updater.compareVersions('0.20.9', '0.21.0'), -1);
  assert.strictEqual(updater.compareVersions('1.0.0', '0.99.9'), 1);

  assert.strictEqual(
    updater.isAllowedDownloadUrl('https://github.com/fischersase/aura/releases/download/v0.21.0/Aura-Setup.exe'),
    true
  );
  assert.strictEqual(
    updater.isAllowedDownloadUrl('https://objects.githubusercontent.com/github-production-release-asset/123'),
    true
  );
  assert.strictEqual(updater.isAllowedDownloadUrl('http://github.com/fischersase/aura/Aura-Setup.exe'), false);
  assert.strictEqual(updater.isAllowedDownloadUrl('https://evil.example.com/Aura-Setup.exe'), false);
  assert.strictEqual(updater.isAllowedDownloadUrl('file:///C:/Windows/calc.exe'), false);

  const hash = 'a'.repeat(64);
  const sums = `${hash}  Aura-Setup.exe\n${'b'.repeat(64)} *aura_amd64.deb\n`;
  assert.strictEqual(updater.parseExpectedSha256(sums, 'Aura-Setup.exe'), hash);
  assert.strictEqual(updater.parseExpectedSha256(sums, 'aura_amd64.deb'), 'b'.repeat(64));
  assert.strictEqual(updater.parseExpectedSha256(sums, 'missing.exe'), '');
});

test('updater: checkForUpdate detects newer Windows exe release and respects skippedVersion', async () => {
  const mockRelease = {
    tag_name: 'v0.21.0',
    name: 'Aura v0.21.0',
    body: '### Neu\n- Auto-Update Popup',
    published_at: '2026-11-26T12:00:00Z',
    html_url: 'https://github.com/fischersase/aura/releases/tag/v0.21.0',
    assets: [
      {
        name: 'Aura-Setup.exe',
        size: 95_000_000,
        browser_download_url: 'https://github.com/fischersase/aura/releases/download/v0.21.0/Aura-Setup.exe'
      },
      {
        name: 'SHA256SUMS',
        size: 180,
        browser_download_url: 'https://github.com/fischersase/aura/releases/download/v0.21.0/SHA256SUMS'
      }
    ]
  };
  const fakeFetch = async () => ({ ok: true, status: 200, json: async () => mockRelease });

  const res = await updater.checkForUpdate({
    currentVersion: '0.20.0',
    platform: 'win32',
    fetchImpl: fakeFetch
  });
  assert.strictEqual(res.updateAvailable, true);
  assert.strictEqual(res.skipped, false);
  assert.strictEqual(res.latestVersion, '0.21.0');
  assert.strictEqual(res.assetName, 'Aura-Setup.exe');
  assert.strictEqual(res.downloadUrl, mockRelease.assets[0].browser_download_url);
  assert.strictEqual(res.sumsUrl, mockRelease.assets[1].browser_download_url);

  const skippedRes = await updater.checkForUpdate({
    currentVersion: '0.20.0',
    skippedVersion: '0.21.0',
    platform: 'win32',
    fetchImpl: fakeFetch
  });
  assert.strictEqual(skippedRes.updateAvailable, true);
  assert.strictEqual(skippedRes.skipped, true);

  const sameRes = await updater.checkForUpdate({
    currentVersion: '0.21.0',
    platform: 'win32',
    fetchImpl: fakeFetch
  });
  assert.strictEqual(sameRes.updateAvailable, false);
});

test('updater: downloadAndVerify succeeds on valid SHA-256 and rejects tampered files', async () => {
  const payload = Buffer.from('fake-aura-windows-installer-binary');
  const goodSha = crypto.createHash('sha256').update(payload).digest('hex');
  const badSha = 'f'.repeat(64);
  const exeUrl = 'https://github.com/fischersase/aura/releases/download/v0.21.0/Aura-Setup.exe';
  const sumsUrl = 'https://github.com/fischersase/aura/releases/download/v0.21.0/SHA256SUMS';

  const makeFetch = (sha) => async (url) => {
    if (url === sumsUrl) {
      return { ok: true, status: 200, text: async () => `${sha}  Aura-Setup.exe\n` };
    }
    return {
      ok: true,
      status: 200,
      url: 'https://objects.githubusercontent.com/fake-asset',
      headers: { get: (k) => (k.toLowerCase() === 'content-length' ? String(payload.length) : null) },
      body: (async function* () {
        yield payload;
      })()
    };
  };

  const progressEvents = [];
  const ok = await updater.downloadAndVerify({
    downloadUrl: exeUrl,
    sumsUrl,
    assetName: 'Aura-Setup.exe',
    version: '0.21.0-test-ok',
    onProgress: (p) => progressEvents.push(p),
    fetchImpl: makeFetch(goodSha)
  });
  assert.strictEqual(ok.verified, true);
  assert.strictEqual(ok.sha256, goodSha);
  assert.strictEqual(ok.bytes, payload.length);
  assert.ok(fs.existsSync(ok.filePath));
  assert.ok(progressEvents.some((e) => e.stage === 'verify'));
  fs.rmSync(path.dirname(ok.filePath), { recursive: true, force: true });

  await assert.rejects(
    () =>
      updater.downloadAndVerify({
        downloadUrl: exeUrl,
        sumsUrl,
        assetName: 'Aura-Setup.exe',
        version: '0.21.0-test-bad',
        fetchImpl: makeFetch(badSha)
      }),
    /SHA-256/
  );

  await assert.rejects(
    () =>
      updater.downloadAndVerify({
        downloadUrl: 'https://evil.example.com/Aura-Setup.exe',
        assetName: 'Aura-Setup.exe',
        version: '0.21.0-test-evil',
        fetchImpl: makeFetch(goodSha)
      }),
    /GitHub Releases/
  );
});

test('feedback: buildFeedback produces safe GitHub issue URL with optional system context', () => {
  assert.throws(() => feedback.buildFeedback({ kind: 'bug', message: '   ' }), /Feedback/);

  const withSys = feedback.buildFeedback({
    kind: 'bug',
    title: 'Bluetooth-Kopfhörer unter Windows 11',
    message: 'Verbindung bricht nach 5 Sekunden ab.',
    includeSystemInfo: true,
    context: {
      version: '0.21.0',
      platform: 'win32',
      arch: 'x64',
      provider: 'gemini',
      model: 'gemini-2.5-flash',
      hardwareSummary: '16 GB RAM · NVIDIA RTX 4060 · 8 GB VRAM'
    }
  });
  assert.strictEqual(withSys.kind, 'bug');
  assert.strictEqual(withSys.title, '[Fehler] Bluetooth-Kopfhörer unter Windows 11');
  assert.ok(withSys.githubUrl.startsWith('https://github.com/fischersase/aura/issues/new?'));
  const parsed = new URL(withSys.githubUrl);
  assert.strictEqual(parsed.searchParams.get('labels'), 'bug,user-feedback');
  assert.match(parsed.searchParams.get('body') || '', /0\.21\.0/);
  assert.match(parsed.searchParams.get('body') || '', /RTX 4060/);
  assert.match(withSys.clipboardText, /\[Fehler\] Bluetooth-Kopfhörer/);

  const noSys = feedback.buildFeedback({
    kind: 'feature',
    message: 'Bitte mehr Stimmen für Live-Modus.',
    includeSystemInfo: false,
    context: { version: '0.21.0', platform: 'win32' }
  });
  assert.strictEqual(noSys.kind, 'feature');
  assert.doesNotMatch(noSys.body, /System-Kontext/);
  assert.match(noSys.title, /^\[Idee\]/);
});

test('UI wiring: onboarding, update popup, feedback modal and model gating exist', () => {
  const setupHtml = read('renderer/setup.html');
  const setupJs = read('renderer/setup.js');
  assert.match(setupHtml, /aistudio\.google\.com\/apikey/);
  assert.match(setupHtml, /id="clipBanner"/);
  assert.match(setupHtml, /id="toggleKeyVis"/);
  assert.match(setupHtml, /id="hwBanner"/);
  assert.match(setupJs, /readClipboardKey/);
  assert.match(setupJs, /hardwareInfo/);

  const updateHtml = read('renderer/update.html');
  const updateJs = read('renderer/update.js');
  assert.match(updateHtml, /id="installBtn"/);
  assert.match(updateHtml, /id="laterBtn"/);
  assert.match(updateHtml, /id="skipBtn"/);
  assert.match(updateJs, /installUpdate/);
  assert.match(updateJs, /skipVersion/);

  const panelHtml = read('renderer/panel.html');
  const panelJs = read('renderer/panel.js');
  assert.match(panelHtml, /id="feedbackBtn"/);
  assert.match(panelJs, /openFeedback/);

  const zentraleHtml = read('renderer/zentrale.html');
  const zentraleJs = read('renderer/zentrale.js');
  assert.match(zentraleHtml, /<dialog id="feedbackDialog"[^>]*closedby="any"/);
  assert.match(zentraleHtml, /id="openFeedbackBtn"/);
  assert.match(zentraleHtml, /id="cfgCheckUpdate"/);
  assert.match(zentraleHtml, /id="cfgHardwareInfo"/);
  assert.match(zentraleHtml, /id="cfgGeminiModelsGrid"/);
  assert.match(zentraleJs, /renderGeminiModelAvailability/);
  assert.match(zentraleJs, /checkLocalModelFit/);
  assert.match(zentraleJs, /feedbackDialog\.returnValue = ''/);
});
