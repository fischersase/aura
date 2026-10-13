// @ts-check
// JSON-RPC 2.0 über eine Zeilen-Verbindung, in beide Richtungen (Gegenstück zu agent/src/aura_agent/rpc/peer.py).
// Electron fragt den Agenten (task.start …), der Agent fragt Electron (host.approve, host.screenshot …).
const METHOD_NOT_FOUND = -32601;
const INTERNAL_ERROR = -32603;

/** @typedef {(params: Record<string, any>) => unknown} Handler */
/** @typedef {{ resolve: (value: any) => void, reject: (err: Error) => void, timer: NodeJS.Timeout | null }} Pending */

class RpcError extends Error {
  /**
   * @param {number} code
   * @param {string} message
   * @param {unknown} [data]
   */
  constructor(code, message, data) {
    super(message);
    this.code = code;
    this.data = data;
  }
}

class Peer {
  // write(string): schickt eine fertige Zeile; feed(chunk) mit eingehenden Daten aufrufen, close() beim Ende.
  /** @param {(line: string) => void} write */
  constructor(write) {
    this.write = write;
    this.nextId = 1;
    /** @type {Map<number, Pending>} */
    this.pending = new Map();
    /** @type {Map<string, Handler>} */
    this.handlers = new Map();
    /** @type {Map<string, Handler>} */
    this.notifyHandlers = new Map();
    this.buf = '';
    this.closed = false;
  }

  /**
   * @param {string} method
   * @param {Handler} handler
   */
  on(method, handler) {
    this.handlers.set(method, handler);
  }
  /**
   * @param {string} method
   * @param {Handler} handler
   */
  onNotify(method, handler) {
    this.notifyHandlers.set(method, handler);
  }

  /** @param {Record<string, unknown>} msg */
  send(msg) {
    if (this.closed) return;
    this.write(JSON.stringify({ jsonrpc: '2.0', ...msg }) + '\n');
  }

  /**
   * @param {string} method
   * @param {Record<string, unknown>} [params]
   */
  notify(method, params = {}) {
    this.send({ method, params });
  }

  /**
   * @param {string} method
   * @param {Record<string, unknown>} [params]
   * @param {number} [timeoutMs] 0 = no timeout
   * @returns {Promise<any>}
   */
  request(method, params = {}, timeoutMs = 0) {
    if (this.closed) return Promise.reject(new RpcError(INTERNAL_ERROR, 'Verbindung geschlossen'));
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = timeoutMs
        ? setTimeout(() => {
            this.pending.delete(id);
            reject(new RpcError(INTERNAL_ERROR, `${method}: keine Antwort nach ${timeoutMs} ms`));
          }, timeoutMs)
        : null;
      this.pending.set(id, { resolve, reject, timer });
      this.send({ id, method, params });
    });
  }

  /** @param {Buffer | string} chunk */
  feed(chunk) {
    this.buf += chunk.toString('utf8');
    let nl;
    while ((nl = this.buf.indexOf('\n')) >= 0) {
      const line = this.buf.slice(0, nl).trim();
      this.buf = this.buf.slice(nl + 1);
      if (line) this.dispatch(line);
    }
  }

  close(reason = 'Verbindung geschlossen') {
    if (this.closed) return;
    this.closed = true;
    for (const { reject, timer } of this.pending.values()) {
      if (timer) clearTimeout(timer);
      reject(new RpcError(INTERNAL_ERROR, reason));
    }
    this.pending.clear();
  }

  /** @param {string} line */
  dispatch(line) {
    /** @type {any} */
    let msg;
    try {
      msg = JSON.parse(line);
    } catch {
      return;
    }
    // Anything that is not an object (e.g. `null`) is ignored instead of throwing in the main process.
    if (!msg || typeof msg !== 'object') return;
    if (msg.method) {
      if (msg.id === undefined || msg.id === null) {
        const h = this.notifyHandlers.get(msg.method);
        if (h) {
          try {
            h(msg.params || {});
          } catch (err) {
            console.error('[agent2]', msg.method, err);
          }
        }
        return;
      }
      this.handle(msg);
      return;
    }
    const p = this.pending.get(msg.id);
    if (!p) return;
    this.pending.delete(msg.id);
    if (p.timer) clearTimeout(p.timer);
    if (msg.error) p.reject(toRpcError(msg.error));
    else p.resolve(msg.result);
  }

  /** @param {{ id: unknown, method: string, params?: Record<string, any> }} msg */
  async handle(msg) {
    const h = this.handlers.get(msg.method);
    if (!h)
      return this.send({ id: msg.id, error: { code: METHOD_NOT_FOUND, message: `Unbekannte Methode ${msg.method}` } });
    try {
      const result = await h(msg.params || {});
      this.send({ id: msg.id, result: result === undefined ? {} : result });
    } catch (err) {
      const e = /** @type {{ code?: unknown, message?: unknown }} */ (err);
      const code = typeof e?.code === 'number' ? e.code : INTERNAL_ERROR;
      this.send({ id: msg.id, error: { code, message: String(e?.message || err) } });
    }
  }
}

/**
 * RpcError from the error member of a response; tolerates non-object values.
 * @param {unknown} error
 */
function toRpcError(error) {
  if (error && typeof error === 'object') {
    const e = /** @type {{ code?: unknown, message?: unknown, data?: unknown }} */ (error);
    return new RpcError(typeof e.code === 'number' ? e.code : INTERNAL_ERROR, String(e.message ?? 'Fehler'), e.data);
  }
  return new RpcError(INTERNAL_ERROR, String(error));
}

module.exports = { Peer, RpcError, PROTOCOL_VERSION: 1 };
