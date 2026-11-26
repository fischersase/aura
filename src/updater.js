// @ts-check
// GitHub-Release-Prüfung und verifizierter Download (SHA-256) für Windows-Updates (Aura-Setup.exe).
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');

const REPO = 'fischersase/aura';
const API_LATEST = `https://api.github.com/repos/${REPO}/releases/latest`;
const ALLOWED_HOSTS = new Set([
  'github.com',
  'api.github.com',
  'objects.githubusercontent.com',
  'release-assets.githubusercontent.com'
]);

/**
 * Vergleicht zwei Semver-Strings (z. B. "0.20.0" vs "0.21.0").
 * Rückgabe: 1 wenn a > b, -1 wenn a < b, 0 wenn gleich.
 * @param {string} a
 * @param {string} b
 */
function compareVersions(a, b) {
  const parse = (v) =>
    String(v || '')
      .trim()
      .replace(/^v/i, '')
      .split('-')[0]
      .split('.')
      .map((n) => Number.parseInt(n, 10) || 0);
  const pa = parse(a);
  const pb = parse(b);
  const len = Math.max(pa.length, pb.length, 3);
  for (let i = 0; i < len; i++) {
    const x = pa[i] || 0;
    const y = pb[i] || 0;
    if (x > y) return 1;
    if (x < y) return -1;
  }
  return 0;
}

/** @param {string} url */
function isAllowedDownloadUrl(url) {
  try {
    const u = new URL(url);
    return u.protocol === 'https:' && ALLOWED_HOSTS.has(u.hostname.toLowerCase());
  } catch {
    return false;
  }
}

/**
 * @param {{
 *   currentVersion: string,
 *   skippedVersion?: string,
 *   platform?: NodeJS.Platform,
 *   fetchImpl?: typeof fetch
 * }} opts
 */
async function checkForUpdate({ currentVersion, skippedVersion = '', platform = process.platform, fetchImpl = fetch }) {
  const res = await fetchImpl(API_LATEST, {
    headers: {
      Accept: 'application/vnd.github+json',
      'User-Agent': `Aura/${currentVersion}`
    }
  });
  if (!res.ok) throw new Error(`GitHub-Update-Prüfung fehlgeschlagen (HTTP ${res.status}).`);
  /** @type {any} */
  const rel = await res.json();
  const tag = String(rel.tag_name || '').trim();
  const latestVersion = tag.replace(/^v/i, '');
  const isNewer = !!latestVersion && compareVersions(latestVersion, currentVersion) > 0;
  const skipped = !!skippedVersion && compareVersions(latestVersion, skippedVersion) === 0;
  const assets = Array.isArray(rel.assets) ? rel.assets : [];
  const wantAsset = platform === 'win32' ? 'Aura-Setup.exe' : 'aura_amd64.deb';
  const exe = assets.find((a) => a && a.name === wantAsset);
  const sums = assets.find((a) => a && a.name === 'SHA256SUMS');

  return {
    updateAvailable: isNewer,
    skipped,
    currentVersion: String(currentVersion).replace(/^v/i, ''),
    latestVersion,
    tag,
    name: String(rel.name || tag || `Aura ${latestVersion}`),
    notes: String(rel.body || '').trim(),
    publishedAt: String(rel.published_at || ''),
    releaseUrl: String(rel.html_url || `https://github.com/${REPO}/releases/latest`),
    assetName: exe ? String(exe.name) : wantAsset,
    downloadUrl: exe && isAllowedDownloadUrl(exe.browser_download_url) ? String(exe.browser_download_url) : '',
    sumsUrl: sums && isAllowedDownloadUrl(sums.browser_download_url) ? String(sums.browser_download_url) : '',
    sizeBytes: exe ? Number(exe.size || 0) : 0,
    platform
  };
}

/**
 * Parst eine SHA256SUMS-Datei und gibt den erwarteten Hash für `filename` zurück.
 * @param {string} content
 * @param {string} filename
 */
function parseExpectedSha256(content, filename) {
  for (const line of String(content || '').split(/\r?\n/)) {
    const m = /^\s*([0-9a-f]{64})\s+\*?(.+?)\s*$/i.exec(line);
    if (m && path.basename(m[2].trim()) === filename) return m[1].toLowerCase();
  }
  return '';
}

/**
 * Lädt das Update-Asset in ein temporäres Verzeichnis und prüft SHA-256 (falls SHA256SUMS vorhanden).
 * @param {{
 *   downloadUrl: string,
 *   sumsUrl?: string,
 *   assetName: string,
 *   version: string,
 *   onProgress?: (p: { received: number, total: number, percent: number, stage: string }) => void,
 *   fetchImpl?: typeof fetch
 * }} opts
 */
async function downloadAndVerify({ downloadUrl, sumsUrl = '', assetName, version, onProgress, fetchImpl = fetch }) {
  if (!isAllowedDownloadUrl(downloadUrl)) {
    throw new Error('Download-Adresse liegt nicht auf GitHub Releases.');
  }
  const safeVer = String(version || 'latest').replace(/[^0-9A-Za-z._-]/g, '');
  const safeName = path.basename(String(assetName || 'Aura-Setup.exe'));
  const dir = path.join(os.tmpdir(), `aura-update-${safeVer}`);
  fs.mkdirSync(dir, { recursive: true });
  const target = path.join(dir, safeName);

  onProgress?.({ received: 0, total: 0, percent: 0, stage: 'download' });
  const res = await fetchImpl(downloadUrl, {
    headers: { 'User-Agent': `Aura/${safeVer}` },
    redirect: 'follow'
  });
  if (!res.ok || !res.body) throw new Error(`Download fehlgeschlagen (HTTP ${res.status}).`);
  if (res.url && !isAllowedDownloadUrl(res.url)) {
    throw new Error('Weiterleitung auf nicht vertrauenswürdige Download-Adresse blockiert.');
  }

  const total = Number(res.headers.get('content-length') || 0);
  const hash = crypto.createHash('sha256');
  const out = fs.createWriteStream(target);
  let received = 0;

  try {
    // @ts-ignore ReadableStream async iterator is supported in Node 18+/Electron
    for await (const chunk of res.body) {
      const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      received += buf.length;
      hash.update(buf);
      out.write(buf);
      const percent = total > 0 ? Math.min(100, Math.round((received / total) * 100)) : 0;
      onProgress?.({ received, total, percent, stage: 'download' });
    }
    await new Promise((resolve, reject) => {
      out.on('finish', resolve);
      out.on('error', reject);
      out.end();
    });
  } catch (err) {
    out.destroy();
    fs.rmSync(target, { force: true });
    throw err;
  }

  const actualSha = hash.digest('hex');
  let verified = false;
  if (sumsUrl && isAllowedDownloadUrl(sumsUrl)) {
    onProgress?.({ received, total, percent: 100, stage: 'verify' });
    const sRes = await fetchImpl(sumsUrl, { headers: { 'User-Agent': `Aura/${safeVer}` }, redirect: 'follow' });
    if (sRes.ok) {
      const expected = parseExpectedSha256(await sRes.text(), safeName);
      if (expected) {
        if (expected !== actualSha) {
          fs.rmSync(target, { force: true });
          throw new Error('Prüfsummen-Fehler (SHA-256 stimmt nicht mit SHA256SUMS überein). Datei wurde verworfen.');
        }
        verified = true;
      }
    }
  }

  return { filePath: target, bytes: received, sha256: actualSha, verified };
}

module.exports = {
  REPO,
  compareVersions,
  isAllowedDownloadUrl,
  parseExpectedSha256,
  checkForUpdate,
  downloadAndVerify
};
