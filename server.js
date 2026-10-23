'use strict';
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

if (!process.env.CACHET_SECRET) {
  console.error('CACHET_SECRET manquant. Générez-en un :  openssl rand -hex 32');
  process.exit(1);
}

const store = require('./lib/store');
const auth = require('./lib/auth');
const poller = require('./lib/poller');
const smtp = require('./lib/smtp');
const webhook = require('./lib/webhook');
const regles = require('./lib/rules');
const { Imap } = require('./lib/imap');
const { classify, aliasForMessage, ingest } = require('./lib/tickets');
const { config, state, saveConfig, saveState, encrypt, decrypt } = store;

const PORT = Number(process.env.PORT || 8787);
const HOST = process.env.HOST || '0.0.0.0';
const PUBLIC = path.join(__dirname, 'public');
const SECURE_COOKIE = process.env.CACHET_INSECURE_COOKIE !== '1';
const VERSION = require('./package.json').version;

/* ── premier démarrage ── */
if (!config.settings.api.key) {
  config.settings.api.key = encrypt('pk_' + crypto.randomBytes(24).toString('base64url'));
  saveConfig();
}
// Clé d'envoi : distribuée aux services, elle n'ouvre que POST /api/send.
if (!config.settings.api.sendKey) {
  config.settings.api.sendKey = encrypt('sk_' + crypto.randomBytes(24).toString('base64url'));
  saveConfig();
}
if (!config.admin) {
  const pass = process.env.CACHET_PASSWORD || crypto.randomBytes(9).toString('base64url');
  config.admin = { password: auth.hashPassword(pass), totp: process.env.CACHET_TOTP_SECRET || '' };
  saveConfig();
  console.log('\n  Premier démarrage. Mot de passe : ' + pass + '\n');
}

/* ── utilitaires ── */
const json = (res, code, body) => {
  const s = JSON.stringify(body);
  res.writeHead(code, { 'content-type': 'application/json; charset=utf-8', 'content-length': Buffer.byteLength(s) });
  res.end(s);
};
const fail = (res, code, msg) => json(res, code, { error: msg });
const ipDe = req => (req.headers['x-forwarded-for'] || '').split(',')[0].trim() || req.socket.remoteAddress || '?';

function readBody(req, limit = 2e6) {
  return new Promise((resolve, reject) => {
    let data = '', size = 0;
    req.on('data', c => {
      size += c.length;
      if (size > limit) { req.destroy(); reject(new Error('corps de requête trop gros')); return; }
      data += c;
    });
    req.on('end', () => {
      if (!data) return resolve({});
      try { resolve(JSON.parse(data)); } catch { reject(new Error('JSON invalide')); }
    });
    req.on('error', reject);
  });
}

const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png',
  '.ico': 'image/x-icon', '.woff2': 'font/woff2'
};

// Empreinte d'un fichier d'après sa taille et sa date : donne une URL neuve au JS
// et à la CSS à chaque déploiement. Un navigateur ne peut pas resservir depuis sa
// mémoire une adresse qu'il n'a jamais vue.
function empreinte(nom) {
  try {
    const st = fs.statSync(path.join(PUBLIC, nom));
    return Math.floor(st.mtimeMs).toString(36) + st.size.toString(36);
  } catch { return String(Date.now()); }
}
function versionner(html) {
  return html
    .replace(/(href=")\/app\.css(")/g, `$1/app.css?v=${empreinte('app.css')}$2`)
    .replace(/(src=")\/app\.js(")/g, `$1/app.js?v=${empreinte('app.js')}$2`);
}

function serveStatic(req, res, urlPath) {
  const rel = urlPath === '/' ? 'index.html' : urlPath.replace(/^\/+/, '');
  const file = path.join(PUBLIC, rel);
  if (!file.startsWith(PUBLIC) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) return false;
  const ext = path.extname(file);

  if (ext === '.html') {
    const corps = versionner(fs.readFileSync(file, 'utf8'));
    res.writeHead(200, {
      'content-type': MIME['.html'],
      'cache-control': 'no-store, must-revalidate',
      'x-content-type-options': 'nosniff',
      'content-length': Buffer.byteLength(corps)
    });
    res.end(corps);
    return true;
  }

  const volatil = ['.js', '.css'].includes(ext);
  res.writeHead(200, {
    'content-type': MIME[ext] || 'application/octet-stream',
    'cache-control': volatil ? 'no-store, must-revalidate' : 'public, max-age=3600',
    'x-content-type-options': 'nosniff'
  });
  fs.createReadStream(file).pipe(res);
  return true;
}

function sessionOf(req) {
  return auth.verify(auth.parseCookies(req.headers.cookie).cachet_session);
}

function memeCle(fournie, chiffree) {
  let attendue;
  try { attendue = decrypt(chiffree); } catch { return false; }
  if (!attendue || fournie.length !== attendue.length) return false;
  return crypto.timingSafeEqual(Buffer.from(fournie), Buffer.from(attendue));
}
// Retourne 'full', 'send' ou false selon la clé présentée.
function cleValide(req) {
  const fournie = req.headers['x-cachet-key'] ||
    String(req.headers.authorization || '').replace(/^Bearer\s+/i, '');
  if (!fournie) return false;
  if (memeCle(fournie, config.settings.api.key)) return 'full';
  if (memeCle(fournie, config.settings.api.sendKey)) return 'send';
  return false;
}
function autorise(req, chemin) {
  if (sessionOf(req)) return true;
  const portee = cleValide(req);
  if (portee === 'full') return true;
  // La clé d'envoi ne sert qu'à envoyer, rien d'autre.
  if (portee === 'send') return req.method === 'POST' && /^\/api\/send$/.test(chemin);
  return false;
}

// Un front servi depuis une autre origine doit être déclaré.
function appliquerCors(req, res) {
  const origine = req.headers.origin;
  if (!origine) return false;
  const permises = config.settings.api.origins || [];
  if (!permises.includes('*') && !permises.includes(origine)) return false;
  res.setHeader('access-control-allow-origin', origine);
  res.setHeader('vary', 'Origin');
  res.setHeader('access-control-allow-credentials', 'true');
  res.setHeader('access-control-allow-methods', 'GET,POST,PATCH,DELETE,OPTIONS');
  res.setHeader('access-control-allow-headers', 'content-type,x-cachet-key,authorization');
  res.setHeader('access-control-max-age', '600');
  return true;
}

/* ── vues publiques ── */
function publicAccount(a) {
  const { imapPass, smtpPass, ...rest } = a;
  return { ...rest, hasPassword: Boolean(imapPass) };
}
function snapshot() {
  const s = config.settings;
  return {
    version: VERSION,
    accounts: config.accounts.map(publicAccount),
    folders: config.folders,
    rules: config.rules,
    settings: {
      pollSeconds: s.pollSeconds, dedupMinutes: s.dedupMinutes, retentionDays: s.retentionDays,
      telegram: { ...s.telegram, token: s.telegram.token ? '••••' : '' },
      api: { origins: s.api.origins || [] },
      webhook: {
        enabled: s.webhook.enabled, url: s.webhook.url,
        key: s.webhook.key ? '••••' : '', keyHeader: s.webhook.keyHeader || 'x-cachet-key',
        secret: s.webhook.secret ? '••••' : '', last: webhook.statut()
      }
    },
    tickets: state.tickets,
    messages: state.messages,
    log: state.log.slice(0, 200),
    poll: poller.status(),
    now: new Date().toISOString()
  };
}

/* ── routes ── */
const routes = [];
const on = (method, pattern, handler, open = false) => routes.push({ method, pattern, handler, open });

on('POST', /^\/api\/login$/, async (req, res) => {
  const ip = ipDe(req);
  if (auth.tropDEssais(ip)) return fail(res, 429, 'Trop d\'essais, réessayez dans 15 minutes');
  const body = await readBody(req);
  const ok = auth.verifyPassword(String(body.password || ''), config.admin.password) &&
             auth.verifyTotp(config.admin.totp, body.code);
  auth.noteEssai(ip, ok);
  if (!ok) {
    await new Promise(r => setTimeout(r, 400 + Math.random() * 300));
    return fail(res, 401, 'Identifiants refusés');
  }
  res.setHeader('set-cookie', [
    `cachet_session=${auth.newSession()}`, 'HttpOnly', 'SameSite=Strict', 'Path=/',
    `Max-Age=${auth.SESSION_HOURS * 3600}`, SECURE_COOKIE ? 'Secure' : ''
  ].filter(Boolean).join('; '));
  json(res, 200, { ok: true });
}, true);

on('POST', /^\/api\/logout$/, async (req, res) => {
  res.setHeader('set-cookie', 'cachet_session=; HttpOnly; Path=/; Max-Age=0');
  json(res, 200, { ok: true });
}, true);

on('GET', /^\/api\/session$/, async (req, res) => {
  json(res, 200, { authenticated: Boolean(sessionOf(req)), totpEnabled: Boolean(config.admin.totp), version: VERSION });
}, true);

on('GET', /^\/api\/state$/, async (req, res) => json(res, 200, snapshot()));
on('POST', /^\/api\/poll$/, async (req, res) => json(res, 200, await poller.pollAll()));

/* index et santé */
on('GET', /^\/api\/?$/, async (req, res) => {
  json(res, 200, {
    service: 'cachet', version: VERSION,
    routes: routes.map(r => `${r.method} ${r.pattern.source.replace(/\\\//g, '/').replace(/[\^$]/g, '')}`)
  });
});
on('GET', /^\/api\/(ping|health|status)$/, async (req, res) => {
  json(res, 200, {
    ok: true, service: 'cachet', version: VERSION,
    accounts: config.accounts.length, tickets: state.tickets.length,
    poll: poller.status(), now: new Date().toISOString()
  });
});

/* comptes */
function sanitizeAliases(list) {
  if (!Array.isArray(list)) return [];
  return list.filter(a => a && a.addr).map(a => ({
    addr: String(a.addr).toLowerCase().trim(),
    svc: String(a.svc || 'autre'),
    urg: ['basse', 'normale', 'haute', 'crit'].includes(a.urg) ? a.urg : 'normale',
    active: a.active !== false,
    send: a.send !== false
  }));
}

on('GET', /^\/api\/accounts$/, async (req, res) => json(res, 200, { accounts: config.accounts.map(publicAccount) }));

on('POST', /^\/api\/accounts$/, async (req, res) => {
  const b = await readBody(req);
  if (!b.addr) return fail(res, 400, 'Adresse manquante');
  const acc = {
    id: crypto.randomUUID(),
    name: b.name || b.addr,
    addr: String(b.addr).toLowerCase(),
    kind: b.kind === 'tickets' ? 'tickets' : 'mail',
    provider: b.provider || 'manual',
    imapHost: b.imapHost || '', imapPort: Number(b.imapPort) || 993,
    imapUser: b.imapUser || '', imapTls: b.imapTls !== false,
    smtpHost: b.smtpHost || '', smtpPort: Number(b.smtpPort) || 587,
    imapPass: encrypt(b.password || ''),
    folder: b.folder || 'INBOX',
    markSeen: b.markSeen !== false,
    aliasOnly: Boolean(b.aliasOnly),
    insecureTls: Boolean(b.insecureTls),
    aliases: sanitizeAliases(b.aliases),
    disabled: false, lastError: null, lastOk: null
  };
  config.accounts.push(acc);
  saveConfig();
  poller.start();
  json(res, 201, publicAccount(acc));
});

on('PATCH', /^\/api\/accounts\/([\w-]+)$/, async (req, res, [id]) => {
  const acc = config.accounts.find(a => a.id === id);
  if (!acc) return fail(res, 404, 'Compte inconnu');
  const b = await readBody(req);
  for (const k of ['name', 'kind', 'provider', 'imapHost', 'imapUser', 'smtpHost', 'folder']) {
    if (b[k] !== undefined) acc[k] = b[k];
  }
  for (const k of ['imapPort', 'smtpPort']) if (b[k] !== undefined) acc[k] = Number(b[k]);
  for (const k of ['markSeen', 'insecureTls', 'disabled', 'imapTls', 'aliasOnly']) {
    if (b[k] !== undefined) acc[k] = Boolean(b[k]);
  }
  if (b.addr) acc.addr = String(b.addr).toLowerCase();
  if (b.password) acc.imapPass = encrypt(b.password);
  if (b.aliases) acc.aliases = sanitizeAliases(b.aliases);
  saveConfig();
  poller.start();
  json(res, 200, publicAccount(acc));
});

on('DELETE', /^\/api\/accounts\/([\w-]+)$/, async (req, res, [id]) => {
  const i = config.accounts.findIndex(a => a.id === id);
  if (i < 0) return fail(res, 404, 'Compte inconnu');
  config.accounts.splice(i, 1);
  delete state.uidState[id];
  saveConfig(); saveState();
  json(res, 200, { ok: true });
});

on('POST', /^\/api\/accounts\/([\w-]+)\/test$/, async (req, res, [id]) => {
  const acc = config.accounts.find(a => a.id === id);
  if (!acc) return fail(res, 404, 'Compte inconnu');
  const im = new Imap({
    host: acc.imapHost, port: acc.imapPort, user: acc.imapUser || acc.addr,
    pass: decrypt(acc.imapPass), tls: acc.imapTls !== false, rejectUnauthorized: !acc.insecureTls
  });
  try {
    await im.connect();
    await im.login();
    const box = await im.select(acc.folder || 'INBOX');
    await im.logout();
    acc.lastError = null; saveConfig();
    json(res, 200, { ok: true, messages: box.exists });
  } catch (e) {
    im.close();
    acc.lastError = e.message; saveConfig();
    json(res, 200, { ok: false, error: e.message });
  }
});

on('POST', /^\/api\/accounts\/([\w-]+)\/rescan$/, async (req, res, [id]) => {
  const acc = config.accounts.find(a => a.id === id);
  if (!acc) return fail(res, 404, 'Compte inconnu');
  delete state.uidState[id];
  state.rescan = state.rescan || {};
  state.rescan[id] = 20;
  saveState();
  json(res, 200, await poller.pollAll());
});

on('GET', /^\/api\/aliases$/, async (req, res) => {
  const out = [];
  for (const a of config.accounts) {
    for (const al of a.aliases || []) out.push({ ...al, box: a.addr, kind: a.kind || 'mail' });
  }
  json(res, 200, { total: out.length, aliases: out });
});

/* dossiers */
on('GET', /^\/api\/folders$/, async (req, res) => json(res, 200, { folders: config.folders }));

on('POST', /^\/api\/folders$/, async (req, res) => {
  const b = await readBody(req);
  const nom = String(b.name || '').trim();
  if (!nom) return fail(res, 400, 'Nom de dossier manquant');
  const id = nom.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || ('d' + Date.now());
  if (config.folders.some(f => f.id === id)) return fail(res, 409, 'Ce dossier existe déjà');
  const dossier = { id, name: nom };
  config.folders.push(dossier);
  saveConfig();
  json(res, 201, dossier);
});

on('DELETE', /^\/api\/folders\/([\w-]+)$/, async (req, res, [id]) => {
  const i = config.folders.findIndex(f => f.id === id);
  if (i < 0) return fail(res, 404, 'Dossier inconnu');
  config.folders.splice(i, 1);
  state.messages.forEach(m => { if (m.folder === id) m.folder = null; });
  saveConfig(); saveState();
  json(res, 200, { ok: true });
});

/* règles */
on('GET', /^\/api\/rules$/, async (req, res) => json(res, 200, { rules: config.rules }));

on('POST', /^\/api\/rules$/, async (req, res) => {
  const b = await readBody(req);
  const r = { id: 'r' + Date.now().toString(36), ...regles.nettoie(b) };
  if (!r.conditions.items.length) return fail(res, 400, 'Une règle a besoin d\'au moins une condition');
  config.rules.push(r);
  saveConfig();
  json(res, 201, r);
});

on('PATCH', /^\/api\/rules\/([\w-]+)$/, async (req, res, [id]) => {
  const i = config.rules.findIndex(r => r.id === id);
  if (i < 0) return fail(res, 404, 'Règle inconnue');
  const b = await readBody(req);
  // Bascule seule : on ne réécrit pas toute la règle pour un simple on/off.
  if (Object.keys(b).length === 1 && b.enabled !== undefined) config.rules[i].enabled = Boolean(b.enabled);
  else config.rules[i] = { id, ...regles.nettoie({ ...config.rules[i], ...b }) };
  saveConfig();
  json(res, 200, config.rules[i]);
});

on('DELETE', /^\/api\/rules\/([\w-]+)$/, async (req, res, [id]) => {
  const i = config.rules.findIndex(r => r.id === id);
  if (i < 0) return fail(res, 404, 'Règle inconnue');
  config.rules.splice(i, 1);
  saveConfig();
  json(res, 200, { ok: true });
});

// Essai à blanc : ce que les règles auraient fait des messages déjà relevés.
on('POST', /^\/api\/rules\/essai$/, async (req, res) => {
  const b = await readBody(req);
  const jeu = b.rule ? { ...config, rules: [{ id: 'essai', ...regles.nettoie(b.rule) }] } : config;
  const touches = [];
  for (const m of state.messages.slice(0, 200)) {
    const al = aliasForMessage(config, m);
    const d = regles.evalue(jeu, m, al ? al.addr : null);
    if (d.reglesAppliquees.length) {
      touches.push({ id: m.id, subject: m.subject, from: m.fromAddr, regles: d.reglesAppliquees,
        folder: d.folder, supprimer: d.supprimer, ticket: d.ticket, urgence: d.urgence, service: d.service });
    }
  }
  json(res, 200, { examines: Math.min(state.messages.length, 200), touches: touches.length, messages: touches.slice(0, 30) });
});

/* messages */
on('GET', /^\/api\/messages$/, async (req, res) => {
  const q = new URL(req.url, 'http://x').searchParams;
  const limite = Math.min(Number(q.get('limit')) || 100, 500);
  const filtre = q.get('sent');
  let liste = state.messages;
  if (filtre === '1') liste = liste.filter(m => m.sent);
  else if (filtre === '0') liste = liste.filter(m => !m.sent);
  json(res, 200, { total: liste.length, messages: liste.slice(0, limite) });
});

// Messages enrichis : service, urgence et alias déjà résolus, pour qu'un service
// tiers n'ait pas à refaire la détection.
on('GET', /^\/api\/messages\/detailed$/, async (req, res) => {
  const q = new URL(req.url, 'http://x').searchParams;
  const limite = Math.min(Number(q.get('limit')) || 100, 500);
  let liste = state.messages.filter(m => !m.sent);

  const depuis = q.get('since');
  if (depuis) {
    const d = Date.parse(depuis);
    if (!Number.isNaN(d)) liste = liste.filter(m => Date.parse(m.receivedAt) >= d);
  }
  if (q.get('new') === '1') liste = liste.filter(m => !m.ticketId && !m.ackedAt);

  const messages = liste.slice(0, limite).map(m => {
    const c = classify(config, m);
    return {
      id: m.id, receivedAt: m.receivedAt, date: m.date, account: m.account,
      alias: c.via, service: c.service, urgency: c.urgency, host: c.host,
      from: m.fromAddr, fromName: m.fromName, to: m.toList || [],
      subject: m.subject, text: m.text, messageId: m.messageId,
      ticketId: m.ticketId, ackedAt: m.ackedAt || null, unread: m.unread
    };
  });
  json(res, 200, { total: messages.length, messages });
});

on('PATCH', /^\/api\/messages\/([^/]+)$/, async (req, res, [id]) => {
  const m = state.messages.find(x => x.id === decodeURIComponent(id));
  if (!m) return fail(res, 404, 'Message inconnu');
  const b = await readBody(req);
  if (b.folder !== undefined) {
    const f = (b.folder === null || b.folder === '') ? null : String(b.folder);
    if (f && !config.folders.some(x => x.id === f)) return fail(res, 400, 'Dossier inconnu');
    m.folder = f;
  }
  if (b.unread !== undefined) m.unread = Boolean(b.unread);
  saveState();
  json(res, 200, m);
});

on('DELETE', /^\/api\/messages\/([^/]+)$/, async (req, res, [id]) => {
  const vrai = decodeURIComponent(id);
  const i = state.messages.findIndex(x => x.id === vrai);
  if (i < 0) return fail(res, 404, 'Message inconnu');
  const [m] = state.messages.splice(i, 1);
  // Le ticket survit : on retire seulement la référence au message.
  state.tickets.forEach(t => {
    if (Array.isArray(t.messageIds)) t.messageIds = t.messageIds.filter(x => x !== m.id);
  });
  saveState();
  json(res, 200, { ok: true, ticketConserve: m.ticketId || null });
});

// Accusé de réception : plusieurs formes de corps acceptées.
on('POST', /^\/api\/ack$/, async (req, res) => {
  const b = await readBody(req);
  const brut = Array.isArray(b) ? b : (b.ids || b.messageIds || b.messages || b.id || []);
  const liste = (Array.isArray(brut) ? brut : [brut])
    .map(x => (x && typeof x === 'object') ? (x.id || x.messageId) : x)
    .filter(Boolean).map(String);
  if (!liste.length) return fail(res, 400, 'Aucun identifiant fourni (ids, messageIds ou tableau)');

  const maintenant = new Date().toISOString();
  const vus = [], inconnus = [];
  for (const id of liste) {
    const m = state.messages.find(x => x.id === id || x.messageId === id);
    if (m) { m.ackedAt = maintenant; vus.push(m.id); } else inconnus.push(id);
  }
  saveState();
  json(res, 200, { acquittes: vus.length, ids: vus, inconnus });
});

// Retire les messages déjà relevés qui ne visaient aucun alias, sur les boîtes
// réglées en « alias seulement ». ?avecTickets=1 emporte aussi leurs tickets.
on('POST', /^\/api\/messages\/purge-hors-alias$/, async (req, res) => {
  const emporte = new URL(req.url, 'http://x').searchParams.get('avecTickets') === '1';
  const strictes = new Set(config.accounts.filter(a => a.aliasOnly).map(a => a.id));
  const avant = state.messages.length;
  const gardes = [], retires = [], ticketsRetires = [];
  for (const m of state.messages) {
    const horsAlias = strictes.has(m.accountId) && !aliasForMessage(config, m);
    if (!horsAlias) { gardes.push(m); continue; }
    if (m.ticketId && !emporte) { gardes.push(m); continue; }
    if (m.ticketId) ticketsRetires.push(m.ticketId);
    retires.push(m.id);
  }
  state.messages = gardes;
  if (ticketsRetires.length) {
    const aSupprimer = new Set(ticketsRetires);
    state.tickets = state.tickets.filter(t => !aSupprimer.has(t.id));
  }
  saveState();
  json(res, 200, { avant, retires: retires.length, restants: state.messages.length, ticketsRetires: ticketsRetires.length });
});

/* tickets */
on('GET', /^\/api\/tickets$/, async (req, res) => {
  const q = new URL(req.url, 'http://x').searchParams;
  let liste = state.tickets;
  for (const [cle, champ] of [['status', 'status'], ['service', 'service'], ['urgency', 'urgency']]) {
    const v = q.get(cle);
    if (v) liste = liste.filter(t => String(t[champ]).toLowerCase() === v.toLowerCase());
  }
  const depuis = q.get('since');
  if (depuis) {
    const d = Date.parse(depuis);
    if (!Number.isNaN(d)) liste = liste.filter(t => Date.parse(t.updatedAt) >= d);
  }
  const limite = Math.min(Number(q.get('limit')) || 200, 1000);
  json(res, 200, { total: liste.length, tickets: liste.slice(0, limite) });
});

on('GET', /^\/api\/tickets\/([\w-]+)$/, async (req, res, [id]) => {
  const t = state.tickets.find(x => x.id === id);
  if (!t) return fail(res, 404, 'Ticket inconnu');
  json(res, 200, { ...t, messages: state.messages.filter(m => (t.messageIds || []).includes(m.id)) });
});

on('POST', /^\/api\/tickets$/, async (req, res) => {
  const b = await readBody(req);
  if (!b.subject) return fail(res, 400, 'Objet manquant');
  const now = new Date().toISOString();
  const t = {
    id: 'TCK-' + String(state.seq++).padStart(4, '0'),
    service: b.service || 'autre', subject: b.subject, host: b.host || '',
    urgency: ['basse', 'normale', 'haute', 'crit'].includes(b.urgency) ? b.urgency : 'normale',
    status: 'nouveau', auto: false, via: null, occurrences: 1,
    messageIds: b.messageId ? [b.messageId] : [],
    notes: b.notes || '', createdAt: now, updatedAt: now,
    history: [{ at: now, what: 'créé à la main' }]
  };
  state.tickets.unshift(t);
  if (b.messageId) {
    const m = state.messages.find(x => x.id === b.messageId);
    if (m) m.ticketId = t.id;
  }
  saveState();
  webhook.envoyer('ticket.created', t).catch(() => {});
  json(res, 201, t);
});

on('PATCH', /^\/api\/tickets\/([\w-]+)$/, async (req, res, [id]) => {
  const t = state.tickets.find(x => x.id === id);
  if (!t) return fail(res, 404, 'Ticket inconnu');
  const b = await readBody(req);
  const now = new Date().toISOString();
  if (b.status && b.status !== t.status && ['nouveau', 'cours', 'traite'].includes(b.status)) {
    t.history.push({ at: now, what: `statut → ${b.status}` });
    t.status = b.status;
  }
  if (b.urgency && b.urgency !== t.urgency) {
    t.history.push({ at: now, what: `urgence → ${b.urgency}` });
    t.urgency = b.urgency;
  }
  for (const k of ['subject', 'host', 'service', 'notes']) if (b[k] !== undefined) t[k] = b[k];
  t.updatedAt = now;
  saveState();
  webhook.envoyer('ticket.updated', t).catch(() => {});
  json(res, 200, t);
});

on('DELETE', /^\/api\/tickets\/([\w-]+)$/, async (req, res, [id]) => {
  const i = state.tickets.findIndex(x => x.id === id);
  if (i < 0) return fail(res, 404, 'Ticket inconnu');
  const [t] = state.tickets.splice(i, 1);
  state.messages.forEach(m => { if (m.ticketId === t.id) m.ticketId = null; });
  saveState();
  json(res, 200, { ok: true });
});

// Ouvre les tickets manquants pour les messages déjà relevés d'une boîte à tickets.
on('POST', /^\/api\/tickets\/backfill$/, async (req, res) => {
  const boites = new Set(config.accounts.filter(a => (a.kind || 'mail') === 'tickets').map(a => a.id));
  const candidats = state.messages
    .filter(m => boites.has(m.accountId) && !m.ticketId && !m.sent)
    .sort((a, b) => new Date(a.receivedAt) - new Date(b.receivedAt));
  const ouverts = [];
  for (const m of candidats) {
    const { ticket, created } = ingest({ config, state, msg: m });
    m.ticketId = ticket.id;
    if (created) { ouverts.push(ticket.id); webhook.envoyer('ticket.created', ticket).catch(() => {}); }
  }
  saveState();
  json(res, 200, { examines: candidats.length, ouverts: ouverts.length, tickets: ouverts });
});

/* envoi */
on('POST', /^\/api\/send$/, async (req, res) => {
  const b = await readBody(req);
  const acc = config.accounts.find(a => a.id === b.accountId) ||
              config.accounts.find(a => a.addr === b.from) ||
              config.accounts.find(a => (a.aliases || []).some(al => al.addr === b.from));
  if (!acc) return fail(res, 400, 'Aucune boîte ne correspond à cet expéditeur');
  if (!acc.smtpHost) return fail(res, 400, `Pas de serveur SMTP réglé sur ${acc.addr}`);

  const from = String(b.from || acc.addr).toLowerCase();
  if (from !== acc.addr) {
    const al = (acc.aliases || []).find(a => a.addr === from);
    if (!al) return fail(res, 400, `${from} n'est pas un alias de ${acc.addr}`);
    if (al.send === false) return fail(res, 403, `L'envoi depuis ${from} est désactivé`);
  }
  if (!b.to || !b.subject) return fail(res, 400, 'Destinataire ou objet manquant');
  const destinataires = Array.isArray(b.to) ? b.to : String(b.to).split(/[,;]/).map(x => x.trim()).filter(Boolean);
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(destinataires[0] || '')) {
    return fail(res, 400, 'Adresse du destinataire invalide');
  }

  try {
    const r = await smtp.send({
      host: acc.smtpHost, port: acc.smtpPort || 587,
      user: acc.imapUser || acc.addr, pass: decrypt(acc.imapPass),
      rejectUnauthorized: !acc.insecureTls,
      from, fromName: b.fromName || acc.name,
      to: destinataires, subject: b.subject, text: b.text || '',
      inReplyTo: b.inReplyTo, references: b.inReplyTo
    });
    // On garde une copie : sinon il ne resterait qu'une ligne de journal.
    state.messages.unshift({
      id: 'envoi:' + crypto.randomUUID(), sent: true,
      accountId: acc.id, account: acc.addr,
      fromName: b.fromName || acc.name, fromAddr: from,
      toList: destinataires, ccList: [], deliveredTo: [],
      subject: b.subject, messageId: r.messageId,
      date: new Date().toUTCString(), receivedAt: new Date().toISOString(),
      text: b.text || '', html: '', imagesMasquees: 0,
      unread: false, folder: null, ticketId: null
    });
    poller.logLine({ kind: 'envoi', from, to: destinataires.join(', '), what: b.subject });
    saveState();
    json(res, 200, { ok: true, messageId: r.messageId });
  } catch (e) {
    // L'erreur SMTP est renvoyée telle quelle : c'est elle qui dit quoi corriger.
    poller.logLine({ kind: 'erreur', from, to: String(b.to), what: e.message });
    saveState();
    json(res, 502, { error: e.message, code: e.code || null });
  }
});

/* réglages et clés */
on('GET', /^\/api\/settings$/, async (req, res) => json(res, 200, snapshot().settings));

on('PATCH', /^\/api\/settings$/, async (req, res) => {
  const b = await readBody(req);
  const s = config.settings;
  if (b.pollSeconds !== undefined) s.pollSeconds = Math.max(30, Number(b.pollSeconds) || 120);
  if (b.dedupMinutes !== undefined) s.dedupMinutes = Math.max(0, Number(b.dedupMinutes) || 0);
  if (b.retentionDays !== undefined) s.retentionDays = Math.max(1, Number(b.retentionDays) || 30);
  if (b.api && Array.isArray(b.api.origins)) {
    s.api.origins = b.api.origins.map(o => String(o).trim().replace(/\/$/, '')).filter(Boolean);
  }
  if (b.webhook) {
    const w = s.webhook;
    if (b.webhook.enabled !== undefined) w.enabled = Boolean(b.webhook.enabled);
    if (b.webhook.url !== undefined) w.url = String(b.webhook.url).trim();
    if (b.webhook.keyHeader !== undefined) {
      const nom = String(b.webhook.keyHeader).trim().toLowerCase();
      w.keyHeader = /^[a-z0-9-]+$/.test(nom) ? nom : 'x-cachet-key';
    }
    if (b.webhook.key) w.key = encrypt(b.webhook.key);
    if (b.webhook.secret) w.secret = encrypt(b.webhook.secret);
  }
  if (b.telegram) {
    const t = s.telegram;
    if (b.telegram.enabled !== undefined) t.enabled = Boolean(b.telegram.enabled);
    if (b.telegram.chatId !== undefined) t.chatId = String(b.telegram.chatId);
    if (b.telegram.minUrgency) t.minUrgency = b.telegram.minUrgency;
    if (b.telegram.token) t.token = encrypt(b.telegram.token);
  }
  saveConfig();
  if (b.pollSeconds !== undefined) poller.start();
  json(res, 200, { ok: true });
});

on('GET', /^\/api\/apikey$/, async (req, res) => {
  // La clé ne se lit qu'avec une vraie session, jamais avec une clé.
  if (!sessionOf(req)) return fail(res, 403, 'Session requise');
  let cle = '', cleEnvoi = '';
  try { cle = decrypt(config.settings.api.key); } catch {}
  try { cleEnvoi = decrypt(config.settings.api.sendKey); } catch {}
  json(res, 200, { key: cle, sendKey: cleEnvoi, origins: config.settings.api.origins || [] });
});

on('POST', /^\/api\/apikey\/rotate$/, async (req, res) => {
  if (!sessionOf(req)) return fail(res, 403, 'Session requise');
  if (new URL(req.url, 'http://x').searchParams.get('quoi') === 'envoi') {
    const k = 'sk_' + crypto.randomBytes(24).toString('base64url');
    config.settings.api.sendKey = encrypt(k);
    saveConfig();
    return json(res, 200, { sendKey: k });
  }
  const cle = 'pk_' + crypto.randomBytes(24).toString('base64url');
  config.settings.api.key = encrypt(cle);
  saveConfig();
  json(res, 200, { key: cle });
});

on('POST', /^\/api\/webhook\/test$/, async (req, res) => {
  const faux = {
    id: 'TCK-TEST', service: 'Cachet', subject: 'Essai de liaison',
    host: '', urgency: 'basse', status: 'nouveau', auto: false,
    via: null, occurrences: 1, createdAt: new Date().toISOString(), history: []
  };
  const ok = await webhook.envoyer('ticket.test', faux);
  json(res, 200, { ok, ...webhook.statut() });
});

/* ── dispatch ── */
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  res.setHeader('x-frame-options', 'DENY');
  res.setHeader('referrer-policy', 'no-referrer');

  const corsOk = appliquerCors(req, res);
  if (req.method === 'OPTIONS') { res.writeHead(corsOk ? 204 : 403).end(); return; }

  // '/api' sans barre finale doit aussi passer par le routeur, sinon un client
  // tiers reçoit du HTML au lieu de JSON.
  if (url.pathname === '/api' || url.pathname.startsWith('/api/')) {
    let chemin = url.pathname;
    let route = routes.find(r => r.method === req.method && r.pattern.test(chemin));

    // Un client peut ranger ses appels sous son propre préfixe.
    const m = chemin.match(/^\/api\/[a-z0-9_-]+\/(.+)$/i);
    if (!route && m) {
      const alt = '/api/' + m[1];
      const r2 = routes.find(r => r.method === req.method && r.pattern.test(alt));
      if (r2) { chemin = alt; route = r2; }
    }

    if (!route) {
      console.warn(`[api] route inconnue : ${req.method} ${url.pathname}`);
      return json(res, 404, {
        error: 'Route inconnue', method: req.method, path: url.pathname,
        hint: 'GET /api liste les routes disponibles'
      });
    }
    if (!route.open && !autorise(req, chemin)) {
      return fail(res, 401, 'Session expirée, clé invalide ou droits insuffisants');
    }
    try {
      await route.handler(req, res, chemin.match(route.pattern).slice(1));
    } catch (e) {
      console.error('[api]', e);
      if (!res.headersSent) fail(res, 500, e.message || 'Erreur interne');
    }
    return;
  }

  if (serveStatic(req, res, url.pathname)) return;
  if (serveStatic(req, res, '/')) return;
  res.writeHead(404).end('introuvable');
});

server.listen(PORT, HOST, () => {
  console.log(`Cachet ${VERSION} écoute sur http://${HOST}:${PORT}`);
  console.log(`Données dans ${store.DIR}`);
  poller.start();
  if (!config.accounts.length) console.log('Aucune boîte configurée pour l\'instant.');
});

module.exports = server;
