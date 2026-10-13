// @ts-check
// Gemini Live through the main process (AURA-15): the panel talks to the Live API over IPC, and only this module
// holds the WebSocket. The API key travels in the x-goog-api-key header of the handshake, never in a URL and never
// to the renderer.
const LIVE_PATH = '/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContent';
const BASE = process.env.AURA_GEMINI_WS_BASE || 'wss://generativelanguage.googleapis.com'; // variable for tests only
const MAX_MESSAGE = 4 * 1024 * 1024; // one screen frame as base64 JPEG stays far below

/**
 * The part of a WebSocket the relay uses.
 * @typedef {object} RelaySocket
 * @property {string} binaryType
 * @property {number} readyState
 * @property {(data: string) => void} send
 * @property {() => void} close
 * @property {(() => void) | null} onopen
 * @property {((ev: { data: string | ArrayBuffer }) => void) | null} onmessage
 * @property {(() => void) | null} onerror
 * @property {((ev: { code: number, reason: string }) => void) | null} onclose
 */
/** @typedef {new (url: string, init: { headers: Record<string, string> }) => RelaySocket} RelaySocketClass */
/**
 * The renderer window (Electron webContents) a session belongs to.
 * @typedef {object} Sender
 * @property {(channel: string, data: object) => void} send
 * @property {() => boolean} isDestroyed
 * @property {(event: 'destroyed', listener: () => void) => void} [once]
 */

// Node's WebSocket (undici) accepts { headers } as second argument; the DOM typings do not know that.
const NodeWebSocket = /** @type {RelaySocketClass} */ (/** @type {unknown} */ (globalThis.WebSocket));

class LiveRelay {
  /**
   * @param {object} options
   * @param {() => string} options.getKey the Gemini API key
   * @param {RelaySocketClass} [options.WebSocketImpl] replaceable for tests
   * @param {string} [options.base]
   */
  constructor({ getKey, WebSocketImpl = NodeWebSocket, base = BASE }) {
    this.getKey = getKey;
    this.WebSocketImpl = WebSocketImpl;
    this.url = base + LIVE_PATH;
    /** @type {Map<number, { ws: RelaySocket, sender: Sender }>} */
    this.sessions = new Map();
    this.seq = 0;
  }

  /**
   * Opens a session for a renderer. Events go back as live:opened / live:message / live:closed.
   * @param {Sender} sender
   * @returns {{ id: number } | { error: string }}
   */
  open(sender) {
    const key = this.getKey();
    if (!key) return { error: 'Kein API-Key hinterlegt.' };
    // One Live session per window: a reconnect (session resumption) replaces the old socket.
    for (const [id, s] of this.sessions) if (s.sender === sender) this.close(id);
    const id = ++this.seq;
    const ws = new this.WebSocketImpl(this.url, { headers: { 'x-goog-api-key': key } });
    ws.binaryType = 'arraybuffer';
    const session = { ws, sender };
    this.sessions.set(id, session);
    /** @type {(channel: string, data: object) => void} */
    const emit = (channel, data) => {
      if (this.sessions.get(id) === session && !sender.isDestroyed()) sender.send(channel, { id, ...data });
    };
    ws.onopen = () => emit('live:opened', {});
    ws.onmessage = (ev) =>
      emit('live:message', { data: typeof ev.data === 'string' ? ev.data : Buffer.from(ev.data).toString('utf8') });
    ws.onerror = () => {};
    ws.onclose = (ev) => {
      emit('live:closed', { code: ev.code, reason: String(ev.reason || '') });
      if (this.sessions.get(id) === session) this.sessions.delete(id);
    };
    if (typeof sender.once === 'function') sender.once('destroyed', () => this.close(id));
    return { id };
  }

  /**
   * Only text frames from the window that opened the session.
   * @param {Sender} sender
   * @param {number} id
   * @param {unknown} data
   */
  send(sender, id, data) {
    const s = this.sessions.get(id);
    if (!s || s.sender !== sender || typeof data !== 'string' || data.length > MAX_MESSAGE) return false;
    if (s.ws.readyState !== 1) return false; // OPEN
    s.ws.send(data);
    return true;
  }

  /**
   * @param {number} id
   * @param {Sender} [sender] when given, only that window may close the session
   */
  close(id, sender) {
    const s = this.sessions.get(id);
    if (!s || (sender && s.sender !== sender)) return;
    this.sessions.delete(id);
    try {
      s.ws.close();
    } catch {}
  }
}

module.exports = { LiveRelay, LIVE_PATH, MAX_MESSAGE };
