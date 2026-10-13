// @ts-check
// Which credential was set, used, refreshed or deleted, and when (AURA-93, FR-CRED-007). Never the value.
// Append-only JSON lines in userData/credential-audit.jsonl, rotated to .1 at 1 MB.
const fs = require('fs');
const path = require('path');

const MAX_BYTES = 1024 * 1024;

/** @typedef {'set' | 'delete' | 'use' | 'refresh' | 'revoke' | 'migrate'} CredentialAction */
/** @typedef {{ action: CredentialAction, name: string, kind?: string, by?: string }} CredentialEvent */

/**
 * @param {() => string} file path of the log
 * @param {() => number} [now]
 */
function createCredentialAudit(file, now = Date.now) {
  return {
    /** @param {CredentialEvent} event */
    write(event) {
      const target = file();
      try {
        fs.mkdirSync(path.dirname(target), { recursive: true });
        try {
          if (fs.statSync(target).size > MAX_BYTES) fs.renameSync(target, target + '.1');
        } catch {}
        const line = { ts: new Date(now()).toISOString(), ...event };
        fs.appendFileSync(target, JSON.stringify(line) + '\n', { mode: 0o600 });
      } catch {
        // The audit must never break storing or using a credential.
      }
    }
  };
}

module.exports = { createCredentialAudit, MAX_BYTES };
