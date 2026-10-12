// JSON-RPC 2.0 über eine Zeilen-Verbindung, in beide Richtungen (Gegenstück zu agent/src/aura_agent/rpc/peer.py).
// Electron fragt den Agenten (task.start …), der Agent fragt Electron (host.approve, host.screenshot …).
const METHOD_NOT_FOUND = -32601;
const INTERNAL_ERROR = -32603;

class RpcError extends Error {
  constructor(code, message, data) {
    super(message);
    this.code = code;
    this.data = data;
  }
}

class Peer {
  // write(string): schickt eine fertige Zeile; feed(chunk) mit eingehenden Daten aufrufen, close() beim Ende.
  constructor(write) {
    this.write = write;
    this.nextId = 1;
    this.pending = new Map();
    this.handlers = new Map();
    this.notifyHandlers = new Map();
    this.buf = '';
    this.closed = false;
  }

  on(method, handler) { this.handlers.set(method, handler); }
  onNotify(method, handler) { this.notifyHandlers.set(method, handler); }

  send(msg) {
    if (this.closed) return;
    this.write(JSON.stringify({ jsonrpc: '2.0', ...msg }) + '\n');
  }

  notify(method, params = {}) { this.send({ method, params }); }

  request(method, params = {}, timeoutMs = 0) {
    if (this.closed) return Promise.reject(new RpcError(INTERNAL_ERROR, 'Verbindung geschlossen'));
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = timeoutMs ? setTimeout(() => { this.pending.delete(id); reject(new RpcError(INTERNAL_ERROR, `${method}: keine Antwort nach ${timeoutMs} ms`)); }, timeoutMs) : null;
      this.pending.set(id, { resolve, reject, timer });
      this.send({ id, method, params });
    });
  }

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

  dispatch(line) {
    let msg;
    try { msg = JSON.parse(line); } catch { return; }
    if (msg.method) {
      if (msg.id === undefined || msg.id === null) {
        const h = this.notifyHandlers.get(msg.method);
        if (h) { try { h(msg.params || {}); } catch (err) { console.error('[agent2]', msg.method, err); } }
        return;
      }
      this.handle(msg);
      return;
    }
    const p = this.pending.get(msg.id);
    if (!p) return;
    this.pending.delete(msg.id);
    if (p.timer) clearTimeout(p.timer);
    if (msg.error) p.reject(new RpcError(msg.error.code, msg.error.message, msg.error.data));
    else p.resolve(msg.result);
  }

  async handle(msg) {
    const h = this.handlers.get(msg.method);
    if (!h) return this.send({ id: msg.id, error: { code: METHOD_NOT_FOUND, message: `Unbekannte Methode ${msg.method}` } });
    try {
      const result = await h(msg.params || {});
      this.send({ id: msg.id, result: result === undefined ? {} : result });
    } catch (err) {
      this.send({ id: msg.id, error: { code: err.code || INTERNAL_ERROR, message: String(err.message || err) } });
    }
  }
}

module.exports = { Peer, RpcError, PROTOCOL_VERSION: 1 };
