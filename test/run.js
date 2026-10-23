'use strict';
process.env.CACHET_SECRET = process.env.CACHET_SECRET || 'secret-de-test-aaaaaaaaaaaaaaaaaaaa';
process.env.CACHET_DATA = '/tmp/cachet-test-' + Date.now();
process.env.CACHET_PASSWORD = 'motdepassetest';
process.env.CACHET_INSECURE_COOKIE = '1';
process.env.PORT = '8899';

const assert = require('node:assert');
const { imapServer, smtpServer, makeMessage } = require('./mocks');

let pass = 0, fail = 0;
async function t(nom, fn) {
  try { await fn(); console.log(`  ok  ${nom}`); pass++; }
  catch (e) { console.log(`  ÉCHEC  ${nom}\n        ${e.message}`); fail++; }
}

(async () => {
  console.log('\n── MIME et HTML ──');
  const mime = require('../lib/mime');
  const html = require('../lib/html');

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

  console.log('\n── IMAP ──');
  const { Imap } = require('../lib/imap');
  const msgs = [
    makeMessage({ from: 'noreply@sup.exemple.fr', to: 'rmm@exemple.fr', subject: 'Agent hors ligne sur srv01', body: 'Machine : srv01\nDurée : 11 minutes' }),
    makeMessage({ from: 'bot@conteneurs.exemple.fr', to: 'conteneurs@exemple.fr', subject: 'api redémarre en boucle', body: 'Machine : srv01\nCode : 137' })
  ];
  const imapSrv = imapServer(msgs);
  await new Promise(r => imapSrv.listen(9993, '127.0.0.1', r));

  await t('connexion, login, select, search, fetch', async () => {
    const im = new Imap({ host: '127.0.0.1', port: 9993, user: 'u', pass: 'p', tls: false });
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

  await t('mot de passe refusé : erreur lisible', async () => {
    const bad = imapServer([], { badLogin: true });
    await new Promise(r => bad.listen(9994, '127.0.0.1', r));
    const im = new Imap({ host: '127.0.0.1', port: 9994, user: 'u', pass: 'x', tls: false });
    await im.connect();
    await assert.rejects(() => im.login(), /AUTHENTICATIONFAILED|refusé/);
    im.close(); bad.close();
  });

  console.log('\n── moteur de tickets ──');
  const tickets = require('../lib/tickets');
  const cfg = {
    accounts: [{ addr: 'alertes@exemple.fr', aliases: [
      { addr: 'conteneurs@exemple.fr', svc: 'conteneurs', urg: 'crit', active: true },
      { addr: 'rmm@exemple.fr', svc: 'supervision', urg: 'haute', active: true },
      { addr: 'proxy@exemple.fr', svc: 'proxy', urg: 'basse', active: true }
    ] }],
    settings: { dedupMinutes: 30 }
  };
  const st = { tickets: [], messages: [], log: [], seq: 1 };
  const mk = (to, subject, text) => ({ id: 'm' + Math.random(), toList: [to], fromName: 'x', fromAddr: 'a@b.c', subject, text });

  await t('l\'alias décide du service et de la machine', () => {
    const { ticket } = tickets.ingest({ config: cfg, state: st, msg: mk('rmm@exemple.fr', 'Agent hors ligne sur srv01', 'Machine : srv01') });
    assert.equal(ticket.service, 'supervision');
    assert.equal(ticket.host, 'srv01');
    assert.equal(ticket.via, 'rmm@exemple.fr');
  });
  await t('un mot-clé monte l\'urgence mais ne la descend jamais', () => {
    assert.equal(tickets.classify(cfg, mk('proxy@exemple.fr', 'Certificat renouvelé', 'tout va bien')).urgency, 'basse');
    assert.equal(tickets.classify(cfg, mk('proxy@exemple.fr', 'Échec du renouvellement', 'erreur')).urgency, 'haute');
    assert.equal(tickets.classify(cfg, mk('conteneurs@exemple.fr', 'Rapport quotidien', 'rien à signaler')).urgency, 'crit');
  });
  await t('dédoublonnage : la répétition incrémente', () => {
    const avant = st.tickets.length;
    const r = tickets.ingest({ config: cfg, state: st, msg: mk('rmm@exemple.fr', 'Agent hors ligne sur srv01', 'Machine : srv01') });
    assert.equal(r.created, false);
    assert.equal(r.ticket.occurrences, 2);
    assert.equal(st.tickets.length, avant);
  });
  await t('une autre machine ouvre un second ticket', () => {
    assert.equal(tickets.ingest({ config: cfg, state: st, msg: mk('rmm@exemple.fr', 'Agent hors ligne sur srv02', 'Machine : srv02') }).created, true);
  });
  await t('un ticket traité ne capte plus les nouvelles alertes', () => {
    st.tickets.forEach(x => { x.status = 'traite'; });
    assert.equal(tickets.ingest({ config: cfg, state: st, msg: mk('rmm@exemple.fr', 'Agent hors ligne sur srv01', 'Machine : srv01') }).created, true);
  });
  await t('adresse hors alias : service inconnu, urgence normale', () => {
    const c = tickets.classify(cfg, mk('autre@exemple.fr', 'Coucou', 'rien'));
    assert.equal(c.service, 'autre');
    assert.equal(c.urgency, 'normale');
  });

  console.log('\n── règles ──');
  const regles = require('../lib/rules');
  const msgR = { fromName: 'Proxy', fromAddr: 'noreply@proxy.exemple.fr',
    toList: ['proxy@exemple.fr'], subject: 'Certificat renouvelé', text: 'Machine : proxy\nRAS' };

  await t('toutes les conditions, puis au moins une', () => {
    let d = regles.evalue({ rules: [{ enabled: true, name: 'R1',
      conditions: { mode: 'all', items: [
        { champ: 'from', op: 'contient', valeur: 'proxy' },
        { champ: 'subject', op: 'contient', valeur: 'certificat' }] },
      actions: { read: true, ticket: 'non' } }] }, msgR, 'proxy@exemple.fr');
    assert.deepEqual(d.reglesAppliquees, ['R1']);
    assert.equal(d.unread, false);
    assert.equal(d.ticket, 'non');

    d = regles.evalue({ rules: [{ enabled: true, name: 'R2',
      conditions: { mode: 'any', items: [
        { champ: 'subject', op: 'contient', valeur: 'jamais' },
        { champ: 'body', op: 'contient', valeur: 'ras' }] },
      actions: { urgency: 'crit' } }] }, msgR, null);
    assert.equal(d.urgence, 'crit');
  });
  await t('accents et casse ignorés', () => {
    const d = regles.evalue({ rules: [{ enabled: true, name: 'R3',
      conditions: { mode: 'all', items: [{ champ: 'subject', op: 'contient', valeur: 'RENOUVELE' }] },
      actions: { delete: true } }] }, msgR, null);
    assert.equal(d.supprimer, true);
  });
  await t('« arrêter là » bloque les règles suivantes', () => {
    const d = regles.evalue({ rules: [
      { enabled: true, name: 'A', conditions: { mode: 'all', items: [{ champ: 'any', op: 'contient', valeur: 'proxy' }] }, actions: { stop: true, urgency: 'basse' } },
      { enabled: true, name: 'B', conditions: { mode: 'all', items: [{ champ: 'any', op: 'contient', valeur: 'proxy' }] }, actions: { urgency: 'crit' } }
    ] }, msgR, null);
    assert.deepEqual(d.reglesAppliquees, ['A']);
    assert.equal(d.urgence, 'basse');
  });
  await t('une règle désactivée ne joue pas, une regex invalide ne casse rien', () => {
    assert.equal(regles.evalue({ rules: [{ enabled: false, name: 'off',
      conditions: { mode: 'all', items: [{ champ: 'any', op: 'contient', valeur: 'proxy' }] },
      actions: { delete: true } }] }, msgR, null).supprimer, false);
    assert.doesNotThrow(() => regles.evalue({ rules: [{ enabled: true, name: 'bad',
      conditions: { mode: 'all', items: [{ champ: 'subject', op: 'regex', valeur: '([' }] },
      actions: { delete: true } }] }, msgR, null));
  });

  console.log('\n── SMTP ──');
  const smtp = require('../lib/smtp');
  const smtpSrv = smtpServer({ rejectFrom: 'interdit@exemple.fr' });
  await new Promise(r => smtpSrv.listen(9587, '127.0.0.1', r));

  await t('envoi : en-têtes et corps corrects', async () => {
    await smtp.send({ host: '127.0.0.1', port: 9587, user: 'u', pass: 'p', secure: false,
      from: 'rmm@exemple.fr', fromName: 'Cachet', to: 'admin@exemple.fr',
      subject: 'Ticket pris en charge', text: 'On regarde ça.' });
    const got = smtpSrv.received.at(-1);
    assert.equal(got.from, 'rmm@exemple.fr');
    assert.deepEqual(got.to, ['admin@exemple.fr']);
    assert.ok(got.data.includes('From: Cachet <rmm@exemple.fr>'));
    assert.equal(Buffer.from(got.data.split('\r\n\r\n')[1], 'base64').toString('utf8'), 'On regarde ça.');
  });
  await t('sujet non-ASCII encodé RFC 2047', async () => {
    await smtp.send({ host: '127.0.0.1', port: 9587, user: 'u', pass: 'p', secure: false,
      from: 'rmm@exemple.fr', to: 'a@b.c', subject: 'Échec relevé', text: 'x' });
    assert.ok(smtpSrv.received.at(-1).data.includes('=?UTF-8?B?'));
  });
  await t('un refus 550 remonte tel quel', async () => {
    await assert.rejects(() => smtp.send({ host: '127.0.0.1', port: 9587, user: 'u', pass: 'p', secure: false,
      from: 'interdit@exemple.fr', to: 'a@b.c', subject: 'x', text: 'x' }),
      e => { assert.equal(e.code, 550); assert.ok(/non autorisé/.test(e.message)); return true; });
  });

  console.log('\n── API bout en bout ──');
  const server = require('../server');
  await new Promise(r => setTimeout(r, 300));
  const base = 'http://127.0.0.1:8899';
  let cookie = '';
  const call = async (method, path, body) => {
    const res = await fetch(base + path, {
      method, headers: { 'content-type': 'application/json', cookie },
      body: body ? JSON.stringify(body) : undefined
    });
    const sc = res.headers.get('set-cookie');
    if (sc) cookie = sc.split(';')[0];
    return { status: res.status, body: await res.json().catch(() => ({})) };
  };

  await t('l\'API refuse sans session', async () => assert.equal((await call('GET', '/api/state')).status, 401));
  await t('mauvais mot de passe refusé', async () => assert.equal((await call('POST', '/api/login', { password: 'nope' })).status, 401));
  await t('connexion et lecture de l\'état', async () => {
    assert.equal((await call('POST', '/api/login', { password: 'motdepassetest' })).status, 200);
    const s = await call('GET', '/api/state');
    assert.equal(s.status, 200);
    assert.ok(Array.isArray(s.body.accounts));
  });

  let accId;
  await t('création d\'une boîte à tickets avec ses alias', async () => {
    const r = await call('POST', '/api/accounts', {
      name: 'Arrivée', addr: 'alertes@exemple.fr', kind: 'tickets',
      imapHost: '127.0.0.1', imapPort: 9993, imapTls: false,
      smtpHost: '127.0.0.1', smtpPort: 9587,
      password: 'MotDePasseTest#2026', provider: 'manual',
      aliases: [
        { addr: 'conteneurs@exemple.fr', svc: 'conteneurs', urg: 'crit' },
        { addr: 'rmm@exemple.fr', svc: 'supervision', urg: 'haute' },
        { addr: 'proxy@exemple.fr', svc: 'proxy', urg: 'basse', send: false }
      ]
    });
    assert.equal(r.status, 201);
    accId = r.body.id;
    assert.equal(r.body.aliases.length, 3);
    assert.equal(r.body.imapPass, undefined, 'le mot de passe ne doit jamais sortir de l\'API');
  });

  await t('le mot de passe est chiffré sur le disque', async () => {
    const raw = require('node:fs').readFileSync(process.env.CACHET_DATA + '/config.json', 'utf8');
    assert.ok(!raw.includes('MotDePasseTest#2026'), 'mot de passe en clair');
    assert.ok(raw.includes('enc:'), 'aucune valeur chiffrée');
  });

  await t('test de connexion IMAP par l\'API', async () => {
    const r = await call('POST', `/api/accounts/${accId}/test`);
    assert.equal(r.body.ok, true, r.body.error);
    assert.equal(r.body.messages, 2);
  });

  await t('la relève transforme les alertes en tickets', async () => {
    await call('POST', '/api/poll');
    const s = await call('GET', '/api/state');
    assert.equal(s.body.tickets.length, 2, JSON.stringify(s.body.poll));
    const rmm = s.body.tickets.find(t => t.via === 'rmm@exemple.fr');
    assert.equal(rmm.service, 'supervision');
    assert.equal(rmm.urgency, 'haute');
    const c = s.body.tickets.find(t => t.via === 'conteneurs@exemple.fr');
    assert.equal(c.urgency, 'crit');
    assert.equal(c.host, 'srv01');
  });

  await t('une seconde relève ne rejoue pas les mêmes messages', async () => {
    const r = await call('POST', '/api/poll');
    assert.equal(r.body.fetched, 0);
    const s = await call('GET', '/api/state');
    assert.equal(s.body.messages.length, 2);
  });

  await t('une alerte identique incrémente le ticket', async () => {
    imapSrv.push(makeMessage({ from: 'noreply@sup.exemple.fr', to: 'rmm@exemple.fr',
      subject: 'Agent hors ligne sur srv01', body: 'Machine : srv01\nDurée : 19 minutes' }));
    await call('POST', '/api/poll');
    const s = await call('GET', '/api/state');
    assert.equal(s.body.tickets.length, 2, 'un doublon a créé un ticket de trop');
    assert.equal(s.body.tickets.find(t => t.via === 'rmm@exemple.fr').occurrences, 2);
  });

  await t('changement de statut historisé', async () => {
    const id = (await call('GET', '/api/state')).body.tickets[0].id;
    const r = await call('PATCH', `/api/tickets/${id}`, { status: 'cours' });
    assert.equal(r.body.status, 'cours');
    assert.ok(r.body.history.some(h => /statut/.test(h.what)));
  });

  await t('dossiers : création, déplacement, suppression', async () => {
    const c = await call('POST', '/api/folders', { name: 'Archives été' });
    assert.equal(c.status, 201);
    assert.equal(c.body.id, 'archives-ete');
    assert.equal((await call('POST', '/api/folders', { name: 'Archives été' })).status, 409);

    const msg = (await call('GET', '/api/state')).body.messages[0];
    assert.equal((await call('PATCH', '/api/messages/' + encodeURIComponent(msg.id), { folder: 'archives-ete' })).body.folder, 'archives-ete');
    assert.equal((await call('PATCH', '/api/messages/' + encodeURIComponent(msg.id), { folder: 'nexistepas' })).status, 400);

    await call('DELETE', '/api/folders/archives-ete');
    const apres = (await call('GET', '/api/state')).body;
    assert.ok(apres.messages.some(m => m.id === msg.id), 'le message a disparu avec le dossier');
    assert.equal(apres.messages.find(m => m.id === msg.id).folder, null);
  });

  await t('un message se supprime sans emporter son ticket', async () => {
    const msg = (await call('GET', '/api/state')).body.messages.find(m => m.ticketId);
    const sup = await call('DELETE', '/api/messages/' + encodeURIComponent(msg.id));
    assert.equal(sup.body.ticketConserve, msg.ticketId);
    const apres = (await call('GET', '/api/state')).body;
    assert.ok(!apres.messages.some(m => m.id === msg.id));
    assert.ok(apres.tickets.some(t => t.id === msg.ticketId), 'le ticket a été emporté');
  });

  await t('règles par l\'API, avec essai à blanc', async () => {
    const creee = await call('POST', '/api/rules', {
      name: 'Certificats en sourdine',
      conditions: { mode: 'all', items: [{ champ: 'subject', op: 'contient', valeur: 'certificat' }] },
      actions: { read: true, ticket: 'non' }
    });
    assert.equal(creee.status, 201);
    assert.equal((await call('POST', '/api/rules', { name: 'Vide', conditions: { mode: 'all', items: [] }, actions: {} })).status, 400);

    const essai = await call('POST', '/api/rules/essai', {
      rule: { name: 'test', conditions: { mode: 'all', items: [{ champ: 'any', op: 'contient', valeur: 'srv01' }] }, actions: { urgency: 'crit' } }
    });
    assert.ok(essai.body.touches >= 1, JSON.stringify(essai.body));

    await call('PATCH', `/api/rules/${creee.body.id}`, { enabled: false });
    assert.equal((await call('GET', '/api/rules')).body.rules[0].enabled, false);
    await call('DELETE', `/api/rules/${creee.body.id}`);
    assert.equal((await call('GET', '/api/rules')).body.rules.length, 0);
  });

  await t('une règle de suppression écarte le message à la relève', async () => {
    await call('POST', '/api/rules', {
      name: 'Silence',
      conditions: { mode: 'all', items: [{ champ: 'subject', op: 'contient', valeur: 'publicité' }] },
      actions: { delete: true }
    });
    const avant = (await call('GET', '/api/state')).body.messages.length;
    imapSrv.push(makeMessage({ from: 'spam@ailleurs.fr', to: 'rmm@exemple.fr', subject: 'publicité du jour', body: 'achetez' }));
    await call('POST', '/api/poll');
    const apres = (await call('GET', '/api/state')).body;
    assert.equal(apres.messages.length, avant, 'le message aurait dû être écarté');
    assert.ok(apres.log.some(l => /supprimé par/.test(l.what)), 'aucune trace au journal');
  });

  await t('le filtre « alias seulement » écarte ce qui ne vise aucun alias', async () => {
    await call('PATCH', `/api/accounts/${accId}`, { aliasOnly: true });
    const avant = (await call('GET', '/api/state')).body.messages.length;
    imapSrv.push(makeMessage({ from: 'quelquun@ailleurs.fr', to: 'alertes@exemple.fr', subject: 'Message direct', body: 'Bonjour' }));
    await call('POST', '/api/poll');
    const apres = (await call('GET', '/api/state')).body;
    assert.equal(apres.messages.length, avant, 'un message hors alias a été conservé');
    assert.ok(apres.log.some(l => /aucun alias/.test(l.what)));
    await call('PATCH', `/api/accounts/${accId}`, { aliasOnly: false });
  });

  await t('envoi depuis un alias autorisé, copie conservée', async () => {
    const avant = (await call('GET', '/api/state')).body.messages.filter(m => m.sent).length;
    const r = await call('POST', '/api/send', {
      from: 'rmm@exemple.fr', to: 'admin@exemple.fr, second@exemple.fr',
      subject: 'Trace de l\'envoi', text: 'Corps.'
    });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    const apres = (await call('GET', '/api/state')).body.messages.filter(m => m.sent);
    assert.equal(apres.length, avant + 1, 'aucune copie conservée');
    assert.deepEqual(apres[0].toList, ['admin@exemple.fr', 'second@exemple.fr']);
  });

  await t('envoi refusé depuis un alias en réception seule', async () => {
    assert.equal((await call('POST', '/api/send', { from: 'proxy@exemple.fr', to: 'a@b.c', subject: 'x', text: 'x' })).status, 403);
  });
  await t('envoi refusé depuis une adresse étrangère', async () => {
    assert.equal((await call('POST', '/api/send', { from: 'ailleurs@autre.fr', to: 'a@b.c', subject: 'x', text: 'x' })).status, 400);
  });
  await t('les envois ne remontent pas comme des alertes', async () => {
    const r = await call('GET', '/api/messages/detailed');
    assert.ok(!r.body.messages.some(m => m.subject === 'Trace de l\'envoi'));
    const s = await call('GET', '/api/messages?sent=1');
    assert.ok(s.body.messages.every(m => m.sent));
  });

  console.log('\n── clés, CORS, webhook ──');
  let cle, cleEnvoi;
  await t('les deux clés sont générées et lisibles avec une session', async () => {
    const r = await call('GET', '/api/apikey');
    assert.ok(/^pk_/.test(r.body.key));
    assert.ok(/^sk_/.test(r.body.sendKey));
    cle = r.body.key; cleEnvoi = r.body.sendKey;
  });
  await t('la clé complète ouvre l\'API sans cookie', async () => {
    const res = await fetch(base + '/api/state', { headers: { 'x-cachet-key': cle } });
    assert.equal(res.status, 200);
  });
  await t('la clé d\'envoi n\'ouvre que la route d\'envoi', async () => {
    assert.equal((await fetch(base + '/api/state', { headers: { 'x-cachet-key': cleEnvoi } })).status, 401);
    assert.equal((await fetch(base + '/api/tickets', { headers: { 'x-cachet-key': cleEnvoi } })).status, 401);
    assert.equal((await fetch(base + '/api/accounts/' + accId, { method: 'DELETE', headers: { 'x-cachet-key': cleEnvoi } })).status, 401);
    const envoi = await fetch(base + '/api/send', {
      method: 'POST', headers: { 'x-cachet-key': cleEnvoi, 'content-type': 'application/json' },
      body: JSON.stringify({ from: 'rmm@exemple.fr', to: 'a@b.c', subject: 'via cle envoi', text: 'x' })
    });
    assert.equal(envoi.status, 200, await envoi.text());
  });
  await t('aucune clé ne permet de lire les clés', async () => {
    assert.equal((await fetch(base + '/api/apikey', { headers: { 'x-cachet-key': cle } })).status, 403);
  });
  await t('une mauvaise clé est refusée', async () => {
    assert.equal((await fetch(base + '/api/state', { headers: { 'x-cachet-key': 'pk_faux' } })).status, 401);
  });

  await t('CORS refusé tant que l\'origine n\'est pas déclarée, accepté ensuite', async () => {
    const avant = await fetch(base + '/api/state', { method: 'OPTIONS', headers: { origin: 'http://front.exemple:9000' } });
    assert.equal(avant.status, 403);
    await call('PATCH', '/api/settings', { api: { origins: ['http://front.exemple:9000'] } });
    const pre = await fetch(base + '/api/state', { method: 'OPTIONS', headers: { origin: 'http://front.exemple:9000' } });
    assert.equal(pre.status, 204);
    assert.equal(pre.headers.get('access-control-allow-origin'), 'http://front.exemple:9000');
    assert.ok(/x-cachet-key/.test(pre.headers.get('access-control-allow-headers')));
  });

  await t('le webhook part signé, avec l\'en-tête demandé', async () => {
    const http = require('node:http');
    const recus = [];
    const srv = http.createServer((rq, rs) => {
      let d = '';
      rq.on('data', c => d += c);
      rq.on('end', () => { recus.push({ entetes: rq.headers, corps: JSON.parse(d) }); rs.writeHead(200).end('{}'); });
    });
    await new Promise(r => srv.listen(9911, '127.0.0.1', r));
    await call('PATCH', '/api/settings', {
      webhook: { enabled: true, url: 'http://127.0.0.1:9911/hook', key: 'cle-tierce', keyHeader: 'x-service-key', secret: 'hmac-partage' }
    });
    await call('POST', '/api/tickets', { subject: 'Essai webhook', service: 'Cachet', urgency: 'haute' });
    await new Promise(r => setTimeout(r, 300));
    assert.equal(recus.length, 1, 'aucun appel reçu');
    assert.equal(recus[0].corps.event, 'ticket.created');
    assert.equal(recus[0].entetes['x-service-key'], 'cle-tierce');
    assert.equal(recus[0].entetes['x-cachet-key'], undefined, 'l\'en-tête par défaut traîne encore');
    const { signature } = require('../lib/webhook');
    assert.equal(recus[0].entetes['x-cachet-signature'], signature(JSON.stringify(recus[0].corps), 'hmac-partage'));
    srv.close();
    await call('PATCH', '/api/settings', { webhook: { enabled: false } });
  });

  console.log('\n── divers ──');
  await t('l\'accusé de réception accepte plusieurs formes', async () => {
    const liste = (await call('GET', '/api/messages/detailed')).body.messages;
    const un = liste[0].id;
    assert.equal((await call('POST', '/api/ack', { ids: [un] })).body.acquittes, 1);
    const deux = liste[1] ? liste[1].id : un;
    assert.equal((await call('POST', '/api/ack', [deux])).body.acquittes, 1);
    const r = await call('POST', '/api/ack', { messageIds: ['inexistant'] });
    assert.equal(r.body.acquittes, 0);
    assert.deepEqual(r.body.inconnus, ['inexistant']);
  });

  await t('une route inconnue explique ce qui a été demandé', async () => {
    const r = await call('GET', '/api/nimportequoi');
    assert.equal(r.status, 404);
    assert.equal(r.body.path, '/api/nimportequoi');
    assert.ok(/GET \/api/.test(r.body.hint));
  });

  await t('un préfixe client retombe sur la route équivalente', async () => {
    const r = await fetch(base + '/api/monservice/ping', { headers: { 'x-cachet-key': cle } });
    assert.equal(r.status, 200);
    assert.equal((await r.json()).ok, true);
  });

  await t('/api et /api/ping répondent en JSON', async () => {
    const i = await call('GET', '/api');
    assert.ok(Array.isArray(i.body.routes) && i.body.routes.length > 10);
    assert.equal((await call('GET', '/api/ping')).body.service, 'cachet');
  });

  await t('le JS et la CSS portent une empreinte, le favicon est servi', async () => {
    const html = await (await fetch(base + '/')).text();
    assert.ok(/src="\/app\.js\?v=\w+"/.test(html), 'script non versionné');
    assert.ok(/href="\/app\.css\?v=\w+"/.test(html), 'feuille non versionnée');
    const js = await fetch(base + html.match(/src="(\/app\.js[^"]*)"/)[1]);
    assert.equal(js.headers.get('cache-control'), 'no-store, must-revalidate');
    const ico = await fetch(base + '/favicon.ico');
    assert.equal(ico.status, 200);
    assert.equal(ico.headers.get('content-type'), 'image/x-icon');
    const png = await fetch(base + '/favicon.png');
    assert.equal(png.headers.get('content-type'), 'image/png');
  });

  await t('le rattrapage ouvre les tickets des messages orphelins', async () => {
    const avant = (await call('GET', '/api/state')).body;
    const cible = avant.messages.find(m => m.ticketId && !m.sent);
    await call('DELETE', '/api/tickets/' + cible.ticketId);
    const r = await call('POST', '/api/tickets/backfill');
    assert.ok(r.body.examines >= 1, JSON.stringify(r.body));
    const apres = (await call('GET', '/api/state')).body;
    assert.ok(apres.messages.find(m => m.id === cible.id).ticketId, 'le message est resté sans ticket');
  });

  await t('les données survivent à un rechargement du store', async () => {
    require('../lib/store').flush();
    const fs = require('node:fs');
    const st = JSON.parse(fs.readFileSync(process.env.CACHET_DATA + '/state.json', 'utf8'));
    assert.ok(st.tickets.length >= 1);
    assert.ok(Object.keys(st.uidState).length === 1);
  });

  await t('TOTP conforme aux vecteurs de la RFC 6238', () => {
    const { totp } = require('../lib/auth');
    const s = 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ';
    assert.equal(totp(s, 59000), '287082');
    assert.equal(totp(s, 1111111109000), '081804');
    assert.equal(totp(s, 1234567890000), '005924');
    assert.equal(totp(s, 2000000000000), '279037');
  });

  console.log(`\n${pass} réussis, ${fail} échoués\n`);
  imapSrv.close(); smtpSrv.close(); server.close();
  process.exit(fail ? 1 : 0);
})();
