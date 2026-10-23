// Client SMTP minimal : TLS implicite (465) ou STARTTLS exigé (587, 25),
// AUTH PLAIN / LOGIN. Un serveur qui ne propose pas STARTTLS ne reçoit ni
// identifiants ni message : rien ne part en clair.
import net from 'node:net';
import crypto from 'node:crypto';
import { connecterTls } from './tls.js';
import { lookupGarde, hoteInterdit } from './reseau.js';

// Adresse admise dans une commande SMTP ou un en-tête : ni espace, ni chevron,
// ni retour à la ligne, qui ouvriraient une commande ou un en-tête de plus.
export const ADRESSE = /^[^\s<>@",;:\\]{1,64}@[A-Za-z0-9.-]{1,253}\.[A-Za-z]{2,63}$/;
// Identifiant de message auquel on répond : un seul, entre chevrons.
export const MESSAGE_ID = /^<[^\s<>]{3,250}>$/;
const TAMPON_MAX = 1024 * 1024;

class SmtpError extends Error {
  constructor(msg, code) { super(msg); this.code = code; }
}

function reader(sock) {
  let buf = '';
  const waiters = [];
  sock.setEncoding('utf8');
  sock.on('data', d => {
    buf += d;
    if (buf.length > TAMPON_MAX) { sock.destroy(new SmtpError('réponse SMTP démesurée')); return; }
    let m;
    while ((m = buf.match(/^(?:\d{3}-[^\n]*\n)*(\d{3}) [^\n]*\r?\n/))) {
      const chunk = buf.slice(0, m[0].length);
      buf = buf.slice(m[0].length);
      const w = waiters.shift();
      if (w) w.resolve({ code: Number(m[1]), text: chunk.trim() });
    }
  });
  return {
    next: () => new Promise((resolve, reject) => {
      waiters.push({ resolve, reject });
      sock.once('error', reject);
    })
  };
}

async function expect(rd, ok, what) {
  const r = await rd.next();
  const list = Array.isArray(ok) ? ok : [ok];
  if (!list.includes(r.code)) throw new SmtpError(`${what} : ${r.text}`, r.code);
  return r;
}

function dotStuff(body) {
  return body.replace(/\r?\n/g, '\r\n').replace(/^\./gm, '..');
}

function buildMessage({ from, fromName, to, subject, text, inReplyTo, references }) {
  for (const a of [from, ...to]) if (!ADRESSE.test(a)) throw new SmtpError(`adresse invalide : ${String(a).slice(0, 80)}`);
  for (const r of [inReplyTo, references]) if (r && !MESSAGE_ID.test(r)) throw new SmtpError('identifiant de message invalide');
  const b64 = s => Buffer.from(String(s), 'utf8').toString('base64');
  // Tout ce qui n'est pas imprimable (retours à la ligne compris) part encodé :
  // une valeur ne peut pas ajouter d'en-tête.
  const enc = s => /[^\x20-\x7E]/.test(String(s)) ? `=?UTF-8?B?${b64(s)}?=` : String(s);
  const id = `<${crypto.randomBytes(12).toString('hex')}@${String(from).split('@')[1]}>`;
  const lines = [
    `From: ${fromName ? `${enc(fromName)} <${from}>` : from}`,
    `To: ${Array.isArray(to) ? to.join(', ') : to}`,
    `Subject: ${enc(subject)}`,
    `Date: ${new Date().toUTCString().replace('GMT', '+0000')}`,
    `Message-ID: ${id}`,
    'MIME-Version: 1.0',
    'Content-Type: text/plain; charset=UTF-8',
    'Content-Transfer-Encoding: base64'
  ];
  if (inReplyTo) lines.push(`In-Reply-To: ${inReplyTo}`);
  if (references) lines.push(`References: ${references}`);
  const body = b64(text).replace(/(.{76})/g, '$1\r\n');
  return { id, data: lines.join('\r\n') + '\r\n\r\n' + body };
}

async function send(opts) {
  const {
    host, port = 587, user, pass, secure = port === 465,
    from, fromName, to, subject, text, inReplyTo, references,
    epingle = '', surEpingle = null, timeout = 20000
  } = opts;

  const recipients = Array.isArray(to) ? to : [to];
  const msg = buildMessage({ from, fromName, to: recipients, subject, text, inReplyTo, references });

  if (hoteInterdit(host)) throw new SmtpError(`connexion SMTP ${host}:${port} — adresse interdite`);
  let sock;
  try {
    sock = secure
      ? await connecterTls({ host, port, epingle, surEpingle, delai: timeout })
      : await new Promise((res, rej) => { const s = net.connect({ host, port, lookup: lookupGarde }); s.once('connect', () => res(s)); s.once('error', rej); });
  } catch (e) {
    throw Object.assign(new SmtpError(`connexion SMTP ${host}:${port} — ${e.message}`), { empreinte: e.empreinte });
  }
  const armer = s => { s.setTimeout(timeout); s.on('timeout', () => s.destroy(new SmtpError('délai SMTP dépassé'))); };
  armer(sock);

  let rd = reader(sock);
  try {
    await expect(rd, 220, 'bannière SMTP');

    // Le nom annoncé est celui du domaine expéditeur : rien de la machine.
    const nom = String(from).split('@')[1];
    const ehlo = async () => {
      sock.write(`EHLO ${nom}\r\n`);
      return expect(rd, 250, 'EHLO');
    };
    let caps = (await ehlo()).text;

    if (!secure) {
      if (!/STARTTLS/i.test(caps)) throw new SmtpError('le serveur ne propose pas STARTTLS : envoi refusé en clair');
      sock.write('STARTTLS\r\n');
      await expect(rd, 220, 'STARTTLS');
      sock.removeAllListeners('data');
      try {
        sock = await connecterTls({ host, port, socket: sock, epingle, surEpingle, delai: timeout });
      } catch (e) {
        throw Object.assign(new SmtpError(`TLS SMTP ${host}:${port} — ${e.message}`), { empreinte: e.empreinte });
      }
      armer(sock);
      rd = reader(sock);
      caps = (await ehlo()).text;
    }

    if (user && pass) {
      if (/AUTH[ =][^\n]*PLAIN/i.test(caps)) {
        const token = Buffer.from(`\0${user}\0${pass}`, 'utf8').toString('base64');
        sock.write(`AUTH PLAIN ${token}\r\n`);
        await expect(rd, 235, 'authentification SMTP');
      } else {
        sock.write('AUTH LOGIN\r\n');
        await expect(rd, 334, 'AUTH LOGIN');
        sock.write(Buffer.from(String(user), 'utf8').toString('base64') + '\r\n');
        await expect(rd, 334, 'utilisateur SMTP');
        sock.write(Buffer.from(String(pass), 'utf8').toString('base64') + '\r\n');
        await expect(rd, 235, 'authentification SMTP');
      }
    }

    sock.write(`MAIL FROM:<${from}>\r\n`);
    await expect(rd, 250, `expéditeur ${from} refusé`);
    for (const r of recipients) {
      sock.write(`RCPT TO:<${r}>\r\n`);
      await expect(rd, [250, 251], `destinataire ${r} refusé`);
    }
    sock.write('DATA\r\n');
    await expect(rd, 354, 'DATA');
    sock.write(dotStuff(msg.data) + '\r\n.\r\n');
    await expect(rd, 250, 'envoi');
    sock.write('QUIT\r\n');
    sock.end();
    return { messageId: msg.id };
  } catch (e) {
    sock.destroy();
    throw e;
  }
}

export { send, buildMessage };
