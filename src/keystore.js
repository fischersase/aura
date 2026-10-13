// @ts-check
// How well Aura can protect secrets on this system (AURA-93). Shared by the vault (secrets.js) and the Gemini key
// in the settings (store.js), so both follow the same rule: strong storage by default, weak only after the user
// explicitly agreed, never plaintext.

/**
 * The part of Electron's safeStorage Aura uses.
 * @typedef {object} SafeStorageLike
 * @property {() => boolean} isEncryptionAvailable
 * @property {(text: string) => Buffer} encryptString
 * @property {(data: Buffer) => string} decryptString
 * @property {() => string} [getSelectedStorageBackend] Linux only
 * @property {(usePlainText: boolean) => void} [setUsePlainTextEncryption] Linux only
 */

/** @typedef {'strong' | 'weak' | 'none'} Protection */

class WeakProtectionError extends Error {
  /** @param {Protection} protection */
  constructor(protection) {
    super(
      protection === 'none'
        ? 'Verschlüsselung ist auf diesem System nicht verfügbar (kein Schlüsselbund). Schlüssel werden deshalb nicht gespeichert.'
        : 'Kein Schlüsselbund gefunden: Aura würde den Schlüssel nur mit einem festen Kennwort verschlüsseln. ' +
            'Installiere bzw. entsperre gnome-keyring oder KWallet und starte Aura neu, oder erlaube in der Aura Zentrale ' +
            'unter „Schlüssel & Konten“ ausdrücklich die schwache Speicherung.'
    );
    this.name = 'WeakProtectionError';
    this.protection = protection;
  }
}

/**
 * Linux without a keyring: Electron falls back to a fixed password ("basic_text"), hardly better than plaintext.
 * @param {SafeStorageLike} safeStorage
 * @param {string} [platform]
 * @returns {Protection}
 */
function protectionOf(safeStorage, platform = process.platform) {
  const backend =
    platform === 'linux' && typeof safeStorage.getSelectedStorageBackend === 'function'
      ? safeStorage.getSelectedStorageBackend()
      : '';
  const fixedKey = backend === 'basic_text' || backend === 'unknown';
  // Electron (Linux) reports no encryption at all without a keyring until the fixed-key backend is switched on
  // with setUsePlainTextEncryption; that is the weak protection the user can agree to.
  if (!safeStorage.isEncryptionAvailable()) {
    return fixedKey && typeof safeStorage.setUsePlainTextEncryption === 'function' ? 'weak' : 'none';
  }
  return fixedKey ? 'weak' : 'strong';
}

/**
 * After the user agreed to weak storage: switch on Electron's fixed-key encryption (Linux without keyring), so
 * values can be stored, and values stored earlier stay readable. No effect elsewhere.
 * @param {SafeStorageLike} safeStorage
 * @param {boolean} allowWeak
 * @param {string} [platform]
 */
function enableWeakIfAllowed(safeStorage, allowWeak, platform = process.platform) {
  if (!allowWeak || platform !== 'linux' || typeof safeStorage.setUsePlainTextEncryption !== 'function') return;
  if (protectionOf(safeStorage, platform) === 'weak') safeStorage.setUsePlainTextEncryption(true);
}

/**
 * Throws unless secrets may be stored: strong protection, or weak protection with the user's explicit consent.
 * @param {Protection} protection
 * @param {boolean} allowWeak
 */
function assertStorable(protection, allowWeak) {
  if (protection === 'strong') return;
  if (protection === 'weak' && allowWeak) return;
  throw new WeakProtectionError(protection);
}

module.exports = { WeakProtectionError, protectionOf, assertStorable, enableWeakIfAllowed };
