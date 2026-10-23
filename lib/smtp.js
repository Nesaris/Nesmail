'use strict';
// Client SMTP minimal : STARTTLS (587) ou TLS implicite (465), AUTH PLAIN / LOGIN.
const net = require('node:net');
const tls = require('node:tls');
const os = require('node:os');

class SmtpError extends Error {
  constructor(msg, code) { super(msg); this.code = code; }
}

function reader(sock) {
  let buf = '';
  const waiters = [];
  sock.setEncoding('utf8');
  sock.on('data', d => {
    buf += d;
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
  const b64 = s => Buffer.from(String(s), 'utf8').toString('base64');
  const enc = s => /[^\x20-\x7E]/.test(String(s)) ? `=?UTF-8?B?${b64(s)}?=` : String(s);
  const id = `<${Date.now().toString(36)}.${Math.random().toString(36).slice(2)}@${String(from).split('@')[1]}>`;
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
    rejectUnauthorized = true, timeout = 20000
  } = opts;

  const recipients = Array.isArray(to) ? to : [to];
  const msg = buildMessage({ from, fromName, to: recipients, subject, text, inReplyTo, references });

  let sock = secure ? tls.connect({ host, port, rejectUnauthorized }) : net.connect({ host, port });
  sock.setTimeout(timeout);
  sock.on('timeout', () => sock.destroy(new SmtpError('délai SMTP dépassé')));

  let rd = reader(sock);
  await new Promise((res, rej) => {
    sock.once(secure ? 'secureConnect' : 'connect', res);
    sock.once('error', rej);
  });
  await expect(rd, 220, 'bannière SMTP');

  const ehlo = async () => {
    sock.write(`EHLO ${os.hostname()}\r\n`);
    return expect(rd, 250, 'EHLO');
  };
  let caps = (await ehlo()).text;

  if (!secure && /STARTTLS/i.test(caps)) {
    sock.write('STARTTLS\r\n');
    await expect(rd, 220, 'STARTTLS');
    sock = tls.connect({ socket: sock, servername: host, rejectUnauthorized });
    await new Promise((res, rej) => { sock.once('secureConnect', res); sock.once('error', rej); });
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
}

module.exports = { send, buildMessage, SmtpError };
