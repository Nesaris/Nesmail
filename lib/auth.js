'use strict';
const crypto = require('node:crypto');

const SECRET = process.env.CACHET_SECRET || '';
const SESSION_HOURS = 12;

function hashPassword(plain) {
  const salt = crypto.randomBytes(16);
  const dk = crypto.scryptSync(plain, salt, 64, { N: 16384, r: 8, p: 1 });
  return `scrypt$${salt.toString('base64')}$${dk.toString('base64')}`;
}

function verifyPassword(plain, stored) {
  if (!stored || !stored.startsWith('scrypt$')) return false;
  const [, saltB64, dkB64] = stored.split('$');
  const dk = crypto.scryptSync(plain, Buffer.from(saltB64, 'base64'), 64, { N: 16384, r: 8, p: 1 });
  const known = Buffer.from(dkB64, 'base64');
  return dk.length === known.length && crypto.timingSafeEqual(dk, known);
}

/* ── TOTP (RFC 6238, SHA-1, 6 chiffres, pas de 30 s) ── */
function base32Decode(s) {
  const A = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  let bits = '';
  for (const c of String(s).toUpperCase().replace(/=+$/, '').replace(/\s/g, '')) {
    const v = A.indexOf(c);
    if (v < 0) continue;
    bits += v.toString(2).padStart(5, '0');
  }
  const out = [];
  for (let i = 0; i + 8 <= bits.length; i += 8) out.push(parseInt(bits.slice(i, i + 8), 2));
  return Buffer.from(out);
}

function totp(secretB32, at = Date.now()) {
  const k = base32Decode(secretB32);
  const counter = Math.floor(at / 30000);
  const buf = Buffer.alloc(8);
  buf.writeUInt32BE(Math.floor(counter / 2 ** 32), 0);
  buf.writeUInt32BE(counter >>> 0, 4);
  const hmac = crypto.createHmac('sha1', k).update(buf).digest();
  const off = hmac[hmac.length - 1] & 0x0f;
  const code = ((hmac[off] & 0x7f) << 24 | hmac[off + 1] << 16 | hmac[off + 2] << 8 | hmac[off + 3]) % 1e6;
  return String(code).padStart(6, '0');
}

// Accepte le pas précédent et le suivant, pour la dérive d'horloge.
function verifyTotp(secretB32, code) {
  if (!secretB32) return true;
  const c = String(code || '').replace(/\s/g, '');
  if (!/^\d{6}$/.test(c)) return false;
  const now = Date.now();
  for (const drift of [-30000, 0, 30000]) {
    const expected = totp(secretB32, now + drift);
    if (crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(c))) return true;
  }
  return false;
}

function newSecret() {
  const A = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  const bytes = crypto.randomBytes(20);
  let bits = '', out = '';
  for (const b of bytes) bits += b.toString(2).padStart(8, '0');
  for (let i = 0; i + 5 <= bits.length; i += 5) out += A[parseInt(bits.slice(i, i + 5), 2)];
  return out;
}

/* ── sessions : cookie signé, sans stockage serveur ── */
function sign(payload) {
  const body = Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
  const mac = crypto.createHmac('sha256', SECRET).update(body).digest('base64url');
  return `${body}.${mac}`;
}

function verify(token) {
  if (!token || !token.includes('.')) return null;
  const [body, mac] = token.split('.');
  const expected = crypto.createHmac('sha256', SECRET).update(body).digest('base64url');
  if (mac.length !== expected.length) return null;
  if (!crypto.timingSafeEqual(Buffer.from(mac), Buffer.from(expected))) return null;
  try {
    const payload = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
    if (payload.exp < Date.now()) return null;
    return payload;
  } catch { return null; }
}

function newSession() {
  return sign({ sub: 'cachet', exp: Date.now() + SESSION_HOURS * 3600000 });
}

function parseCookies(header) {
  const out = {};
  for (const part of String(header || '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

/* ── limitation des essais de connexion ── */
const essais = new Map();
function tropDEssais(ip) {
  const e = essais.get(ip);
  if (!e) return false;
  if (Date.now() - e.depuis > 15 * 60000) { essais.delete(ip); return false; }
  return e.n >= 8;
}
function noteEssai(ip, reussi) {
  if (reussi) { essais.delete(ip); return; }
  const e = essais.get(ip) || { n: 0, depuis: Date.now() };
  e.n++; essais.set(ip, e);
}

module.exports = {
  hashPassword, verifyPassword, totp, verifyTotp, newSecret,
  newSession, verify, parseCookies, tropDEssais, noteEssai, SESSION_HOURS
};
