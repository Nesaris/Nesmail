'use strict';
// Client IMAP minimal (IMAP4rev1, TLS implicite port 993).
// Couvre LOGIN, SELECT, UID SEARCH, UID FETCH, UID STORE.
const tls = require('node:tls');
const net = require('node:net');

class ImapError extends Error {}

class Imap {
  constructor(opts) {
    this.host = opts.host;
    this.port = opts.port || 993;
    this.user = opts.user;
    this.pass = opts.pass;
    this.tls = opts.tls !== false;
    this.rejectUnauthorized = opts.rejectUnauthorized !== false;
    this.timeout = opts.timeout || 20000;
    this.tag = 0;
    this.buf = '';
    this.pending = null;
  }

  connect() {
    return new Promise((resolve, reject) => {
      const onErr = e => reject(new ImapError(`connexion IMAP ${this.host}:${this.port} — ${e.message}`));
      const opts = { host: this.host, port: this.port, rejectUnauthorized: this.rejectUnauthorized };
      this.sock = this.tls ? tls.connect(opts) : net.connect(opts);
      this.sock.setTimeout(this.timeout);
      this.sock.once('error', onErr);
      this.sock.on('timeout', () => this.sock.destroy(new ImapError('délai IMAP dépassé')));
      this.sock.setEncoding('binary');
      this.sock.on('data', d => this._onData(d));
      this._greeting = () => {
        this.sock.off('error', onErr);
        this.sock.on('error', e => { if (this.pending) this.pending.reject(new ImapError(e.message)); });
        resolve();
      };
    });
  }

  _onData(chunk) {
    this.buf += chunk;
    if (this._greeting && /^\* (OK|PREAUTH)/m.test(this.buf)) {
      const g = this._greeting; this._greeting = null; this.buf = ''; g();
      return;
    }
    if (!this.pending) return;
    const { tag } = this.pending;
    const re = new RegExp(`^${tag} (OK|NO|BAD)([^\r\n]*)\r?\n`, 'm');
    const m = this.buf.match(re);
    if (!m) return;
    const idx = this.buf.indexOf(m[0]);
    const payload = this.buf.slice(0, idx);
    this.buf = this.buf.slice(idx + m[0].length);
    const p = this.pending; this.pending = null;
    if (m[1] === 'OK') p.resolve({ lines: payload.split(/\r?\n/), raw: payload, status: m[2].trim() });
    else p.reject(new ImapError(`${p.cmd.split(' ')[0]} refusé : ${m[2].trim()}`));
  }

  send(cmd) {
    if (this.pending) return Promise.reject(new ImapError('commande IMAP déjà en cours'));
    const tag = 'A' + String(++this.tag).padStart(4, '0');
    return new Promise((resolve, reject) => {
      this.pending = { tag, cmd, resolve, reject };
      this.sock.write(`${tag} ${cmd}\r\n`, 'binary');
    });
  }

  async login() {
    const esc = s => String(s).replace(/\\/g, '\\\\').replace(/"/g, '\\"');
    await this.send(`LOGIN "${esc(this.user)}" "${esc(this.pass)}"`);
  }

  async select(box = 'INBOX') {
    const r = await this.send(`SELECT "${box}"`);
    const uidnext = (r.raw.match(/\[UIDNEXT (\d+)\]/) || [])[1];
    const exists = (r.raw.match(/^\* (\d+) EXISTS/m) || [])[1];
    return { uidnext: uidnext ? +uidnext : null, exists: exists ? +exists : 0 };
  }

  // criteria : 'UNSEEN', 'ALL', 'UID 12:*'
  async search(criteria = 'ALL') {
    const r = await this.send(`UID SEARCH ${criteria}`);
    const line = r.lines.find(l => /^\* SEARCH/i.test(l)) || '';
    return line.replace(/^\* SEARCH/i, '').trim().split(/\s+/).filter(Boolean).map(Number);
  }

  async fetch(uids, { peek = true, maxBytes = 262144 } = {}) {
    if (!uids.length) return [];
    const out = [];
    for (const uid of uids) {
      const item = peek ? `BODY.PEEK[]<0.${maxBytes}>` : `BODY[]<0.${maxBytes}>`;
      const r = await this.send(`UID FETCH ${uid} (UID INTERNALDATE FLAGS ${item})`);
      const parsed = parseFetch(r.raw);
      if (parsed) out.push({ uid, ...parsed });
    }
    return out;
  }

  async addFlag(uid, flag = '\\Seen') {
    await this.send(`UID STORE ${uid} +FLAGS (${flag})`);
  }

  async logout() {
    try { await this.send('LOGOUT'); } catch { /* le serveur ferme parfois avant */ }
    this.close();
  }

  close() {
    if (this.sock && !this.sock.destroyed) this.sock.destroy();
  }
}

function parseFetch(raw) {
  const m = raw.match(/\{(\d+)\}\r?\n/);
  if (!m) return null;
  const start = raw.indexOf(m[0]) + m[0].length;
  const body = raw.slice(start, start + Number(m[1]));
  const flags = (raw.match(/FLAGS \(([^)]*)\)/) || [])[1] || '';
  const date = (raw.match(/INTERNALDATE "([^"]+)"/) || [])[1] || null;
  return { body, flags: flags.split(/\s+/).filter(Boolean), internaldate: date };
}

module.exports = { Imap, ImapError, parseFetch };
