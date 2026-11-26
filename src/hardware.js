// @ts-check
// Hardware-Erkennung (RAM & GPU-VRAM) und Modell-Verfügbarkeit für Setup, Zentrale und Einstellungen.
const { execFile } = require('child_process');
const fs = require('fs');
const os = require('os');

const GEMINI_MODELS = [
  {
    id: 'gemini-3.8-flash',
    label: 'Gemini 3.8 Flash (Empfohlen · schnell & stark)',
    role: 'chat',
    requiresApiKey: true
  },
  {
    id: 'gemini-3.5-flash-lite',
    label: 'Gemini 3.5 Flash Lite (Sehr günstig & schnell)',
    role: 'chat',
    requiresApiKey: true
  },
  {
    id: 'gemini-2.5-flash',
    label: 'Gemini 2.5 Flash (Stabil & bewährt)',
    role: 'chat',
    requiresApiKey: true
  },
  {
    id: 'gemini-2.5-pro',
    label: 'Gemini 2.5 Pro (Maximale Qualität)',
    role: 'chat',
    requiresApiKey: true
  }
];

/**
 * @typedef {object} HardwareInfo
 * @property {number} ramGb
 * @property {number | null} vramGb
 * @property {string} gpuName
 * @property {string} platform
 */

/** @type {Promise<HardwareInfo> | null} */
let cachedHardware = null;

/** @param {string} cmd @param {string[]} args @param {number} [timeout] */
function runOut(cmd, args, timeout = 5000) {
  return new Promise((resolve) => {
    execFile(cmd, args, { timeout, windowsHide: true }, (err, stdout) => {
      resolve(err ? '' : String(stdout || '').trim());
    });
  });
}

/** @returns {Promise<{ vramGb: number | null, gpuName: string }>} */
async function detectNvidiaSmi() {
  const out = await runOut('nvidia-smi', ['--query-gpu=name,memory.total', '--format=csv,noheader,nounits'], 4000);
  if (!out) return { vramGb: null, gpuName: '' };
  let bestGb = 0;
  let bestName = '';
  for (const line of out.split(/\r?\n/)) {
    const parts = line.split(',').map((s) => s.trim());
    if (parts.length >= 2) {
      const mb = Number(parts[1]);
      if (Number.isFinite(mb) && mb > 0) {
        const gb = Math.round((mb / 1024) * 10) / 10;
        if (gb > bestGb) {
          bestGb = gb;
          bestName = parts[0];
        }
      }
    }
  }
  return bestGb > 0 ? { vramGb: bestGb, gpuName: bestName } : { vramGb: null, gpuName: '' };
}

/** @returns {Promise<{ vramGb: number | null, gpuName: string }>} */
async function detectWindowsGpu() {
  const nv = await detectNvidiaSmi();
  if (nv.vramGb) return nv;
  // Registry HardwareInformation.qwMemorySize liefert 64-Bit-VRAM (>4 GB korrekt, im Gegensatz zu 32-Bit AdapterRAM).
  const script = [
    "$ErrorActionPreference = 'SilentlyContinue'",
    '$bestBytes = [uint64]0; $bestName = ""',
    "Get-ItemProperty 'HKLM:\\SYSTEM\\ControlSet001\\Control\\Class\\{4d36e968-e325-11ce-bfc1-08002be10318}\\0*' | ForEach-Object {",
    '  $q = $_."HardwareInformation.qwMemorySize"',
    '  $n = $_.DriverDesc',
    '  if ($q -is [uint64] -or $q -is [int64] -or $q -is [int32]) {',
    '    $b = [uint64]$q',
    '    if ($b -gt $bestBytes) { $bestBytes = $b; if ($n) { $bestName = [string]$n } }',
    '  }',
    '}',
    'if ($bestBytes -eq 0) {',
    '  Get-CimInstance Win32_VideoController | ForEach-Object {',
    '    $b = [uint64]($_.AdapterRAM)',
    '    if ($b -gt $bestBytes) { $bestBytes = $b; if ($_.Name) { $bestName = [string]$_.Name } }',
    '  }',
    '}',
    '[PSCustomObject]@{ bytes = $bestBytes; name = $bestName } | ConvertTo-Json -Compress'
  ].join('\n');
  const out = await runOut(
    'powershell.exe',
    ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script],
    6000
  );
  if (!out) return { vramGb: null, gpuName: '' };
  try {
    const j = JSON.parse(out);
    const bytes = Number(j.bytes || 0);
    const gb = bytes > 0 ? Math.round((bytes / 1024 ** 3) * 10) / 10 : null;
    return { vramGb: gb, gpuName: String(j.name || '').trim() };
  } catch {
    return { vramGb: null, gpuName: '' };
  }
}

/** @returns {Promise<{ vramGb: number | null, gpuName: string }>} */
async function detectLinuxGpu() {
  const nv = await detectNvidiaSmi();
  if (nv.vramGb) return nv;
  // AMD / DRM sysfs
  try {
    const cards = fs.readdirSync('/sys/class/drm').filter((c) => /^card\d+$/.test(c));
    let bestBytes = 0;
    for (const c of cards) {
      const p = `/sys/class/drm/${c}/device/mem_info_vram_total`;
      if (fs.existsSync(p)) {
        const b = Number(fs.readFileSync(p, 'utf8').trim());
        if (Number.isFinite(b) && b > bestBytes) bestBytes = b;
      }
    }
    if (bestBytes > 0) {
      return { vramGb: Math.round((bestBytes / 1024 ** 3) * 10) / 10, gpuName: 'Dedizierte GPU' };
    }
  } catch {}
  return { vramGb: null, gpuName: '' };
}

/** @returns {Promise<HardwareInfo>} */
function detectHardware() {
  if (cachedHardware) return cachedHardware;
  cachedHardware = (async () => {
    const ramGb = Math.max(1, Math.round(os.totalmem() / 1024 ** 3));
    if (process.platform === 'win32') {
      const g = await detectWindowsGpu();
      return { ramGb, vramGb: g.vramGb, gpuName: g.gpuName, platform: 'win32' };
    }
    if (process.platform === 'darwin') {
      return {
        ramGb,
        vramGb: Math.round(ramGb * 0.75),
        gpuName: 'Apple Unified Memory',
        platform: 'darwin'
      };
    }
    const g = await detectLinuxGpu();
    return { ramGb, vramGb: g.vramGb, gpuName: g.gpuName, platform: process.platform };
  })();
  return cachedHardware;
}

/**
 * Schätzt Mindestanforderungen eines beliebigen Ollama-Modellnamens (z. B. "llama3.1:70b", "qwen2.5:14b").
 * @param {{ name: string, minVramGb?: number, minRamGb?: number, size?: number }} model
 * @returns {{ minVramGb: number, minRamGb: number }}
 */
function requirementsForLocalModel(model) {
  if (typeof model.minVramGb === 'number' && typeof model.minRamGb === 'number') {
    return { minVramGb: model.minVramGb, minRamGb: model.minRamGb };
  }
  if (typeof model.size === 'number' && model.size > 0) {
    const sizeGb = model.size / 1024 ** 3;
    const minVramGb = Math.max(2, Math.ceil(sizeGb * 1.25));
    return { minVramGb, minRamGb: Math.max(8, Math.ceil(sizeGb * 1.6)) };
  }
  const m = /([0-9.]+)b\b/i.exec(String(model.name || ''));
  const b = m ? Number(m[1]) : NaN;
  if (Number.isFinite(b) && b > 0) {
    if (b >= 60) return { minVramGb: 40, minRamGb: 64 };
    if (b >= 24) return { minVramGb: 20, minRamGb: 32 };
    if (b >= 12) return { minVramGb: 12, minRamGb: 24 };
    if (b >= 7) return { minVramGb: 8, minRamGb: 16 };
    return { minVramGb: 4, minRamGb: 8 };
  }
  return { minVramGb: 6, minRamGb: 12 };
}

/**
 * Prüft, ob ein Modell auf diesem PC ausführbar ist (API-Key für Gemini, VRAM/RAM für Ollama).
 * @param {{
 *   provider: 'gemini' | 'ollama',
 *   model: { name?: string, id?: string, minVramGb?: number, minRamGb?: number, size?: number },
 *   hasApiKey: boolean,
 *   hardware: { ramGb: number, vramGb: number | null, gpuName?: string } | null
 * }} opts
 * @returns {{ available: boolean, reason: string, badge: string }}
 */
function evaluateModelAvailability({ provider, model, hasApiKey, hardware }) {
  if (provider === 'gemini') {
    if (!hasApiKey) {
      return {
        available: false,
        reason: 'Kein Gemini API-Key hinterlegt – erst API-Key einrichten',
        badge: 'API-Key fehlt'
      };
    }
    return { available: true, reason: '', badge: 'Bereit ✓' };
  }

  const req = requirementsForLocalModel({
    name: String(model.name || model.id || ''),
    minVramGb: model.minVramGb,
    minRamGb: model.minRamGb,
    size: model.size
  });
  if (!hardware) return { available: true, reason: '', badge: '' };

  const vram = typeof hardware.vramGb === 'number' && hardware.vramGb > 0 ? hardware.vramGb : 0;
  const ram = typeof hardware.ramGb === 'number' && hardware.ramGb > 0 ? hardware.ramGb : 0;

  if (vram >= req.minVramGb) {
    return { available: true, reason: '', badge: `passt in VRAM (${vram} GB) ✓` };
  }
  if (ram >= req.minRamGb) {
    return {
      available: true,
      reason: '',
      badge: vram > 0 ? `teils RAM (${ram} GB)` : `läuft über RAM (${ram} GB)`
    };
  }
  const have = vram > 0 ? `${vram} GB VRAM / ${ram} GB RAM` : `${ram} GB RAM, keine passende GPU`;
  return {
    available: false,
    reason: `Zu wenig Speicher: braucht ≥ ${req.minVramGb} GB VRAM oder ${req.minRamGb} GB RAM (dein PC: ${have})`,
    badge: `Braucht ${req.minVramGb} GB VRAM / ${req.minRamGb} GB RAM`
  };
}

/** @param {HardwareInfo | null | undefined} hw */
function formatHardwareSummary(hw) {
  if (!hw) return 'Hardware wird erkannt …';
  const gpu = hw.vramGb
    ? `${hw.gpuName ? hw.gpuName + ' · ' : ''}${hw.vramGb} GB VRAM`
    : hw.gpuName || 'Keine dedizierte GPU erkannt';
  return `${hw.ramGb} GB RAM · ${gpu}`;
}

module.exports = {
  GEMINI_MODELS,
  detectHardware,
  requirementsForLocalModel,
  evaluateModelAvailability,
  formatHardwareSummary
};
