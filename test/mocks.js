// Serveur IMAP d'essai : TLS implicite, STARTTLS, ou en clair sans STARTTLS
// (pour vérifier que Nesmail n'y envoie rien). Le certificat vient de
// certificatEssai (openssl, à la volée).
import net from 'node:net';
import tls from 'node:tls';
import crypto from 'node:crypto';

export function makeMessage({ from, to, subject, body, encoded }) {
  const lines = [
    `Return-Path: <${from}>`, `Delivered-To: ${to}`, `From: ${from}`, `To: ${to}`,
    `Subject: ${subject}`, `Date: ${new Date().toUTCString()}`,
    `Message-ID: <${crypto.randomBytes(6).toString('hex')}@mock>`, 'MIME-Version: 1.0'
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

export function imapServer(messages, { badLogin = false, mode = 'tls', certificat = null } = {}) {
  const store = messages.map((m, i) => ({ uid: i + 1, raw: m, flags: [] }));
  const commandes = [];

  function servir(sock, chiffre) {
    sock.setEncoding('binary');
    let buf = '';
    sock.on('data', d => {
      buf += d;
      let i;
      while ((i = buf.indexOf('\r\n')) >= 0) {
        const line = buf.slice(0, i); buf = buf.slice(i + 2);
        const [tag, cmd, ...rest] = line.split(' ');
        const up = (cmd || '').toUpperCase();
        const arg = rest.join(' ');
        commandes.push({ chiffre, up });

        if (up === 'STARTTLS') {
          if (mode !== 'starttls' || chiffre) { sock.write(`${tag} BAD STARTTLS indisponible\r\n`); continue; }
          sock.write(`${tag} OK Begin TLS negotiation now\r\n`);
          sock.removeAllListeners('data');
          servir(new tls.TLSSocket(sock, { isServer: true, key: certificat.cle, cert: certificat.cert }), true);
          return;
        } else if (up === 'LOGIN') {
          if (badLogin) { sock.write(`${tag} NO [AUTHENTICATIONFAILED] mot de passe refusé\r\n`); continue; }
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
          sock.write(body.toString('binary'), 'binary');
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
  }

  const server = mode === 'tls'
    ? tls.createServer({ key: certificat.cle, cert: certificat.cert }, s => { s.write('* OK Mock IMAP ready\r\n'); servir(s, true); })
    : net.createServer(s => { s.write('* OK Mock IMAP ready\r\n'); servir(s, false); });
  server.on('tlsClientError', () => {});
  server.push = raw => store.push({ uid: store.length + 1, raw, flags: [] });
  server.commandes = commandes;
  server.ecouter = () => new Promise(r => server.listen(0, '127.0.0.1', () => r(server.address().port)));
  return server;
}
