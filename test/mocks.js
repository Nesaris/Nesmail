'use strict';
const net = require('node:net');

function makeMessage({ from, to, subject, body, encoded }) {
  const lines = [
    `Return-Path: <${from}>`, `Delivered-To: ${to}`, `From: ${from}`, `To: ${to}`,
    `Subject: ${subject}`, `Date: ${new Date().toUTCString()}`,
    `Message-ID: <${Math.random().toString(36).slice(2)}@mock>`, 'MIME-Version: 1.0'
  ];
  if (encoded === 'b64') {
    lines.push('Content-Type: text/plain; charset=UTF-8', 'Content-Transfer-Encoding: base64', '',
      Buffer.from(body, 'utf8').toString('base64'));
  } else if (encoded === 'multipart') {
    const b = 'BOUND42';
    lines.push(`Content-Type: multipart/alternative; boundary="${b}"`, '',
      `--${b}`, 'Content-Type: text/plain; charset=UTF-8', 'Content-Transfer-Encoding: quoted-printable', '',
      body.replace(/é/g, '=C3=A9'),
      `--${b}`, 'Content-Type: text/html; charset=UTF-8', '',
      `<p>Bonjour <b>vous</b>, voir <a href="https://exemple.fr/t/42">le ticket</a>.</p>` +
      `<script>alert(1)</script><img src="https://pisteur.example/x.gif"><p onclick="vol()">${body}</p>`,
      `--${b}--`);
  } else {
    lines.push('Content-Type: text/plain; charset=UTF-8', '', body);
  }
  return lines.join('\r\n');
}

function imapServer(messages, opts = {}) {
  const store = messages.map((m, i) => ({ uid: i + 1, raw: m, flags: [] }));
  const server = net.createServer(sock => {
    sock.setEncoding('binary');
    sock.write('* OK Mock IMAP ready\r\n');
    let buf = '';
    sock.on('data', d => {
      buf += d;
      let i;
      while ((i = buf.indexOf('\r\n')) >= 0) {
        const line = buf.slice(0, i); buf = buf.slice(i + 2);
        const [tag, cmd, ...rest] = line.split(' ');
        const up = (cmd || '').toUpperCase();
        const arg = rest.join(' ');

        if (up === 'LOGIN') {
          if (opts.badLogin) { sock.write(`${tag} NO [AUTHENTICATIONFAILED] mot de passe refusé\r\n`); continue; }
          sock.write(`${tag} OK LOGIN completed\r\n`);
        } else if (up === 'SELECT') {
          sock.write(`* ${store.length} EXISTS\r\n* OK [UIDNEXT ${store.length + 1}] ok\r\n${tag} OK [READ-WRITE] SELECT completed\r\n`);
        } else if (up === 'UID' && /^SEARCH/i.test(arg)) {
          const crit = arg.replace(/^SEARCH\s*/i, '').trim().toUpperCase();
          let list = store;
          if (crit === 'UNSEEN') list = store.filter(m => !m.flags.includes('\\Seen'));
          else if (/^UID (\d+):\*/.test(crit)) {
            const from = Number(crit.match(/^UID (\d+):/)[1]);
            list = store.filter(m => m.uid >= from);
          }
          sock.write(`* SEARCH ${list.map(m => m.uid).join(' ')}\r\n${tag} OK SEARCH completed\r\n`);
        } else if (up === 'UID' && /^FETCH/i.test(arg)) {
          const uid = Number(arg.match(/FETCH (\d+)/i)[1]);
          const m = store.find(x => x.uid === uid);
          if (!m) { sock.write(`${tag} OK FETCH completed\r\n`); continue; }
          const body = Buffer.from(m.raw, 'utf8');
          sock.write(`* ${uid} FETCH (UID ${uid} INTERNALDATE "01-Jan-2026 10:00:00 +0000" FLAGS (${m.flags.join(' ')}) BODY[]<0> {${body.length}}\r\n`);
          sock.write(m.raw, 'binary');
          sock.write(`)\r\n${tag} OK FETCH completed\r\n`);
        } else if (up === 'UID' && /^STORE/i.test(arg)) {
          const uid = Number(arg.match(/STORE (\d+)/i)[1]);
          const m = store.find(x => x.uid === uid);
          if (m && !m.flags.includes('\\Seen')) m.flags.push('\\Seen');
          sock.write(`${tag} OK STORE completed\r\n`);
        } else if (up === 'LOGOUT') {
          sock.write(`* BYE\r\n${tag} OK LOGOUT completed\r\n`); sock.end();
        } else {
          sock.write(`${tag} BAD commande inconnue\r\n`);
        }
      }
    });
    sock.on('error', () => {});
  });
  server.push = raw => store.push({ uid: store.length + 1, raw, flags: [] });
  return server;
}

function smtpServer(opts = {}) {
  const received = [];
  const server = net.createServer(sock => {
    sock.setEncoding('utf8');
    let state = 'cmd', data = '', current = {};
    sock.write('220 mock.smtp ESMTP\r\n');
    sock.on('data', chunk => {
      if (state === 'data') {
        data += chunk;
        const end = data.indexOf('\r\n.\r\n');
        if (end >= 0) {
          current.data = data.slice(0, end);
          received.push(current); current = {}; data = ''; state = 'cmd';
          sock.write('250 2.0.0 OK queued\r\n');
        }
        return;
      }
      for (const line of chunk.split('\r\n').filter(Boolean)) {
        const up = line.toUpperCase();
        if (up.startsWith('EHLO')) sock.write('250-mock.smtp\r\n250-AUTH LOGIN PLAIN\r\n250 SIZE 10240000\r\n');
        else if (up.startsWith('AUTH PLAIN')) sock.write('235 2.7.0 authentifié\r\n');
        else if (up.startsWith('AUTH LOGIN')) { state = 'user'; sock.write('334 VXNlcm5hbWU6\r\n'); }
        else if (state === 'user') { state = 'pass'; sock.write('334 UGFzc3dvcmQ6\r\n'); }
        else if (state === 'pass') { state = 'cmd'; sock.write('235 2.7.0 authentifié\r\n'); }
        else if (up.startsWith('MAIL FROM')) {
          const from = line.match(/<([^>]*)>/)[1];
          if (opts.rejectFrom && opts.rejectFrom === from) { sock.write('550 5.7.1 expéditeur non autorisé\r\n'); continue; }
          current.from = from; current.to = [];
          sock.write('250 2.1.0 OK\r\n');
        } else if (up.startsWith('RCPT TO')) { current.to.push(line.match(/<([^>]*)>/)[1]); sock.write('250 2.1.5 OK\r\n'); }
        else if (up.startsWith('DATA')) { state = 'data'; sock.write('354 envoyez\r\n'); }
        else if (up.startsWith('QUIT')) { sock.write('221 bye\r\n'); sock.end(); }
        else sock.write('250 OK\r\n');
      }
    });
    sock.on('error', () => {});
  });
  server.received = received;
  return server;
}

module.exports = { imapServer, smtpServer, makeMessage };
