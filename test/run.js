// Essais de CACHET : décodage, moteur de tickets et de règles, connexions
// IMAP et SMTP chiffrées, puis l'API de bout en bout sur le socle (comptes,
// rôles, clés, CSRF). Aucune dépendance : node test/run.js.
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import tls from 'node:tls';
import crypto from 'node:crypto';
import { imapServer, makeMessage } from './mocks.js';
import { certificatEssai, relaisEssai } from '../socle/essai/smtp.js';
import { Client } from '../socle/essai/client.js';
import { adminComplet, membreInvite } from '../socle/essai/inscription.js';
import * as mime from '../lib/mime.js';
import * as html from '../lib/html.js';
import * as tickets from '../lib/tickets.js';
import * as regles from '../lib/rules.js';
import * as smtp from '../lib/smtp.js';
import { Imap } from '../lib/imap.js';
import { normaliserEmpreinte, PREMIERE } from '../lib/tls.js';
import { signature } from '../lib/webhook.js';

let pass = 0, fail = 0;
async function t(nom, fn) {
  try { await fn(); console.log(`  ok  ${nom}`); pass++; }
  catch (e) { console.log(`  ÉCHEC  ${nom}\n        ${e.stack?.split('\n').slice(0, 3).join('\n        ') || e}`); fail++; }
}

// Un certificat d'essai, ajouté aux autorités de confiance du processus : le
// chemin « vérifié » se vérifie vraiment. Un second, jamais approuvé, sert aux
// refus et à l'épinglage.
const cert = certificatEssai('localhost');
const autre = certificatEssai('localhost');
const ailleurs = certificatEssai('ailleurs.example');
tls.setDefaultCACertificates([...tls.getCACertificates('default'), cert.cert, ailleurs.cert]);
const empreinteDe = pem => new crypto.X509Certificate(pem).fingerprint256;

console.log('\n── MIME et HTML ──');
await t('sujet encodé UTF-8 base64', () => {
  assert.equal(mime.decodeWords('=?UTF-8?B?w4ljaGVjIGRlIGxhIHNhdXZlZ2FyZGU=?='), 'Échec de la sauvegarde');
});
await t('sujet quoted-printable ISO-8859-1', () => {
  assert.equal(mime.decodeWords('=?ISO-8859-1?Q?H=F4te_inconnu?='), 'Hôte inconnu');
});
await t('adresse avec nom affiché', () => {
  const a = mime.addressOf('"Supervision" <noreply@exemple.fr>');
  assert.equal(a.addr, 'noreply@exemple.fr');
  assert.equal(a.name, 'Supervision');
});
await t('liste de destinataires', () => {
  assert.deepEqual(mime.addressList('a@x.fr, "B" <b@y.fr>'), ['a@x.fr', 'b@y.fr']);
});
await t('un nom affiché avec chevrons ou virgule ne prend pas la place de l\'adresse', () => {
  const a = mime.addressOf('"<admin@exemple.fr>" <sonde@exemple.fr>');
  assert.equal(a.addr, 'sonde@exemple.fr');
  assert.equal(a.name, '<admin@exemple.fr>');
  assert.deepEqual(mime.addressList('"Dupont, Jean" <j@x.fr>, "<b@y.fr>, c" <c@z.fr>'), ['j@x.fr', 'c@z.fr']);
});
await t('multipart : le texte brut gagne, le HTML est conservé à part', () => {
  const raw = makeMessage({ from: 'a@b.c', to: 'rmm@exemple.fr', subject: 'x', body: 'Agent hors ligne, réessai', encoded: 'multipart' });
  const r = mime.extractText(raw);
  assert.ok(r.text.includes('Agent hors ligne'), r.text);
  assert.ok(!r.text.includes('<p>'), 'du HTML a fuité dans le texte');
  assert.ok(r.html.includes('<a href'), 'la version HTML est perdue');
});
await t('corps base64 décodé', () => {
  const raw = makeMessage({ from: 'a@b.c', to: 'x@y.z', subject: 'x', body: 'Machine : srv01', encoded: 'b64' });
  assert.ok(mime.extractText(raw).text.includes('srv01'));
});
await t('le nettoyeur HTML garde la mise en forme et retire le reste', () => {
  const raw = makeMessage({ from: 'a@b.c', to: 'x@y.z', subject: 'x', body: 'suite', encoded: 'multipart' });
  const n = html.nettoie(mime.extractText(raw).html);
  assert.ok(/<b>/.test(n.html), 'le gras a disparu');
  assert.ok(/href="https:\/\/exemple\.fr\/t\/42"/.test(n.html), 'le lien a disparu');
  assert.ok(/rel="noopener/.test(n.html), 'le lien sort sans rel de sécurité');
  assert.ok(!/script/i.test(n.html), 'une balise script a survécu');
  assert.ok(!/onclick/i.test(n.html), 'un attribut onclick a survécu');
  assert.equal(n.imagesMasquees, 1, 'l\'image distante n\'a pas été comptée');
});
await t('les liens javascript: sont neutralisés', () => {
  assert.ok(!/href/.test(html.nettoie('<a href="javascript:vol()">x</a>').html));
  assert.ok(!/href/.test(html.nettoie('<a href="data:text/html,x">x</a>').html));
});
await t('balises imbriquées pour tromper le nettoyeur : rien ne survit', () => {
  for (const piege of ['<scr<script>ipt>alert(1)</script>', '<a href="x" onmouseover="vol()">x</a>', '<svg><script>x</script></svg>', '<img src=x onerror=vol()>', '<iframe src="https://e.fr"></iframe>']) {
    const n = html.nettoie(piege).html;
    assert.ok(!/<(script|svg|img|iframe)\b|on\w+=/i.test(n), `${piege} → ${n}`);
  }
});

console.log('\n── IMAP chiffré ──');
const msgs = [
  makeMessage({ from: 'noreply@sup.exemple.fr', to: 'rmm@exemple.fr', subject: 'Agent hors ligne sur srv01', body: 'Machine : srv01\nDurée : 11 minutes' }),
  makeMessage({ from: 'bot@conteneurs.exemple.fr', to: 'conteneurs@exemple.fr', subject: 'api redémarre en boucle', body: 'Machine : srv01\nCode : 137' }),
];
const imapSrv = imapServer(msgs, { mode: 'tls', certificat: cert });
const portImap = await imapSrv.ecouter();

await t('TLS implicite vérifié : login, select, search, fetch', async () => {
  const im = new Imap({ host: 'localhost', port: portImap, user: 'u', pass: 'p' });
  await im.connect(); await im.login();
  const box = await im.select('INBOX');
  assert.equal(box.exists, 2);
  const uids = await im.search('UNSEEN');
  assert.deepEqual(uids, [1, 2]);
  const fetched = await im.fetch(uids);
  assert.equal(fetched.length, 2);
  assert.ok(fetched[0].body.includes('Agent hors ligne'));
  await im.logout();
});

const imapAutre = imapServer([], { mode: 'tls', certificat: autre });
const portAutre = await imapAutre.ecouter();
await t('certificat auto-signé non épinglé : refusé, empreinte rendue, rien d\'envoyé', async () => {
  const im = new Imap({ host: 'localhost', port: portAutre, user: 'u', pass: 'p' });
  await assert.rejects(() => im.connect(), e => { assert.equal(e.empreinte, empreinteDe(autre.cert)); return true; });
  assert.ok(!imapAutre.commandes.some(c => c.up === 'LOGIN'), 'des identifiants sont partis');
});
await t('certificat épinglé : accepté ; empreinte différente : refusée', async () => {
  const ok = new Imap({ host: 'localhost', port: portAutre, user: 'u', pass: 'p', epingle: empreinteDe(autre.cert).replace(/:/g, '').toLowerCase() });
  await ok.connect(); await ok.login(); await ok.logout();
  const ko = new Imap({ host: 'localhost', port: portImap, user: 'u', pass: 'p', epingle: empreinteDe(autre.cert) });
  await assert.rejects(() => ko.connect(), /différent de celui épinglé/);
});
await t('reprise de « accepter un auto-signé » : la première empreinte vue est retenue', async () => {
  let retenue = null;
  const im = new Imap({ host: 'localhost', port: portAutre, user: 'u', pass: 'p', epingle: PREMIERE, surEpingle: v => { retenue = v; } });
  await im.connect(); await im.logout();
  assert.equal(retenue, empreinteDe(autre.cert));
  assert.equal(normaliserEmpreinte('zz'), null);
});

await t('certificat signé mais pour un autre nom : refusé', async () => {
  const srv = imapServer([], { mode: 'tls', certificat: ailleurs });
  const p = await srv.ecouter();
  const im = new Imap({ host: 'localhost', port: p, user: 'u', pass: 'p' });
  await assert.rejects(() => im.connect(), /certificat refusé \(ERR_TLS_CERT_ALTNAME_INVALID|Hostname/);
  srv.close();
});

const imapStart = imapServer(msgs, { mode: 'starttls', certificat: cert });
const portStart = await imapStart.ecouter();
await t('STARTTLS : chiffré avant le login', async () => {
  const im = new Imap({ host: 'localhost', port: portStart, user: 'u', pass: 'p', tls: false });
  await im.connect(); await im.login();
  assert.equal((await im.select('INBOX')).exists, 2);
  await im.logout();
  const login = imapStart.commandes.find(c => c.up === 'LOGIN');
  assert.ok(login && login.chiffre, 'LOGIN envoyé en clair');
});
const imapClair = imapServer(msgs, { mode: 'clair' });
const portClair = await imapClair.ecouter();
await t('serveur sans STARTTLS : connexion refusée, aucun mot de passe en clair', async () => {
  const im = new Imap({ host: 'localhost', port: portClair, user: 'u', pass: 'p', tls: false });
  await assert.rejects(() => im.connect(), /STARTTLS/);
  assert.ok(!imapClair.commandes.some(c => c.up === 'LOGIN'));
});
await t('mot de passe refusé : erreur lisible', async () => {
  const bad = imapServer([], { badLogin: true, mode: 'tls', certificat: cert });
  const p = await bad.ecouter();
  const im = new Imap({ host: 'localhost', port: p, user: 'u', pass: 'x' });
  await im.connect();
  await assert.rejects(() => im.login(), /AUTHENTICATIONFAILED|refusé/);
  im.close(); bad.close();
});
await t('un retour à la ligne ne fabrique pas de seconde commande IMAP', async () => {
  const im = new Imap({ host: 'localhost', port: portImap, user: 'u', pass: 'p' });
  await im.connect();
  await assert.rejects(() => im.select('INBOX"\r\nA9 DELETE "INBOX'), /invalide/);
  im.close();
});

console.log('\n── moteur de tickets ──');
const cfgT = {
  accounts: [{ addr: 'alertes@exemple.fr', aliases: [
    { addr: 'conteneurs@exemple.fr', svc: 'conteneurs', urg: 'crit', active: true },
    { addr: 'rmm@exemple.fr', svc: 'supervision', urg: 'haute', active: true },
    { addr: 'proxy@exemple.fr', svc: 'proxy', urg: 'basse', active: true },
  ] }],
  settings: { dedupMinutes: 30 },
};
const st = { tickets: [], messages: [], log: [], seq: 1 };
let nMsg = 0;
const mk = (to, subject, text) => ({ id: 'm' + (++nMsg), toList: [to], fromName: 'x', fromAddr: 'a@b.c', subject, text });

await t('l\'alias décide du service et de la machine', () => {
  const { ticket } = tickets.ingest({ config: cfgT, state: st, msg: mk('rmm@exemple.fr', 'Agent hors ligne sur srv01', 'Machine : srv01') });
  assert.equal(ticket.service, 'supervision');
  assert.equal(ticket.host, 'srv01');
  assert.equal(ticket.via, 'rmm@exemple.fr');
});
await t('un mot-clé monte l\'urgence mais ne la descend jamais', () => {
  assert.equal(tickets.classify(cfgT, mk('proxy@exemple.fr', 'Certificat renouvelé', 'tout va bien')).urgency, 'basse');
  assert.equal(tickets.classify(cfgT, mk('proxy@exemple.fr', 'Échec du renouvellement', 'erreur')).urgency, 'haute');
  assert.equal(tickets.classify(cfgT, mk('conteneurs@exemple.fr', 'Rapport quotidien', 'rien à signaler')).urgency, 'crit');
});
await t('dédoublonnage : la répétition incrémente', () => {
  const avant = st.tickets.length;
  const r = tickets.ingest({ config: cfgT, state: st, msg: mk('rmm@exemple.fr', 'Agent hors ligne sur srv01', 'Machine : srv01') });
  assert.equal(r.created, false);
  assert.equal(r.ticket.occurrences, 2);
  assert.equal(st.tickets.length, avant);
});
await t('une autre machine ouvre un second ticket', () => {
  assert.equal(tickets.ingest({ config: cfgT, state: st, msg: mk('rmm@exemple.fr', 'Agent hors ligne sur srv02', 'Machine : srv02') }).created, true);
});
await t('un ticket traité ne capte plus les nouvelles alertes', () => {
  st.tickets.forEach(x => { x.status = 'traite'; });
  assert.equal(tickets.ingest({ config: cfgT, state: st, msg: mk('rmm@exemple.fr', 'Agent hors ligne sur srv01', 'Machine : srv01') }).created, true);
});
await t('adresse hors alias : service inconnu, urgence normale', () => {
  const c = tickets.classify(cfgT, mk('autre@exemple.fr', 'Coucou', 'rien'));
  assert.equal(c.service, 'autre');
  assert.equal(c.urgency, 'normale');
});

console.log('\n── règles ──');
const msgR = { fromName: 'Proxy', fromAddr: 'noreply@proxy.exemple.fr', toList: ['proxy@exemple.fr'], subject: 'Certificat renouvelé', text: 'Machine : proxy\nRAS' };
await t('toutes les conditions, puis au moins une', () => {
  let d = regles.evalue({ rules: [{ enabled: true, name: 'R1',
    conditions: { mode: 'all', items: [{ champ: 'from', op: 'contient', valeur: 'proxy' }, { champ: 'subject', op: 'contient', valeur: 'certificat' }] },
    actions: { read: true, ticket: 'non' } }] }, msgR, 'proxy@exemple.fr');
  assert.deepEqual(d.reglesAppliquees, ['R1']);
  assert.equal(d.unread, false);
  assert.equal(d.ticket, 'non');
  d = regles.evalue({ rules: [{ enabled: true, name: 'R2',
    conditions: { mode: 'any', items: [{ champ: 'subject', op: 'contient', valeur: 'jamais' }, { champ: 'body', op: 'contient', valeur: 'ras' }] },
    actions: { urgency: 'crit' } }] }, msgR, null);
  assert.equal(d.urgence, 'crit');
});
await t('accents et casse ignorés', () => {
  const d = regles.evalue({ rules: [{ enabled: true, name: 'R3', conditions: { mode: 'all', items: [{ champ: 'subject', op: 'contient', valeur: 'RENOUVELE' }] }, actions: { delete: true } }] }, msgR, null);
  assert.equal(d.supprimer, true);
});
await t('« arrêter là » bloque les règles suivantes', () => {
  const d = regles.evalue({ rules: [
    { enabled: true, name: 'A', conditions: { mode: 'all', items: [{ champ: 'any', op: 'contient', valeur: 'proxy' }] }, actions: { stop: true, urgency: 'basse' } },
    { enabled: true, name: 'B', conditions: { mode: 'all', items: [{ champ: 'any', op: 'contient', valeur: 'proxy' }] }, actions: { urgency: 'crit' } },
  ] }, msgR, null);
  assert.deepEqual(d.reglesAppliquees, ['A']);
  assert.equal(d.urgence, 'basse');
});
await t('une règle désactivée ne joue pas, une regex invalide ne casse rien', () => {
  assert.equal(regles.evalue({ rules: [{ enabled: false, name: 'off', conditions: { mode: 'all', items: [{ champ: 'any', op: 'contient', valeur: 'proxy' }] }, actions: { delete: true } }] }, msgR, null).supprimer, false);
  assert.doesNotThrow(() => regles.evalue({ rules: [{ enabled: true, name: 'bad', conditions: { mode: 'all', items: [{ champ: 'subject', op: 'regex', valeur: '([' }] }, actions: { delete: true } }] }, msgR, null));
});
await t('une expression à retour arrière exponentiel n\'est jamais évaluée', () => {
  const piege = { ...msgR, subject: 'a'.repeat(40) + '!' };
  const debut = Date.now();
  const d = regles.evalue({ rules: [{ enabled: true, name: 'redos', conditions: { mode: 'all', items: [{ champ: 'subject', op: 'regex', valeur: '^(a+)+$' }] }, actions: { delete: true } }] }, piege, null);
  assert.equal(d.supprimer, false);
  assert.ok(Date.now() - debut < 200);
  assert.equal(regles.expressionSure('^(a+)+$'), null);
  assert.ok(regles.expressionSure('^alerte \\d+$'));
});

console.log('\n── SMTP chiffré ──');
const relais = await relaisEssai({ mode: 'starttls', certificat: cert, utilisateur: 'alertes@exemple.fr', motDePasse: 'MotDePasseTest#2026' });
const envoyer = o => smtp.send({ host: 'localhost', port: relais.port, user: 'alertes@exemple.fr', pass: 'MotDePasseTest#2026', ...o });
await t('envoi STARTTLS : en-têtes et corps corrects', async () => {
  await envoyer({ from: 'rmm@exemple.fr', fromName: 'Cachet', to: 'admin@exemple.fr', subject: 'Ticket pris en charge', text: 'On regarde ça.' });
  const got = (await relais.attendre(1)).at(-1);
  assert.equal(got.de, 'rmm@exemple.fr');
  assert.equal(got.a, 'admin@exemple.fr');
  assert.ok(got.entetes.includes('From: Cachet <rmm@exemple.fr>'));
  assert.equal(got.texte, 'On regarde ça.');
  assert.ok(!/EHLO [^\r\n]*\b(localhost|[0-9a-f]{12})\b/.test(got.entetes));
});
await t('sujet non-ASCII encodé RFC 2047', async () => {
  await envoyer({ from: 'rmm@exemple.fr', to: 'a@b.fr', subject: 'Échec relevé', text: 'x' });
  assert.equal((await relais.attendre(2)).at(-1).sujet, 'Échec relevé');
});
await t('un retour à la ligne ne fabrique ni en-tête ni commande SMTP', async () => {
  await assert.rejects(() => envoyer({ from: 'rmm@exemple.fr', to: 'a@b.fr>\r\nRCPT TO:<vol@ailleurs.fr', subject: 'x', text: 'x' }), /adresse invalide/);
  await assert.rejects(() => envoyer({ from: 'rmm@exemple.fr', to: 'a@b.fr', subject: 'x', text: 'x', inReplyTo: '<a@b>\r\nBcc: vol@ailleurs.fr' }), /identifiant/);
  const { data } = smtp.buildMessage({ from: 'rmm@exemple.fr', to: ['a@b.fr'], subject: 'x\r\nBcc: vol@ailleurs.fr', text: 'x' });
  assert.ok(!/^Bcc:/m.test(data), 'en-tête injecté');
});
const relaisClair = await relaisEssai({ mode: 'starttls', certificat: cert, sansStarttls: true });
await t('un refus 550 remonte tel quel', async () => {
  const refuse = tls.createServer({ key: cert.cle, cert: cert.cert }, s => {
    s.write('220 essai\r\n');
    let tampon = '';
    s.on('data', d => {
      tampon += d;
      for (let i = tampon.indexOf('\r\n'); i >= 0; i = tampon.indexOf('\r\n')) {
        const l = tampon.slice(0, i); tampon = tampon.slice(i + 2);
        if (/^EHLO/i.test(l)) s.write('250-essai\r\n250 AUTH PLAIN\r\n');
        else if (/^AUTH/i.test(l)) s.write('235 ok\r\n');
        else if (/^MAIL/i.test(l)) s.write('550 5.7.1 expéditeur non autorisé\r\n');
        else s.write('250 ok\r\n');
      }
    });
    s.on('error', () => {});
  });
  await new Promise(r => refuse.listen(0, '127.0.0.1', r));
  try {
    await assert.rejects(() => smtp.send({ host: 'localhost', port: refuse.address().port, secure: true, user: 'u', pass: 'p', from: 'interdit@exemple.fr', to: ['a@b.fr'], subject: 'x', text: 'x' }),
      e => { assert.equal(e.code, 550); assert.match(e.message, /non autorisé/); return true; });
  } finally { refuse.close(); }
});
await t('relais sans STARTTLS : rien ne part, pas même les identifiants', async () => {
  await assert.rejects(() => smtp.send({ host: 'localhost', port: relaisClair.port, user: 'u', pass: 'p', from: 'rmm@exemple.fr', to: 'a@b.fr', subject: 'x', text: 'x' }), /STARTTLS/);
  assert.equal(relaisClair.auths.length, 0);
});
const relaisTls = await relaisEssai({ mode: 'tls', certificat: autre, utilisateur: 'u', motDePasse: 'p' });
await t('TLS implicite (465) : auto-signé refusé, accepté une fois épinglé', async () => {
  const o = { host: 'localhost', port: relaisTls.port, secure: true, user: 'u', pass: 'p', from: 'rmm@exemple.fr', to: 'a@b.fr', subject: 'x', text: 'x' };
  await assert.rejects(() => smtp.send(o), e => e.empreinte === empreinteDe(autre.cert));
  await smtp.send({ ...o, epingle: empreinteDe(autre.cert) });
  assert.equal((await relaisTls.attendre(1)).length, 1);
});

console.log('\n── API bout en bout ──');
const { demarrer } = await import('../lib/serveur.js');
const dossier = fs.mkdtempSync(path.join(os.tmpdir(), 'cachet-essai-'));
const JETON_INSTALL = 'jeton-installation-des-essais-0123456789';
const JETON_HUB = 'jeton-du-hub-pour-les-essais-0123456789abc';
const muet = { info() {}, warn() {}, error: (...a) => console.error(...a) };
let app = await demarrer({ CACHET_DATA: dossier, PORT: '0', HOTE: '127.0.0.1', SOCLE_HTTP: '1', SOCLE_JETON_INSTALLATION: JETON_INSTALL, CACHET_HUB_TOKEN: JETON_HUB, SOCLE_ARGON2_M: '19456', SOCLE_ARGON2_T: '2', SOCLE_ARGON2_P: '1' }, { log: muet });
const port = () => app.serveur.address().port;
const base = () => `http://127.0.0.1:${port()}`;
const admin = new Client(port());
const cle = (k, chemin, o = {}) => fetch(base() + chemin, { ...o, headers: { 'x-cachet-key': k, ...(o.body ? { 'content-type': 'application/json' } : {}), ...(o.headers || {}) } });

await t('l\'API refuse sans session ; /api/health répond à tous', async () => {
  assert.equal((await new Client(port()).get('/api/state')).status, 401);
  const h = await fetch(base() + '/api/health');
  assert.equal(h.status, 200);
  assert.deepEqual(await h.json(), { ok: true });
});
await t('premier compte par le jeton d\'installation, puis lecture de l\'état', async () => {
  await adminComplet(admin, { jeton: JETON_INSTALL });
  const s = await admin.get('/api/state');
  assert.equal(s.status, 200);
  assert.ok(Array.isArray(s.json.accounts));
  assert.equal(s.json.version, '2.0.0');
});
await t('une écriture sans jeton anti-CSRF est refusée', async () => {
  assert.equal((await admin.post('/api/folders', { name: 'X' }, { sansCsrf: true })).status, 403);
});

let accId;
await t('création d\'une boîte à tickets avec ses alias', async () => {
  const r = await admin.post('/api/accounts', {
    name: 'Arrivée', addr: 'alertes@exemple.fr', kind: 'tickets',
    imapHost: 'localhost', imapPort: portImap, imapTls: true,
    smtpHost: 'localhost', smtpPort: relais.port,
    password: 'MotDePasseTest#2026', provider: 'manual',
    aliases: [
      { addr: 'conteneurs@exemple.fr', svc: 'conteneurs', urg: 'crit' },
      { addr: 'rmm@exemple.fr', svc: 'supervision', urg: 'haute' },
      { addr: 'proxy@exemple.fr', svc: 'proxy', urg: 'basse', send: false },
    ],
  });
  assert.equal(r.status, 201, JSON.stringify(r.json));
  accId = r.json.id;
  assert.equal(r.json.aliases.length, 3);
  assert.equal(r.json.imapPass, undefined, 'le mot de passe ne doit jamais sortir de l\'API');
});
await t('champ inconnu, port hors bornes, hôte piégé : refusés', async () => {
  assert.equal((await admin.patch(`/api/accounts/${accId}`, { admin: true })).status, 400);
  assert.equal((await admin.patch(`/api/accounts/${accId}`, { imapPort: 70000 })).status, 400);
  assert.equal((await admin.patch(`/api/accounts/${accId}`, { imapHost: 'a.fr\r\nX' })).status, 400);
  assert.equal((await admin.patch(`/api/accounts/${accId}`, { folder: 'INBOX"\r\nA1 DELETE' })).status, 400);
});
// Le renfort de l'administrateur retiré le temps d'un essai, puis rendu.
async function sansRenfort(fn) {
  const avant = app.db.prepare("SELECT id, renfort FROM socle_sessions WHERE compte = (SELECT id FROM socle_comptes WHERE identifiant = 'ana')").all();
  app.db.prepare("UPDATE socle_sessions SET renfort = 0 WHERE compte = (SELECT id FROM socle_comptes WHERE identifiant = 'ana')").run();
  try { return await fn(); } finally { for (const x of avant) app.db.prepare('UPDATE socle_sessions SET renfort = ? WHERE id = ?').run(x.renfort, x.id); }
}
await t('où part le mot de passe d\'une boîte : renfort exigé, métadonnées et plages réservées refusées', async () => {
  await sansRenfort(async () => {
    const r = await admin.patch(`/api/accounts/${accId}`, { imapHost: 'ailleurs.example' });
    assert.equal(r.status, 403);
    assert.equal(r.json.details?.renfort, true);
    assert.equal((await admin.patch(`/api/accounts/${accId}`, { password: 'autre' })).status, 403);
    assert.equal((await admin.post('/api/accounts', { addr: 'x@exemple.fr' })).status, 403);
    assert.equal((await admin.patch(`/api/accounts/${accId}`, { aliasOnly: false })).status, 200, 'un réglage sans destination reste libre');
    assert.equal((await admin.post('/api/rules', { name: 'x', conditions: { mode: 'all', items: [{ champ: 'any', op: 'contient', valeur: 'x' }] }, actions: { delete: true } })).status, 403, 'règle qui supprime sans renfort');
    assert.equal((await admin.post('/api/apikey/rotate')).status, 403, 'clé créée sans renfort');
  });
  assert.equal(app.depot.config.accounts[0].imapHost, 'localhost');
  for (const h of ['169.254.169.254', '0.0.0.0', '[fe80::1]']) assert.equal((await admin.patch(`/api/accounts/${accId}`, { imapHost: h })).status, 400, h);
  assert.equal((await admin.patch('/api/settings', { webhook: { url: 'http://169.254.169.254/latest/meta-data' } })).status, 400);
});
await t('le mot de passe est scellé dans la base, jamais en clair', async () => {
  app.depot.flush();
  const brut = fs.readFileSync(path.join(dossier, 'cachet.db')).toString('latin1') + (fs.existsSync(path.join(dossier, 'cachet.db-wal')) ? fs.readFileSync(path.join(dossier, 'cachet.db-wal')).toString('latin1') : '');
  assert.ok(!brut.includes('MotDePasseTest#2026'), 'mot de passe en clair');
  assert.match(app.depot.config.accounts[0].imapPass, /^v1\./);
});
await t('test de connexion IMAP par l\'API', async () => {
  const r = await admin.post(`/api/accounts/${accId}/test`);
  assert.equal(r.json.ok, true, r.json.error);
  assert.equal(r.json.messages, 2);
});
await t('la relève transforme les alertes en tickets', async () => {
  await admin.post('/api/poll');
  const s = await admin.get('/api/state');
  assert.equal(s.json.tickets.length, 2, JSON.stringify(s.json.poll));
  const rmm = s.json.tickets.find(x => x.via === 'rmm@exemple.fr');
  assert.equal(rmm.service, 'supervision');
  assert.equal(rmm.urgency, 'haute');
  const c = s.json.tickets.find(x => x.via === 'conteneurs@exemple.fr');
  assert.equal(c.urgency, 'crit');
  assert.equal(c.host, 'srv01');
});
await t('numéros de ticket et identifiants de message tirés au hasard, jamais suivis', async () => {
  const s = (await admin.get('/api/state')).json;
  for (const t of s.tickets) assert.match(t.id, /^TCK-[0-9A-HJKMNP-TV-Z]{6}$/);
  for (const m of s.messages.filter(x => !x.sent)) {
    assert.match(m.id, /^m-[\w-]{16}$/);
  }
  const cree = await admin.post('/api/tickets', { subject: 'à la main' });
  assert.match(cree.json.id, /^TCK-[0-9A-HJKMNP-TV-Z]{6}$/);
  await admin.del('/api/tickets/' + cree.json.id);
});
await t('une seconde relève ne rejoue pas les mêmes messages', async () => {
  const r = await admin.post('/api/poll');
  assert.equal(r.json.fetched, 0);
  assert.equal((await admin.get('/api/state')).json.messages.length, 2);
});
await t('une alerte identique incrémente le ticket', async () => {
  imapSrv.push(makeMessage({ from: 'noreply@sup.exemple.fr', to: 'rmm@exemple.fr', subject: 'Agent hors ligne sur srv01', body: 'Machine : srv01\nDurée : 19 minutes' }));
  await admin.post('/api/poll');
  const s = await admin.get('/api/state');
  assert.equal(s.json.tickets.length, 2, 'un doublon a créé un ticket de trop');
  assert.equal(s.json.tickets.find(x => x.via === 'rmm@exemple.fr').occurrences, 2);
});
await t('changement de statut historisé', async () => {
  const id = (await admin.get('/api/state')).json.tickets[0].id;
  const r = await admin.patch(`/api/tickets/${id}`, { status: 'cours' });
  assert.equal(r.json.status, 'cours');
  assert.ok(r.json.history.some(h => /statut/.test(h.what)));
});
await t('dossiers : création, déplacement, suppression', async () => {
  const c = await admin.post('/api/folders', { name: 'Archives été' });
  assert.equal(c.status, 201);
  assert.equal(c.json.id, 'archives-ete');
  assert.equal((await admin.post('/api/folders', { name: 'Archives été' })).status, 409);
  const msg = (await admin.get('/api/state')).json.messages[0];
  assert.equal((await admin.patch('/api/messages/' + encodeURIComponent(msg.id), { folder: 'archives-ete' })).json.folder, 'archives-ete');
  assert.equal((await admin.patch('/api/messages/' + encodeURIComponent(msg.id), { folder: 'nexistepas' })).status, 400);
  await admin.del('/api/folders/archives-ete');
  const apres = (await admin.get('/api/state')).json;
  assert.ok(apres.messages.some(m => m.id === msg.id), 'le message a disparu avec le dossier');
  assert.equal(apres.messages.find(m => m.id === msg.id).folder, null);
});
await t('un message se supprime sans emporter son ticket', async () => {
  const msg = (await admin.get('/api/state')).json.messages.find(m => m.ticketId);
  const sup = await admin.del('/api/messages/' + encodeURIComponent(msg.id));
  assert.equal(sup.json.ticketConserve, msg.ticketId);
  const apres = (await admin.get('/api/state')).json;
  assert.ok(!apres.messages.some(m => m.id === msg.id));
  assert.ok(apres.tickets.some(x => x.id === msg.ticketId), 'le ticket a été emporté');
});
await t('règles par l\'API, avec essai à blanc ; expression dangereuse refusée', async () => {
  const creee = await admin.post('/api/rules', { name: 'Certificats en sourdine', conditions: { mode: 'all', items: [{ champ: 'subject', op: 'contient', valeur: 'certificat' }] }, actions: { read: true, ticket: 'non' } });
  assert.equal(creee.status, 201);
  assert.equal((await admin.post('/api/rules', { name: 'Vide', conditions: { mode: 'all', items: [] }, actions: {} })).status, 400);
  assert.equal((await admin.post('/api/rules', { name: 'ReDoS', conditions: { mode: 'all', items: [{ champ: 'subject', op: 'regex', valeur: '(a+)+$' }] }, actions: {} })).status, 400);
  const essai = await admin.post('/api/rules/essai', { rule: { name: 'test', conditions: { mode: 'all', items: [{ champ: 'any', op: 'contient', valeur: 'srv01' }] }, actions: { urgency: 'crit' } } });
  assert.ok(essai.json.touches >= 1, JSON.stringify(essai.json));
  await admin.patch(`/api/rules/${creee.json.id}`, { enabled: false });
  assert.equal((await admin.get('/api/rules')).json.rules[0].enabled, false);
  await admin.del(`/api/rules/${creee.json.id}`);
  assert.equal((await admin.get('/api/rules')).json.rules.length, 0);
});
await t('une règle de suppression écarte le message à la relève', async () => {
  await admin.post('/api/rules', { name: 'Silence', conditions: { mode: 'all', items: [{ champ: 'subject', op: 'contient', valeur: 'publicité' }] }, actions: { delete: true } });
  const avant = (await admin.get('/api/state')).json.messages.length;
  imapSrv.push(makeMessage({ from: 'spam@ailleurs.fr', to: 'rmm@exemple.fr', subject: 'publicité du jour', body: 'achetez' }));
  await admin.post('/api/poll');
  const apres = (await admin.get('/api/state')).json;
  assert.equal(apres.messages.length, avant, 'le message aurait dû être écarté');
  assert.ok(apres.log.some(l => /supprimé par/.test(l.what)), 'aucune trace au journal');
});
await t('le filtre « alias seulement » écarte ce qui ne vise aucun alias', async () => {
  await admin.patch(`/api/accounts/${accId}`, { aliasOnly: true });
  const avant = (await admin.get('/api/state')).json.messages.length;
  imapSrv.push(makeMessage({ from: 'quelquun@ailleurs.fr', to: 'alertes@exemple.fr', subject: 'Message direct', body: 'Bonjour' }));
  await admin.post('/api/poll');
  const apres = (await admin.get('/api/state')).json;
  assert.equal(apres.messages.length, avant, 'un message hors alias a été conservé');
  assert.ok(apres.log.some(l => /aucun alias/.test(l.what)));
  await admin.patch(`/api/accounts/${accId}`, { aliasOnly: false });
});
await t('envoi depuis un alias autorisé, copie conservée', async () => {
  const avant = (await admin.get('/api/state')).json.messages.filter(m => m.sent).length;
  const r = await admin.post('/api/send', { from: 'rmm@exemple.fr', to: 'admin@exemple.fr, second@exemple.fr', subject: 'Trace de l\'envoi', text: 'Corps.' });
  assert.equal(r.status, 200, JSON.stringify(r.json));
  const apres = (await admin.get('/api/state')).json.messages.filter(m => m.sent);
  assert.equal(apres.length, avant + 1, 'aucune copie conservée');
  assert.deepEqual(apres[0].toList, ['admin@exemple.fr', 'second@exemple.fr']);
});
await t('un envoi rejoué sous la même clé ne part qu\'une fois', async () => {
  const avant = relais.boite.length;
  const corps = { from: 'rmm@exemple.fr', to: 'admin@exemple.fr', subject: 'Une seule fois', text: 'x' };
  const r1 = await admin.post('/api/send', corps, { entetes: { 'idempotency-key': 'essai-cle-unique-0001' } });
  assert.equal(r1.status, 200, JSON.stringify(r1.json));
  const r2 = await admin.post('/api/send', { ...corps, idempotencyKey: 'essai-cle-unique-0001' });
  assert.equal(r2.status, 200);
  assert.equal(r2.json.rejoue, true);
  assert.equal(r2.json.messageId, r1.json.messageId);
  await new Promise(r => setTimeout(r, 300));
  assert.equal(relais.boite.length, avant + 1, 'parti deux fois');
  assert.equal((await admin.post('/api/send', corps, { entetes: { 'idempotency-key': 'court' } })).status, 400);
});
await t('envoi refusé depuis un alias en réception seule', async () => {
  assert.equal((await admin.post('/api/send', { from: 'proxy@exemple.fr', to: 'a@b.fr', subject: 'x', text: 'x' })).status, 403);
});
await t('envoi refusé depuis une adresse étrangère', async () => {
  assert.equal((await admin.post('/api/send', { from: 'ailleurs@autre.fr', to: 'a@b.fr', subject: 'x', text: 'x' })).status, 400);
});
await t('les envois ne remontent pas comme des alertes', async () => {
  const r = await admin.get('/api/messages/detailed');
  assert.ok(!r.json.messages.some(m => m.subject === 'Trace de l\'envoi'));
  assert.ok((await admin.get('/api/messages?sent=1')).json.messages.every(m => m.sent));
});

console.log('\n── rôles ──');
const lecteur = await membreInvite(admin, () => new Client(port()), { identifiant: 'lea', role: 'lecture' });
const membre = await membreInvite(admin, () => new Client(port()), { identifiant: 'max', role: 'membre' });
await t('lecture : lit tout, n\'agit sur rien', async () => {
  assert.equal((await lecteur.client.get('/api/state')).status, 200);
  assert.equal((await lecteur.client.post('/api/tickets', { subject: 'x' })).status, 403);
  assert.equal((await lecteur.client.post('/api/poll')).status, 403);
  assert.equal((await lecteur.client.post('/api/send', { from: 'rmm@exemple.fr', to: 'a@b.fr', subject: 'x' })).status, 403);
});
await t('membre : traite le courrier, ne touche ni boîtes, ni règles, ni réglages, ni clés', async () => {
  assert.equal((await membre.client.post('/api/tickets', { subject: 'Ouvert par un membre' })).status, 201);
  assert.equal((await membre.client.post('/api/accounts', { addr: 'x@exemple.fr' })).status, 403);
  assert.equal((await membre.client.patch(`/api/accounts/${accId}`, { name: 'x' })).status, 403);
  assert.equal((await membre.client.post('/api/rules', { name: 'x', conditions: { mode: 'all', items: [{ champ: 'any', op: 'contient', valeur: 'x' }] } })).status, 403);
  assert.equal((await membre.client.patch('/api/settings', { pollSeconds: 60 })).status, 403);
  assert.equal((await membre.client.get('/api/apikey')).status, 403);
});

await t('balayage : chaque route exige sa preuve et son rôle, déclarés comme vérifiés', async () => {
  const RANG = { lecture: 0, membre: 1, admin: 2 };
  const routes = app.api.routeur.routes;
  assert.ok(routes.length >= 40, `${routes.length} routes`);
  const publiques = routes.filter(r => r.options.public).map(r => `${r.methode} ${r.re.source.replace(/\\\//g, '/')}`);
  assert.deepEqual(publiques, ['GET ^/api/health$'], 'route publique imprévue');
  const anonyme = new Client(port());
  for (const r of routes.filter(x => !x.options.public)) {
    const chemin = r.re.source.slice(1, -1).replace(/\\\//g, '/').replace(/\(\[\^\/\]\+\)/g, 'x').replace(/\\(.)/g, '$1');
    const ecrit = r.methode !== 'GET';
    assert.ok(RANG[r.options.role] !== undefined, `${r.methode} ${chemin} sans rôle déclaré`);
    assert.equal((await anonyme.req(r.methode, chemin, ecrit ? {} : undefined)).status, 401, `${r.methode} ${chemin} sans preuve`);
    if (RANG[r.options.role] > RANG.lecture) assert.equal((await lecteur.client.req(r.methode, chemin, ecrit ? {} : undefined)).status, 403, `${r.methode} ${chemin} en lecture`);
    if (RANG[r.options.role] > RANG.membre) assert.equal((await membre.client.req(r.methode, chemin, ecrit ? {} : undefined)).status, 403, `${r.methode} ${chemin} en membre`);
  }
});

console.log('\n── clés, jeton du Hub, CORS, webhook ──');
let cleComplete, cleEnvoi;
await t('une clé d\'API se voit une fois, à sa création (renfort) ; seule son empreinte est gardée', async () => {
  assert.deepEqual((await admin.get('/api/apikey')).json.cles, { complete: false, envoi: false }, 'aucune clé avant que l\'administrateur la crée');
  await sansRenfort(async () => assert.equal((await admin.post('/api/apikey/rotate')).status, 403));
  const r = await admin.post('/api/apikey/rotate');
  const s = await admin.post('/api/apikey/rotate?quoi=envoi');
  assert.match(r.json.key, /^pk_[A-Za-z0-9_-]{32}$/);
  assert.match(s.json.sendKey, /^sk_[A-Za-z0-9_-]{32}$/);
  cleComplete = r.json.key; cleEnvoi = s.json.sendKey;
  const relue = await admin.get('/api/apikey');
  assert.deepEqual(relue.json.cles, { complete: true, envoi: true });
  assert.ok(!JSON.stringify(relue.json).includes(cleComplete) && !JSON.stringify((await admin.get('/api/state')).json).includes(cleComplete), 'la clé ressort de l\'API');
  app.depot.flush();
  const base = ['cachet.db', 'cachet.db-wal'].map(f => path.join(dossier, f)).filter(f => fs.existsSync(f)).map(f => fs.readFileSync(f).toString('latin1')).join('');
  assert.ok(!base.includes(cleComplete) && !base.includes(cleEnvoi), 'une clé d\'API en clair dans la base');
  assert.match(app.depot.config.settings.api.key, /^sha256:[0-9a-f]{64}$/);
});
await t('la clé complète traite le courrier sans cookie', async () => {
  assert.equal((await cle(cleComplete, '/api/state')).status, 200);
  assert.equal((await cle(cleComplete, '/api/tickets', { method: 'POST', body: JSON.stringify({ subject: 'par clé' }) })).status, 201);
});
await t('aucune clé ne gère les boîtes, les règles, les réglages ni les clés', async () => {
  assert.equal((await cle(cleComplete, '/api/apikey')).status, 403);
  assert.equal((await cle(cleComplete, '/api/accounts/' + accId, { method: 'DELETE' })).status, 403);
  assert.equal((await cle(cleComplete, '/api/settings', { method: 'PATCH', body: JSON.stringify({ webhook: { url: 'https://ailleurs.fr' } }) })).status, 403);
  assert.equal((await cle(cleComplete, '/api/rules', { method: 'POST', body: '{}' })).status, 403);
});
await t('la clé d\'envoi n\'ouvre que la route d\'envoi', async () => {
  assert.equal((await cle(cleEnvoi, '/api/state')).status, 401);
  assert.equal((await cle(cleEnvoi, '/api/tickets')).status, 401);
  assert.equal((await cle(cleEnvoi, '/api/accounts/' + accId, { method: 'DELETE' })).status, 403);
  const envoi = await cle(cleEnvoi, '/api/send', { method: 'POST', body: JSON.stringify({ from: 'rmm@exemple.fr', to: 'a@b.fr', subject: 'via cle envoi', text: 'x' }) });
  assert.equal(envoi.status, 200, await envoi.text());
});
await t('le jeton du Hub vaut la clé complète ; un jeton dérivé ne fait que lire', async () => {
  assert.equal((await cle(JETON_HUB, '/api/summary')).status, 200);
  assert.equal((await cle(JETON_HUB, '/api/accounts/' + accId, { method: 'PATCH', body: '{}' })).status, 403);
  const derive = 'cer_aselia_' + crypto.createHmac('sha256', JETON_HUB).update('cerveau:aselia').digest('hex');
  const s = await cle(derive, '/api/summary');
  assert.equal(s.status, 200);
  assert.equal(typeof (await s.json()).tickets_ouverts, 'number');
  assert.equal((await cle(derive, '/api/tickets', { method: 'POST', body: JSON.stringify({ subject: 'x' }) })).status, 401);
  const faux = 'cer_aselia_' + '0'.repeat(64);
  assert.equal((await cle(faux, '/api/summary')).status, 401);
});
await t('une mauvaise clé est refusée et comptée', async () => {
  assert.equal((await cle('pk_faux', '/api/state')).status, 401);
});
await t('une clé tournée cesse aussitôt (renfort exigé)', async () => {
  const r = await admin.post('/api/apikey/rotate?quoi=envoi');
  assert.equal(r.status, 200, JSON.stringify(r.json));
  assert.equal((await cle(cleEnvoi, '/api/send', { method: 'POST', body: '{}' })).status, 401);
  cleEnvoi = r.json.sendKey;
});
await t('CORS : refusé tant que l\'origine n\'est pas déclarée, jamais « * » ni de cookie', async () => {
  const avant = await fetch(base() + '/api/state', { method: 'OPTIONS', headers: { origin: 'http://front.exemple:9000' } });
  assert.equal(avant.status, 403);
  assert.equal((await admin.patch('/api/settings', { api: { origins: ['*'] } })).status, 400);
  assert.equal((await admin.patch('/api/settings', { api: { origins: ['http://front.exemple:9000'] } })).status, 200);
  const pre = await fetch(base() + '/api/state', { method: 'OPTIONS', headers: { origin: 'http://front.exemple:9000' } });
  assert.equal(pre.status, 204);
  assert.equal(pre.headers.get('access-control-allow-origin'), 'http://front.exemple:9000');
  assert.equal(pre.headers.get('access-control-allow-credentials'), null);
  assert.ok(/x-cachet-key/.test(pre.headers.get('access-control-allow-headers')));
});
await t('le webhook part signé, avec l\'en-tête demandé', async () => {
  const recus = [];
  const srv = http.createServer((rq, rs) => {
    let d = '';
    rq.on('data', c => { d += c; });
    rq.on('end', () => { recus.push({ entetes: rq.headers, corps: JSON.parse(d) }); rs.writeHead(200).end('{}'); });
  });
  await new Promise(r => srv.listen(0, '127.0.0.1', r));
  assert.equal((await admin.patch('/api/settings', { webhook: { url: 'file:///etc/passwd' } })).status, 400);
  const r = await admin.patch('/api/settings', { webhook: { enabled: true, url: `http://127.0.0.1:${srv.address().port}/hook`, key: 'cle-tierce', keyHeader: 'x-service-key', secret: 'hmac-partage' } });
  assert.equal(r.status, 200, JSON.stringify(r.json));
  await admin.post('/api/tickets', { subject: 'Essai webhook', service: 'Cachet', urgency: 'haute' });
  await new Promise(fin => setTimeout(fin, 300));
  assert.equal(recus.length, 1, 'aucun appel reçu');
  assert.equal(recus[0].corps.event, 'ticket.created');
  assert.equal(recus[0].entetes['x-service-key'], 'cle-tierce');
  assert.equal(recus[0].entetes['x-cachet-key'], undefined, 'l\'en-tête par défaut traîne encore');
  assert.equal(recus[0].entetes['x-cachet-signature'], signature(JSON.stringify(recus[0].corps), 'hmac-partage'));
  srv.close();
  await admin.patch('/api/settings', { webhook: { enabled: false } });
});
await t('une redirection du webhook n\'est jamais suivie', async () => {
  let suivie = 0;
  const cible = http.createServer((rq, rs) => { suivie++; rs.end(); });
  await new Promise(r => cible.listen(0, '127.0.0.1', r));
  const renvoi = http.createServer((rq, rs) => { rq.resume(); rs.writeHead(307, { location: `http://127.0.0.1:${cible.address().port}/vol` }).end(); });
  await new Promise(r => renvoi.listen(0, '127.0.0.1', r));
  await admin.patch('/api/settings', { webhook: { enabled: true, url: `http://127.0.0.1:${renvoi.address().port}/hook` } });
  const r = await admin.post('/api/webhook/test');
  assert.equal(r.json.ok, false);
  assert.equal(r.json.status, 307);
  assert.equal(suivie, 0, 'redirection suivie');
  cible.close(); renvoi.close();
  await admin.patch('/api/settings', { webhook: { enabled: false } });
});
await t('Telegram : un jeton de forme invalide est refusé', async () => {
  assert.equal((await admin.patch('/api/settings', { telegram: { token: '../../x' } })).status, 400);
});

console.log('\n── divers ──');
await t('l\'état rendu à l\'interface est borné : mille tickets au plus', async () => {
  const avant = app.depot.state.tickets;
  app.depot.state.tickets = Array.from({ length: 1200 }, (_, i) => ({ id: 'TCK-ESSAI' + i, status: 'nouveau', urgency: 'basse', service: 'x', subject: 's', history: [], updatedAt: new Date().toISOString() }));
  try {
    const s = (await admin.get('/api/state')).json;
    assert.equal(s.tickets.length, 1000);
    assert.equal(s.tickets[0].id, 'TCK-ESSAI0');
    assert.equal((await admin.get('/api/tickets?limit=100000')).json.tickets.length, 1000);
  } finally { app.depot.state.tickets = avant; }
});
await t('l\'accusé de réception accepte plusieurs formes, borné', async () => {
  const liste = (await admin.get('/api/messages/detailed')).json.messages;
  assert.equal((await admin.post('/api/ack', { ids: [liste[0].id] })).json.acquittes, 1);
  const deux = liste[1] ? liste[1].id : liste[0].id;
  assert.equal((await admin.req('POST', '/api/ack', [deux])).json.acquittes, 1);
  const r = await admin.post('/api/ack', { messageIds: ['inexistant'] });
  assert.equal(r.json.acquittes, 0);
  assert.deepEqual(r.json.inconnus, ['inexistant']);
  assert.equal((await admin.post('/api/ack', { ids: Array.from({ length: 501 }, (_, i) => 'x' + i) })).status, 400);
});
await t('une route inconnue explique ce qui a été demandé', async () => {
  const r = await admin.get('/api/nimportequoi');
  assert.equal(r.status, 404);
  assert.equal(r.json.path, '/api/nimportequoi');
  assert.ok(/GET \/api/.test(r.json.hint));
});
await t('un préfixe client retombe sur la route équivalente, avec les mêmes droits', async () => {
  const r = await cle(cleComplete, '/api/monservice/ping');
  assert.equal(r.status, 200);
  assert.equal((await r.json()).ok, true);
  assert.equal((await cle(cleComplete, '/api/monservice/apikey')).status, 403);
});
await t('/api et /api/ping répondent en JSON', async () => {
  const i = await admin.get('/api');
  assert.ok(Array.isArray(i.json.routes) && i.json.routes.length > 10);
  assert.equal((await admin.get('/api/ping')).json.service, 'cachet');
});
await t('la page porte la version et la gamme, la CSP interdit le script en ligne', async () => {
  const r = await fetch(base() + '/');
  const page = await r.text();
  assert.match(page, /src="\/app\.js\?v=2\.0\.0"/);
  assert.match(page, /href="\/app\.css\?v=2\.0\.0"/);
  assert.match(page, /data-gamme="soma"/);
  assert.equal(r.headers.get('cache-control'), 'no-store');
  const csp = r.headers.get('content-security-policy');
  assert.match(csp, /script-src 'self' 'nonce-/);
  assert.doesNotMatch(csp, /unsafe-inline/);
  assert.doesNotMatch(page, /style="|fonts\.googleapis|onclick=/);
  const ico = await fetch(base() + '/favicon.ico');
  assert.equal(ico.headers.get('content-type'), 'image/x-icon');
});
await t('l\'interface ne lit aucune valeur comme du HTML : gabarits du socle seulement', () => {
  const code = fs.readFileSync(new URL('../public/app.js', import.meta.url), 'utf8');
  assert.doesNotMatch(code, /\.(innerHTML|outerHTML)\s*=|insertAdjacentHTML|document\.write|\beval\(|new Function/);
  assert.match(code, /import \{ html, poser \} from '\/socle\/gabarit\.js'/);
});
await t('le rattrapage ouvre les tickets des messages orphelins', async () => {
  const avant = (await admin.get('/api/state')).json;
  const cible = avant.messages.find(m => m.ticketId && !m.sent);
  await admin.del('/api/tickets/' + cible.ticketId);
  const r = await admin.post('/api/tickets/backfill');
  assert.ok(r.json.examines >= 1, JSON.stringify(r.json));
  assert.ok((await admin.get('/api/state')).json.messages.find(m => m.id === cible.id).ticketId, 'le message est resté sans ticket');
});
await t('clés fausses : chaque échec compte pour l\'adresse, bloquée après dix, à part des connexions humaines', async () => {
  // Les clés fausses des essais précédents ont déjà compté : on repart de zéro.
  app.socle.limiteur.liberer('ip:machine:127.0.0.1');
  try {
    const codes = [];
    for (let i = 0; i < 12; i++) codes.push((await cle('pk_' + 'x'.repeat(32) + i, '/api/state')).status);
    assert.deepEqual(codes, [...Array(10).fill(401), 429, 429], codes.join(' '));
    assert.equal((await cle(cleComplete, '/api/state')).status, 429, 'la bonne clé passe aussi par le verrou de l\'adresse');
    assert.equal((await admin.get('/api/state')).status, 200, 'les sessions humaines restent ouvertes');
  } finally { app.socle.limiteur.liberer('ip:machine:127.0.0.1'); }
  assert.equal((await cle(cleComplete, '/api/state')).status, 200);
});
await t('les données survivent à un redémarrage', async () => {
  const tickets1 = (await admin.get('/api/state')).json.tickets.length;
  await app.arreter();
  app = await demarrer({ CACHET_DATA: dossier, PORT: '0', HOTE: '127.0.0.1', SOCLE_HTTP: '1', CACHET_HUB_TOKEN: JETON_HUB, SOCLE_ARGON2_M: '19456', SOCLE_ARGON2_T: '2', SOCLE_ARGON2_P: '1' }, { log: muet });
  const s = await (await cle(JETON_HUB, '/api/state')).json();
  assert.equal(s.tickets.length, tickets1);
  assert.equal(Object.keys(s.accounts).length, 1);
});
await t('le journal de sécurité garde les gestes sensibles', async () => {
  const actions = app.db.prepare('SELECT action FROM socle_journal').all().map(l => l.action);
  for (const a of ['boite.ajoutee', 'regle.creee', 'cle.tournee', 'reglages.modifies', 'courriel.envoye', 'connexion.cle']) assert.ok(actions.includes(a), `${a} absent`);
});

console.log('\n── reprise d\'une 1.0 ──');
await t('config.json et state.json repris, secrets rescellés, auto-signé épinglé à la première connexion', async () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'cachet-v1-'));
  const secretV1 = crypto.randomBytes(32).toString('hex');
  const cleV1 = crypto.createHash('sha256').update(secretV1).digest();
  const enc = v => { const iv = crypto.randomBytes(12); const c = crypto.createCipheriv('aes-256-gcm', cleV1, iv); const o = Buffer.concat([c.update(v, 'utf8'), c.final()]); return 'enc:' + Buffer.concat([iv, c.getAuthTag(), o]).toString('base64'); };
  fs.writeFileSync(path.join(d, 'config.json'), JSON.stringify({
    admin: { password: 'scrypt$x$y', totp: '' },
    accounts: [{ id: 'a1', name: 'Ancienne', addr: 'alertes@exemple.fr', kind: 'tickets', imapHost: 'localhost', imapPort: portAutre, imapTls: true, insecureTls: true, imapPass: enc('ancien-mdp'), aliases: [] }],
    folders: [], rules: [], settings: { api: { key: enc('pk_ancienne'), sendKey: enc('sk_ancienne'), origins: [] }, webhook: { enabled: false, url: '', key: '', secret: '' }, telegram: { enabled: false, token: '', chatId: '' } },
  }));
  fs.writeFileSync(path.join(d, 'state.json'), JSON.stringify({ messages: [], tickets: [{ id: 'TCK-0007', subject: 'repris', status: 'nouveau', urgency: 'haute', service: 'x', history: [], updatedAt: new Date().toISOString() }], log: [], seq: 8, uidState: {}, rescan: {} }));
  const v1 = await demarrer({ CACHET_DATA: d, PORT: '0', HOTE: '127.0.0.1', SOCLE_HTTP: '1', CACHET_SECRET_V1: secretV1, SOCLE_ARGON2_M: '19456', SOCLE_ARGON2_T: '2', SOCLE_ARGON2_P: '1' }, { log: muet });
  try {
    const acc = v1.depot.config.accounts[0];
    assert.equal(v1.depot.motDePasse(acc), 'ancien-mdp');
    assert.equal(v1.depot.quelleCle('pk_ancienne'), 'complete', 'la clé d\'API a changé : Aselia perdrait l\'accès');
    assert.equal(v1.depot.quelleCle('sk_ancienne'), 'envoi');
    assert.match(v1.depot.config.settings.api.key, /^sha256:/, 'la clé reprise est gardée en clair');
    assert.equal(acc.imapPin, PREMIERE);
    assert.equal(acc.insecureTls, undefined);
    assert.equal(v1.depot.config.admin, undefined, 'le mot de passe unique de la 1.0 a survécu');
    assert.equal(v1.depot.state.tickets[0].id, 'TCK-0007');
    assert.ok(!fs.existsSync(path.join(d, 'config.json')));
    await v1.releve.pollAll();
    assert.equal(acc.imapPin, empreinteDe(autre.cert), 'empreinte non retenue');
  } finally { await v1.arreter(); }
});

await t('une rafale reçoit 429, avec les en-têtes de sécurité', async () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'cachet-rafale-'));
  const r = await demarrer({ CACHET_DATA: d, PORT: '0', HOTE: '127.0.0.1', SOCLE_HTTP: '1', SOCLE_ARGON2_M: '19456', SOCLE_ARGON2_T: '2', SOCLE_ARGON2_P: '1' }, { log: muet });
  try {
    const url = `http://127.0.0.1:${r.serveur.address().port}/api/health`;
    let refus = null;
    for (let lot = 0; lot < 20 && !refus; lot++) {
      const reponses = await Promise.all(Array.from({ length: 50 }, () => fetch(url)));
      refus = reponses.find(x => x.status === 429) || null;
      await Promise.all(reponses.map(x => x.arrayBuffer()));
    }
    assert.ok(refus, 'aucun 429 après mille requêtes');
    assert.match(refus.headers.get('content-security-policy') || '', /default-src 'none'|script-src/);
    assert.equal(refus.headers.get('x-content-type-options'), 'nosniff');
  } finally { await r.arreter(); }
});

console.log(`\n${pass} réussis, ${fail} échoués\n`);
await app.arreter();
for (const s of [imapSrv, imapAutre, imapStart, imapClair]) s.close();
await Promise.all([relais.fermer(), relaisClair.fermer(), relaisTls.fermer()]);
process.exit(fail ? 1 : 0);
