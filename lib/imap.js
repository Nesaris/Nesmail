// Client IMAP minimal (IMAP4rev1) : TLS implicite (993) ou STARTTLS exigé
// (143). Jamais en clair : un serveur qui refuse STARTTLS n'entend pas le mot
// de passe. Couvre LOGIN, SELECT, UID SEARCH, UID FETCH, UID STORE.
import net from 'node:net';
import { connecterTls } from './tls.js';
import { lookupGarde, hoteInterdit } from './reseau.js';

class ImapError extends Error {}

// Ce qu'une réponse en attente peut accumuler : une relève lit au plus
// cinquante messages de 256 Kio. Au-delà, le serveur déborde : on coupe.
const TAMPON_MAX = 32 * 1024 * 1024;
// Ce qui entre dans une commande IMAP : jamais de retour à la ligne ni de NUL,
// qui feraient d'une valeur une seconde commande.
const SUR = /^[^\r\n\0]*$/;

class Imap {
  constructor(opts) {
    this.host = opts.host;
    this.port = opts.port || 993;
    this.user = opts.user;
    this.pass = opts.pass;
    this.tls = opts.tls !== false;
    this.epingle = opts.epingle || '';
    this.surEpingle = opts.surEpingle || null;
    this.timeout = opts.timeout || 20000;
    this.tag = 0;
    this.buf = '';
    this.pending = null;
  }

  async connect() {
    const ou = `${this.host}:${this.port}`;
    if (hoteInterdit(this.host)) throw new ImapError(`connexion IMAP ${ou} — adresse interdite`);
    try {
      if (this.tls) {
        this._brancher(await connecterTls({ host: this.host, port: this.port, epingle: this.epingle, surEpingle: this.surEpingle, delai: this.timeout }));
        await this._accueil();
      } else {
        const clair = net.connect({ host: this.host, port: this.port, lookup: lookupGarde });
        await new Promise((resolve, reject) => { clair.once('connect', resolve); clair.once('error', reject); });
        this._brancher(clair);
        await this._accueil();
        // STARTTLS exigé : rien d'autre ne part en clair.
        try { await this.send('STARTTLS'); } catch { throw new ImapError('le serveur ne propose pas STARTTLS : connexion refusée en clair'); }
        clair.removeAllListeners('data');
        this.buf = '';
        this._brancher(await connecterTls({ host: this.host, port: this.port, socket: clair, epingle: this.epingle, surEpingle: this.surEpingle, delai: this.timeout }));
      }
    } catch (e) {
      this.close();
      throw e instanceof ImapError ? e : Object.assign(new ImapError(`connexion IMAP ${ou} — ${e.message}`), { empreinte: e.empreinte });
    }
  }

  _brancher(sock) {
    this.sock = sock;
    sock.setTimeout(this.timeout);
    sock.on('timeout', () => sock.destroy(new ImapError('délai IMAP dépassé')));
    sock.setEncoding('binary');
    sock.on('data', d => this._onData(d));
    sock.on('error', e => { if (this.pending) { const p = this.pending; this.pending = null; p.reject(new ImapError(e.message)); } });
    sock.on('close', () => { if (this.pending) { const p = this.pending; this.pending = null; p.reject(new ImapError('connexion IMAP fermée')); } });
  }

  _accueil() {
    return new Promise((resolve, reject) => {
      this._greeting = resolve;
      this.pending = { tag: null, cmd: 'accueil', resolve, reject };
      this._onData('');
    }).finally(() => { this.pending = null; });
  }

  _onData(chunk) {
    this.buf += chunk;
    if (this.buf.length > TAMPON_MAX) { this.sock.destroy(new ImapError('réponse IMAP démesurée')); return; }
    if (this._greeting && /^\* (OK|PREAUTH)/m.test(this.buf)) {
      const g = this._greeting; this._greeting = null; this.buf = ''; g();
      return;
    }
    if (!this.pending || !this.pending.tag) return;
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
    if (!SUR.test(cmd)) return Promise.reject(new ImapError('commande IMAP invalide'));
    const tag = 'A' + String(++this.tag).padStart(4, '0');
    return new Promise((resolve, reject) => {
      this.pending = { tag, cmd, resolve, reject };
      this.sock.write(`${tag} ${cmd}\r\n`, 'binary');
    });
  }

  async login() {
    await this.send(`LOGIN ${chaine(this.user)} ${chaine(this.pass)}`);
  }

  async select(box = 'INBOX') {
    const r = await this.send(`SELECT ${chaine(box)}`);
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

// Chaîne entre guillemets IMAP : barre oblique inverse et guillemet échappés.
function chaine(v) {
  return `"${String(v).replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
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

export { Imap };
