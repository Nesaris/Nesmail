// Routes de CACHET. Chaque route dit qui peut l'appeler : une personne connectée
// (session du socle, avec son rôle), ou une machine (clé d'API, jeton du Hub) —
// et jusqu'où. Les machines lisent et traitent le courrier et les tickets ;
// les boîtes, les règles, les réglages et les clés demandent une personne
// connectée, administrateur, et pour les gestes sensibles une confirmation
// récente de son identité.
import crypto from 'node:crypto';
import { ErreurHttp, Routeur, Debit, lireCorps, valider, repondreJson, egal } from '../socle/src/index.js';
import * as regles from './rules.js';
import * as smtp from './smtp.js';
import { classify, aliasForMessage, ingest } from './tickets.js';
import { imapDe } from './poller.js';
import { normaliserEmpreinte } from './tls.js';
import { adresseWebhook } from './webhook.js';
import { hoteInterdit } from './reseau.js';
import { JETON_TELEGRAM } from './notify.js';

const URGENCES = ['basse', 'normale', 'haute', 'crit'];
const STATUTS = ['nouveau', 'cours', 'traite'];
const COURRIEL = smtp.ADRESSE;
const HOTE = /^(?:[A-Za-z0-9](?:[A-Za-z0-9-]{0,62}[A-Za-z0-9])?\.)*[A-Za-z0-9](?:[A-Za-z0-9-]{0,62}[A-Za-z0-9])?$|^\d{1,3}(?:\.\d{1,3}){3}$|^\[[0-9A-Fa-f:]{2,39}\]$/;
// Une valeur qui entre dans une commande IMAP ou SMTP : sur une ligne.
const LIGNE = /^[^\r\n\0]*$/;
const DOSSIER_IMAP = /^[\p{L}\p{N} ._/&+-]{1,100}$/u;
const EMPREINTE = /^(?:[0-9A-Fa-f]{2}:?){31}[0-9A-Fa-f]{2}$/;
const ORIGINE = /^https?:\/\/[A-Za-z0-9.-]{1,253}(?::\d{1,5})?$/;
// Identifiant désigné par le chemin : comptes, règles, tickets, messages.
const PARAM = /^[\w:.-]{1,120}$/;

const S = {
  alias: {
    addr: { type: 'chaine', requis: true, max: 254, motif: COURRIEL }, svc: { type: 'chaine', max: 60, defaut: 'autre' },
    urg: { type: 'chaine', parmi: URGENCES, defaut: 'normale' }, active: { type: 'booleen', defaut: true }, send: { type: 'booleen', defaut: true },
  },
  get boite() {
    return {
      name: { type: 'chaine', max: 80 }, addr: { type: 'chaine', max: 254, motif: COURRIEL },
      kind: { type: 'chaine', parmi: ['mail', 'tickets'] }, provider: { type: 'chaine', max: 30, motif: /^[\w-]{1,30}$/ },
      imapHost: { type: 'chaine', max: 253, motif: HOTE }, imapPort: { type: 'entier', min: 1, max: 65535 },
      imapUser: { type: 'chaine', max: 254, motif: LIGNE }, imapTls: { type: 'booleen' },
      smtpHost: { type: 'chaine', max: 253, motif: HOTE }, smtpPort: { type: 'entier', min: 1, max: 65535 },
      password: { type: 'chaine', max: 500, motif: LIGNE }, folder: { type: 'chaine', max: 100, motif: DOSSIER_IMAP },
      markSeen: { type: 'booleen' }, aliasOnly: { type: 'booleen' }, disabled: { type: 'booleen' },
      imapPin: { type: 'chaine', max: 95, motif: EMPREINTE }, smtpPin: { type: 'chaine', max: 95, motif: EMPREINTE },
      aliases: { type: 'liste', max: 200, de: { type: 'objet', champs: this.alias } },
    };
  },
  dossier: { name: { type: 'chaine', requis: true, max: 60 } },
  condition: { champ: { type: 'chaine', requis: true, parmi: regles.CHAMPS }, op: { type: 'chaine', requis: true, parmi: regles.OPERATEURS }, valeur: { type: 'chaine', max: 200, defaut: '' } },
  get regle() {
    return {
      name: { type: 'chaine', max: 80 }, enabled: { type: 'booleen' },
      conditions: { type: 'objet', champs: { mode: { type: 'chaine', parmi: ['all', 'any'] }, items: { type: 'liste', max: 10, de: { type: 'objet', champs: this.condition } } } },
      actions: {
        type: 'objet', champs: {
          folder: { type: 'chaine', max: 60 }, read: { type: 'booleen' }, delete: { type: 'booleen' }, ticket: { type: 'chaine', parmi: ['oui', 'non'] },
          urgency: { type: 'chaine', parmi: URGENCES }, service: { type: 'chaine', max: 60 }, stop: { type: 'booleen' },
        },
      },
    };
  },
  get essai() { return { rule: { type: 'objet', champs: this.regle } }; },
  message: { folder: { type: 'chaine', max: 60 }, unread: { type: 'booleen' } },
  ticket: {
    subject: { type: 'chaine', max: 300 }, service: { type: 'chaine', max: 60 }, host: { type: 'chaine', max: 120 },
    urgency: { type: 'chaine', parmi: URGENCES }, status: { type: 'chaine', parmi: STATUTS }, notes: { type: 'chaine', max: 5000 },
    messageId: { type: 'chaine', max: 200 },
  },
  envoi: {
    accountId: { type: 'chaine', max: 64 }, from: { type: 'chaine', max: 254, motif: COURRIEL }, fromName: { type: 'chaine', max: 120 },
    to: { type: 'json', profondeur: 1 }, subject: { type: 'chaine', max: 300 }, text: { type: 'chaine', max: 100000, defaut: '' },
    inReplyTo: { type: 'chaine', max: 252, motif: smtp.MESSAGE_ID },
  },
  reglages: {
    pollSeconds: { type: 'entier', min: 30, max: 86400 }, dedupMinutes: { type: 'entier', min: 0, max: 10080 }, retentionDays: { type: 'entier', min: 1, max: 3650 },
    api: { type: 'objet', champs: { origins: { type: 'liste', max: 20, de: { type: 'chaine', max: 300 } } } },
    webhook: {
      type: 'objet', champs: {
        enabled: { type: 'booleen' }, url: { type: 'chaine', max: 500 }, keyHeader: { type: 'chaine', max: 40 },
        key: { type: 'chaine', max: 500, motif: LIGNE }, secret: { type: 'chaine', max: 500 },
      },
    },
    telegram: {
      type: 'objet', champs: {
        enabled: { type: 'booleen' }, chatId: { type: 'chaine', max: 40, motif: /^(?:-?\d{1,20}|@[A-Za-z0-9_]{5,32})$/ },
        minUrgency: { type: 'chaine', parmi: URGENCES }, token: { type: 'chaine', max: 80, motif: JETON_TELEGRAM },
      },
    },
  },
};

// Ce qu'une machine peut appeler, selon ce qu'elle présente : la clé complète
// et le jeton du Hub traitent le courrier et les tickets ; la clé d'envoi
// n'envoie que ; un jeton dérivé par le Hub pour un service voisin lit.
const PORTEES = { complete: ['lecture', 'traitement', 'envoi'], envoi: ['envoi'], lecture: ['lecture'] };

function publicAccount(a) {
  const { imapPass, smtpPass, ...reste } = a;
  return { ...reste, hasPassword: Boolean(imapPass) };
}

export function creerApi({ socle, cfg, depot, releve, webhook, version, log = console }) {
  const r = new Routeur();
  const { portail, journal, limiteur } = socle;
  const { config, state } = depot;
  const debitEnvoi = new Debit({ max: cfg.envoisMinute });
  const corps = async (ctx, schema, limite) => { const brut = await lireCorps(ctx.req, limite ? { limite } : {}); return { v: valider(brut, schema), brut }; };
  const present = (brut, k) => Object.hasOwn(brut, k);

  // Une preuve de machine présentée est vérifiée, et une fausse compte comme
  // un échec pour l'adresse, qui se bloque par paliers (limiteur persistant
  // du socle, à part des connexions humaines). Elle ne retombe jamais sur la
  // session.
  const cleMachine = ctx => [`ip:machine:${ctx.ip}`];
  function machine(ctx) {
    const h = ctx.req.headers;
    const fournie = String(h['x-cachet-key'] || '') || (/^Bearer\s+(\S+)$/i.exec(String(h.authorization || ''))?.[1] ?? '');
    if (!fournie) return null;
    limiteur.controler(cleMachine(ctx));
    if (cfg.jetonHub && egal(fournie, cfg.jetonHub)) return { portee: 'complete', qui: 'hub' };
    const derive = /^cer_([a-z0-9][a-z0-9-]{1,30})_([0-9a-f]{64})$/.exec(fournie);
    if (derive && cfg.jetonHub) {
      const attendu = crypto.createHmac('sha256', cfg.jetonHub).update('cerveau:' + derive[1]).digest();
      const recu = Buffer.from(derive[2], 'hex');
      if (recu.length === attendu.length && crypto.timingSafeEqual(recu, attendu)) return { portee: 'lecture', qui: derive[1] };
    }
    const quelle = depot.quelleCle(fournie);
    if (quelle) return { portee: quelle, qui: `clé ${quelle}` };
    limiteur.echec(cleMachine(ctx));
    journal.rare(`machine:${ctx.ip}`, { action: 'connexion.cle', objet: ctx.url.pathname, ip: ctx.ip, resultat: 'refus' });
    throw new ErreurHttp(401, 'Clé invalide.');
  }

  // Accès à une route : `machine` est le besoin d'une machine (lecture,
  // traitement, envoi) ou null si aucune machine n'y entre ; `role` celui d'une
  // personne. Rend { acteur, session? }.
  function acces(ctx, { role, machine: besoin = null, renfort = false, devoiler = false }) {
    const m = machine(ctx);
    if (m) {
      if (!besoin || !PORTEES[m.portee].includes(besoin)) {
        journal.rare(`refus:${m.qui}:${ctx.url.pathname}`, { acteur: m.qui, action: 'acces.refuse', objet: ctx.url.pathname, ip: ctx.ip, resultat: 'refus' });
        // Route fermée à toute machine : 403. Clé trop faible pour une route
        // qu'une autre clé ouvre : 401, comme en 1.0.
        if (!besoin) throw new ErreurHttp(403, 'Cette route demande une personne connectée.');
        throw new ErreurHttp(401, 'Session expirée, clé invalide ou droits insuffisants');
      }
      return { acteur: m.qui };
    }
    const s = portail.exiger(ctx, { role, renfort, devoiler });
    return { acteur: s.compte, session: s };
  }
  const trace = (ctx, a, action, objet = null, details = null) =>
    journal.ecrire({ acteur: a.acteur, action, objet, ip: ctx.ip, details });

  function snapshot() {
    const s = config.settings;
    return {
      version,
      accounts: config.accounts.map(publicAccount),
      folders: config.folders,
      rules: config.rules,
      settings: {
        pollSeconds: s.pollSeconds, dedupMinutes: s.dedupMinutes, retentionDays: s.retentionDays,
        telegram: { ...s.telegram, token: s.telegram.token ? '••••' : '' },
        api: { origins: s.api.origins || [], cles: depot.clesPosees() },
        webhook: {
          enabled: s.webhook.enabled, url: s.webhook.url,
          key: s.webhook.key ? '••••' : '', keyHeader: s.webhook.keyHeader || 'x-cachet-key',
          secret: s.webhook.secret ? '••••' : '', last: webhook.statut(),
        },
      },
      tickets: state.tickets,
      messages: state.messages,
      log: state.log.slice(0, 200),
      poll: releve.status(),
      now: new Date().toISOString(),
    };
  }

  const entier = (v, defaut, max) => { const n = Number(v); return Number.isInteger(n) && n > 0 ? Math.min(n, max) : defaut; };
  const date = v => { const d = Date.parse(String(v || '')); return Number.isNaN(d) ? null : d; };
  const compte = id => config.accounts.find(a => a.id === id) || (() => { throw new ErreurHttp(404, 'Compte inconnu'); })();

  // Publique : le Hub et le conteneur y voient que le service répond, rien d'autre.
  r.get('/api/health', () => ({ ok: true }), { public: true });
  r.get('/api', ctx => {
    acces(ctx, { role: 'lecture', machine: 'lecture' });
    return { service: 'cachet', version, routes: r.routes.map(x => `${x.methode} ${x.re.source.replace(/\\\//g, '/').replace(/[\^$]/g, '').replace(/\(\[\^\/\]\+\)/g, ':id')}`) };
  }, { role: 'lecture' });
  for (const p of ['/api/ping', '/api/status']) {
    r.get(p, ctx => {
      acces(ctx, { role: 'lecture', machine: 'lecture' });
      return { ok: true, service: 'cachet', version, accounts: config.accounts.length, tickets: state.tickets.length, poll: releve.status(), now: new Date().toISOString() };
    }, { role: 'lecture' });
  }
  // Les comptes essentiels, pour les sondes du Hub.
  r.get('/api/summary', ctx => {
    acces(ctx, { role: 'lecture', machine: 'lecture' });
    const ouverts = state.tickets.filter(t => t.status !== 'traite');
    return {
      tickets_ouverts: ouverts.length, tickets_critiques: ouverts.filter(t => t.urgency === 'crit').length,
      messages_non_lus: state.messages.filter(m => m.unread && !m.sent).length,
      boites: config.accounts.length, boites_en_erreur: config.accounts.filter(a => a.lastError && !a.disabled).length,
      derniere_releve: releve.status().at,
    };
  }, { role: 'lecture' });

  r.get('/api/state', ctx => { acces(ctx, { role: 'lecture', machine: 'lecture' }); return snapshot(); }, { role: 'lecture' });
  r.post('/api/poll', async ctx => {
    acces(ctx, { role: 'membre', machine: 'traitement' });
    return releve.pollAll();
  }, { role: 'membre' });

  r.get('/api/accounts', ctx => { acces(ctx, { role: 'lecture', machine: 'lecture' }); return { accounts: config.accounts.map(publicAccount) }; }, { role: 'lecture' });

  // Ce qui décide où part le mot de passe d'une boîte, et à quel certificat on
  // le confie : le changer demande une confirmation récente de son identité.
  const DESTINATION = ['addr', 'imapHost', 'imapPort', 'imapUser', 'imapTls', 'smtpHost', 'smtpPort', 'imapPin', 'smtpPin'];
  const hotesPermis = v => {
    for (const k of ['imapHost', 'smtpHost']) if (v[k] && hoteInterdit(v[k])) throw new ErreurHttp(400, `Champ « ${k} » : adresse interdite (métadonnées, lien local ou plage réservée).`);
  };
  const appliquerBoite = (acc, v, brut) => {
    for (const k of ['name', 'kind', 'provider', 'imapHost', 'imapUser', 'smtpHost', 'folder', 'imapPort', 'smtpPort', 'markSeen', 'imapTls', 'aliasOnly', 'disabled']) {
      if (v[k] !== undefined) acc[k] = v[k];
    }
    if (v.addr) acc.addr = v.addr.toLowerCase();
    // Une empreinte vide retire l'épinglage : le certificat repasse par la chaîne d'autorités.
    for (const k of ['imapPin', 'smtpPin']) {
      if (v[k] !== undefined) acc[k] = normaliserEmpreinte(v[k]);
      else if (present(brut, k) && !brut[k]) acc[k] = '';
    }
    if (v.password) acc.imapPass = depot.sceller('boite', v.password, acc.id);
    if (v.aliases) acc.aliases = v.aliases.map(a => ({ ...a, addr: a.addr.toLowerCase(), svc: a.svc.trim() || 'autre' }));
  };

  r.post('/api/accounts', async ctx => {
    const a = acces(ctx, { role: 'admin', renfort: true });
    const { v, brut } = await corps(ctx, S.boite);
    if (!v.addr) throw new ErreurHttp(400, 'Adresse manquante');
    hotesPermis(v);
    if (config.accounts.length >= 50) throw new ErreurHttp(409, 'Cinquante boîtes au plus.');
    const acc = {
      id: crypto.randomUUID(), name: v.addr, addr: v.addr, kind: 'mail', provider: 'manual',
      imapHost: '', imapPort: 993, imapUser: '', imapTls: true, smtpHost: '', smtpPort: 587,
      imapPass: '', imapPin: '', smtpPin: '', folder: 'INBOX', markSeen: true, aliasOnly: false,
      aliases: [], disabled: false, lastError: null, lastOk: null,
    };
    appliquerBoite(acc, { ...v, disabled: false }, brut);
    config.accounts.push(acc);
    depot.saveConfig();
    trace(ctx, a, 'boite.ajoutee', acc.id, { adresse: acc.addr });
    releve.start();
    repondreJson(ctx.res, 201, publicAccount(acc));
  }, { role: 'admin' });

  r.patch('/api/accounts/:id', async ctx => {
    const a = acces(ctx, { role: 'admin' });
    const acc = compte(ctx.params.id);
    const { v, brut } = await corps(ctx, S.boite);
    hotesPermis(v);
    const change = k => present(brut, k) && String(brut[k] ?? '') !== String(acc[k] ?? '');
    if (DESTINATION.some(change) || v.password) socle.comptes.exigerRenfort(a.session);
    appliquerBoite(acc, v, brut);
    depot.saveConfig();
    trace(ctx, a, 'boite.modifiee', acc.id, { champs: Object.keys(brut).filter(k => k !== 'password'), motDePasse: Boolean(v.password) });
    releve.start();
    return publicAccount(acc);
  }, { role: 'admin' });

  r.del('/api/accounts/:id', ctx => {
    const a = acces(ctx, { role: 'admin', renfort: true });
    const i = config.accounts.findIndex(x => x.id === ctx.params.id);
    if (i < 0) throw new ErreurHttp(404, 'Compte inconnu');
    const [acc] = config.accounts.splice(i, 1);
    delete state.uidState[acc.id];
    depot.saveConfig(); depot.saveState();
    trace(ctx, a, 'boite.supprimee', acc.id, { adresse: acc.addr });
    return { ok: true };
  }, { role: 'admin' });

  r.post('/api/accounts/:id/test', async ctx => {
    acces(ctx, { role: 'admin' });
    const acc = compte(ctx.params.id);
    const im = imapDe(depot, acc, { journal });
    try {
      await im.connect();
      await im.login();
      const box = await im.select(acc.folder || 'INBOX');
      await im.logout();
      acc.lastError = null; depot.saveConfig();
      return { ok: true, messages: box.exists };
    } catch (e) {
      im.close();
      acc.lastError = e.message; depot.saveConfig();
      // L'empreinte présentée par un serveur refusé : à épingler s'il est reconnu.
      return { ok: false, error: e.message, ...(e.empreinte ? { empreinte: e.empreinte } : {}) };
    }
  }, { role: 'admin' });

  r.post('/api/accounts/:id/rescan', async ctx => {
    acces(ctx, { role: 'admin' });
    const acc = compte(ctx.params.id);
    delete state.uidState[acc.id];
    state.rescan = state.rescan || {};
    state.rescan[acc.id] = 20;
    depot.saveState();
    return releve.pollAll();
  }, { role: 'admin' });

  r.get('/api/aliases', ctx => {
    acces(ctx, { role: 'lecture', machine: 'lecture' });
    const out = [];
    for (const a of config.accounts) for (const al of a.aliases || []) out.push({ ...al, box: a.addr, kind: a.kind || 'mail' });
    return { total: out.length, aliases: out };
  }, { role: 'lecture' });

  r.get('/api/folders', ctx => { acces(ctx, { role: 'lecture', machine: 'lecture' }); return { folders: config.folders }; }, { role: 'lecture' });

  r.post('/api/folders', async ctx => {
    const a = acces(ctx, { role: 'membre', machine: 'traitement' });
    const { v } = await corps(ctx, S.dossier);
    const nom = v.name.trim();
    if (!nom) throw new ErreurHttp(400, 'Nom de dossier manquant');
    if (config.folders.length >= 200) throw new ErreurHttp(409, 'Deux cents dossiers au plus.');
    const id = nom.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '')
      .replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || ('d' + Date.now());
    if (config.folders.some(f => f.id === id)) throw new ErreurHttp(409, 'Ce dossier existe déjà');
    const dossier = { id, name: nom };
    config.folders.push(dossier);
    depot.saveConfig();
    trace(ctx, a, 'dossier.cree', id);
    repondreJson(ctx.res, 201, dossier);
  }, { role: 'membre' });

  r.del('/api/folders/:id', ctx => {
    const a = acces(ctx, { role: 'membre', machine: 'traitement' });
    const i = config.folders.findIndex(f => f.id === ctx.params.id);
    if (i < 0) throw new ErreurHttp(404, 'Dossier inconnu');
    config.folders.splice(i, 1);
    state.messages.forEach(m => { if (m.folder === ctx.params.id) m.folder = null; });
    depot.saveConfig(); depot.saveState();
    trace(ctx, a, 'dossier.supprime', ctx.params.id);
    return { ok: true };
  }, { role: 'membre' });

  // Une expression que le moteur refuserait d'évaluer est refusée à l'enregistrement.
  const regleSure = brut => {
    for (const c of brut?.conditions?.items || []) {
      if (c.op === 'regex' && !regles.expressionSure(c.valeur)) throw new ErreurHttp(400, 'Expression refusée : 200 caractères au plus, valide, sans quantificateur imbriqué ni référence arrière.');
    }
  };
  r.get('/api/rules', ctx => { acces(ctx, { role: 'lecture', machine: 'lecture' }); return { rules: config.rules }; }, { role: 'lecture' });

  // Une règle qui supprime à la relève est un geste destructeur : renfort.
  const renfortSiSuppression = (a, brut) => { if (brut?.actions?.delete === true) socle.comptes.exigerRenfort(a.session); };
  r.post('/api/rules', async ctx => {
    const a = acces(ctx, { role: 'admin' });
    const { brut } = await corps(ctx, S.regle);
    regleSure(brut);
    renfortSiSuppression(a, brut);
    const regle = { id: 'r' + Date.now().toString(36) + crypto.randomBytes(2).toString('hex'), ...regles.nettoie(brut) };
    if (!regle.conditions.items.length) throw new ErreurHttp(400, 'Une règle a besoin d\'au moins une condition');
    if (config.rules.length >= 200) throw new ErreurHttp(409, 'Deux cents règles au plus.');
    config.rules.push(regle);
    depot.saveConfig();
    trace(ctx, a, 'regle.creee', regle.id, { nom: regle.name });
    repondreJson(ctx.res, 201, regle);
  }, { role: 'admin' });

  r.post('/api/rules/essai', async ctx => {
    acces(ctx, { role: 'admin' });
    const { brut } = await corps(ctx, S.essai);
    if (brut.rule) regleSure(brut.rule);
    const jeu = brut.rule ? { ...config, rules: [{ id: 'essai', ...regles.nettoie(brut.rule) }] } : config;
    const touches = [];
    for (const m of state.messages.slice(0, 200)) {
      const al = aliasForMessage(config, m);
      const d = regles.evalue(jeu, m, al ? al.addr : null);
      if (d.reglesAppliquees.length) {
        touches.push({ id: m.id, subject: m.subject, from: m.fromAddr, regles: d.reglesAppliquees,
          folder: d.folder, supprimer: d.supprimer, ticket: d.ticket, urgence: d.urgence, service: d.service });
      }
    }
    return { examines: Math.min(state.messages.length, 200), touches: touches.length, messages: touches.slice(0, 30) };
  }, { role: 'admin' });

  r.patch('/api/rules/:id', async ctx => {
    const a = acces(ctx, { role: 'admin' });
    const i = config.rules.findIndex(x => x.id === ctx.params.id);
    if (i < 0) throw new ErreurHttp(404, 'Règle inconnue');
    const { brut } = await corps(ctx, S.regle);
    // Bascule seule : on ne réécrit pas toute la règle pour un simple on/off.
    if (Object.keys(brut).length === 1 && brut.enabled !== undefined) config.rules[i].enabled = Boolean(brut.enabled);
    else {
      regleSure(brut);
      renfortSiSuppression(a, brut);
      config.rules[i] = { id: ctx.params.id, ...regles.nettoie({ ...config.rules[i], ...brut }) };
    }
    depot.saveConfig();
    trace(ctx, a, 'regle.modifiee', ctx.params.id);
    return config.rules[i];
  }, { role: 'admin' });

  r.del('/api/rules/:id', ctx => {
    const a = acces(ctx, { role: 'admin', renfort: true });
    const i = config.rules.findIndex(x => x.id === ctx.params.id);
    if (i < 0) throw new ErreurHttp(404, 'Règle inconnue');
    config.rules.splice(i, 1);
    depot.saveConfig();
    trace(ctx, a, 'regle.supprimee', ctx.params.id);
    return { ok: true };
  }, { role: 'admin' });

  r.get('/api/messages', ctx => {
    acces(ctx, { role: 'lecture', machine: 'lecture' });
    const q = ctx.url.searchParams;
    const limite = entier(q.get('limit'), 100, 500);
    const filtre = q.get('sent');
    let liste = state.messages;
    if (filtre === '1') liste = liste.filter(m => m.sent);
    else if (filtre === '0') liste = liste.filter(m => !m.sent);
    return { total: liste.length, messages: liste.slice(0, limite) };
  }, { role: 'lecture' });

  // Messages enrichis : service, urgence et alias déjà résolus, pour qu'un service
  // tiers n'ait pas à refaire la détection.
  r.get('/api/messages/detailed', ctx => {
    acces(ctx, { role: 'lecture', machine: 'lecture' });
    const q = ctx.url.searchParams;
    const limite = entier(q.get('limit'), 100, 500);
    let liste = state.messages.filter(m => !m.sent);
    const depuis = date(q.get('since'));
    if (depuis !== null) liste = liste.filter(m => Date.parse(m.receivedAt) >= depuis);
    if (q.get('new') === '1') liste = liste.filter(m => !m.ticketId && !m.ackedAt);
    const messages = liste.slice(0, limite).map(m => {
      const c = classify(config, m);
      return {
        id: m.id, receivedAt: m.receivedAt, date: m.date, account: m.account,
        alias: c.via, service: c.service, urgency: c.urgency, host: c.host,
        from: m.fromAddr, fromName: m.fromName, to: m.toList || [],
        subject: m.subject, text: m.text, messageId: m.messageId,
        ticketId: m.ticketId, ackedAt: m.ackedAt || null, unread: m.unread,
      };
    });
    return { total: messages.length, messages };
  }, { role: 'lecture' });

  r.patch('/api/messages/:id', async ctx => {
    acces(ctx, { role: 'membre', machine: 'traitement' });
    const m = state.messages.find(x => x.id === ctx.params.id);
    if (!m) throw new ErreurHttp(404, 'Message inconnu');
    const { v, brut } = await corps(ctx, S.message);
    if (present(brut, 'folder')) {
      const f = v.folder || null;
      if (f && !config.folders.some(x => x.id === f)) throw new ErreurHttp(400, 'Dossier inconnu');
      m.folder = f;
    }
    if (v.unread !== undefined) m.unread = v.unread;
    depot.saveState();
    return m;
  }, { role: 'membre' });

  r.del('/api/messages/:id', ctx => {
    const a = acces(ctx, { role: 'membre', machine: 'traitement' });
    const i = state.messages.findIndex(x => x.id === ctx.params.id);
    if (i < 0) throw new ErreurHttp(404, 'Message inconnu');
    const [m] = state.messages.splice(i, 1);
    // Le ticket survit : on retire seulement la référence au message.
    state.tickets.forEach(t => { if (Array.isArray(t.messageIds)) t.messageIds = t.messageIds.filter(x => x !== m.id); });
    depot.saveState();
    trace(ctx, a, 'message.supprime', m.id);
    return { ok: true, ticketConserve: m.ticketId || null };
  }, { role: 'membre' });

  // Accusé de réception : plusieurs formes de corps acceptées, bornées.
  r.post('/api/ack', async ctx => {
    acces(ctx, { role: 'membre', machine: 'traitement' });
    const b = await lireCorps(ctx.req);
    const brut = Array.isArray(b) ? b : (b.ids || b.messageIds || b.messages || b.id || []);
    const liste = (Array.isArray(brut) ? brut : [brut])
      .map(x => (x && typeof x === 'object') ? (x.id || x.messageId) : x)
      .filter(x => typeof x === 'string' || typeof x === 'number').map(String);
    if (!liste.length) throw new ErreurHttp(400, 'Aucun identifiant fourni (ids, messageIds ou tableau)');
    if (liste.length > 500 || liste.some(x => x.length > 250)) throw new ErreurHttp(400, 'Cinq cents identifiants au plus, de 250 caractères au plus.');
    const maintenant = new Date().toISOString();
    const vus = [], inconnus = [];
    for (const id of liste) {
      const m = state.messages.find(x => x.id === id || x.messageId === id);
      if (m) { m.ackedAt = maintenant; vus.push(m.id); } else inconnus.push(id);
    }
    depot.saveState();
    return { acquittes: vus.length, ids: vus, inconnus };
  }, { role: 'membre' });

  // Retire les messages déjà relevés qui ne visaient aucun alias, sur les boîtes
  // réglées en « alias seulement ». ?avecTickets=1 emporte aussi leurs tickets.
  r.post('/api/messages/purge-hors-alias', ctx => {
    const a = acces(ctx, { role: 'admin', renfort: true });
    const emporte = ctx.url.searchParams.get('avecTickets') === '1';
    const strictes = new Set(config.accounts.filter(x => x.aliasOnly).map(x => x.id));
    const avant = state.messages.length;
    const gardes = [], retires = [], ticketsRetires = [];
    for (const m of state.messages) {
      const horsAlias = strictes.has(m.accountId) && !aliasForMessage(config, m);
      if (!horsAlias || (m.ticketId && !emporte)) { gardes.push(m); continue; }
      if (m.ticketId) ticketsRetires.push(m.ticketId);
      retires.push(m.id);
    }
    state.messages = gardes;
    if (ticketsRetires.length) {
      const aSupprimer = new Set(ticketsRetires);
      state.tickets = state.tickets.filter(t => !aSupprimer.has(t.id));
    }
    depot.saveState();
    trace(ctx, a, 'messages.purges', null, { retires: retires.length, tickets: ticketsRetires.length });
    return { avant, retires: retires.length, restants: state.messages.length, ticketsRetires: ticketsRetires.length };
  }, { role: 'admin' });

  r.get('/api/tickets', ctx => {
    acces(ctx, { role: 'lecture', machine: 'lecture' });
    const q = ctx.url.searchParams;
    let liste = state.tickets;
    for (const cle of ['status', 'service', 'urgency']) {
      const v = q.get(cle);
      if (v) liste = liste.filter(t => String(t[cle]).toLowerCase() === v.toLowerCase());
    }
    const depuis = date(q.get('since'));
    if (depuis !== null) liste = liste.filter(t => Date.parse(t.updatedAt) >= depuis);
    return { total: liste.length, tickets: liste.slice(0, entier(q.get('limit'), 200, 1000)) };
  }, { role: 'lecture' });

  r.post('/api/tickets/backfill', ctx => {
    const a = acces(ctx, { role: 'admin' });
    const boites = new Set(config.accounts.filter(x => (x.kind || 'mail') === 'tickets').map(x => x.id));
    const candidats = state.messages
      .filter(m => boites.has(m.accountId) && !m.ticketId && !m.sent)
      .sort((x, y) => new Date(x.receivedAt) - new Date(y.receivedAt));
    const ouverts = [];
    for (const m of candidats) {
      const { ticket, created } = ingest({ config, state, msg: m });
      m.ticketId = ticket.id;
      if (created) { ouverts.push(ticket.id); webhook.envoyer('ticket.created', ticket); }
    }
    depot.saveState();
    trace(ctx, a, 'tickets.rattrapes', null, { ouverts: ouverts.length });
    return { examines: candidats.length, ouverts: ouverts.length, tickets: ouverts };
  }, { role: 'admin' });

  r.get('/api/tickets/:id', ctx => {
    acces(ctx, { role: 'lecture', machine: 'lecture' });
    const t = state.tickets.find(x => x.id === ctx.params.id);
    if (!t) throw new ErreurHttp(404, 'Ticket inconnu');
    return { ...t, messages: state.messages.filter(m => (t.messageIds || []).includes(m.id)) };
  }, { role: 'lecture' });

  r.post('/api/tickets', async ctx => {
    acces(ctx, { role: 'membre', machine: 'traitement' });
    const { v } = await corps(ctx, S.ticket);
    if (!v.subject) throw new ErreurHttp(400, 'Objet manquant');
    const now = new Date().toISOString();
    const t = {
      id: 'TCK-' + String(state.seq++).padStart(4, '0'),
      service: v.service || 'autre', subject: v.subject, host: v.host || '',
      urgency: v.urgency || 'normale',
      status: 'nouveau', auto: false, via: null, occurrences: 1,
      messageIds: v.messageId ? [v.messageId] : [],
      notes: v.notes || '', createdAt: now, updatedAt: now,
      history: [{ at: now, what: 'créé à la main' }],
    };
    state.tickets.unshift(t);
    if (v.messageId) {
      const m = state.messages.find(x => x.id === v.messageId);
      if (m) m.ticketId = t.id;
    }
    depot.saveState();
    webhook.envoyer('ticket.created', t);
    repondreJson(ctx.res, 201, t);
  }, { role: 'membre' });

  r.patch('/api/tickets/:id', async ctx => {
    acces(ctx, { role: 'membre', machine: 'traitement' });
    const t = state.tickets.find(x => x.id === ctx.params.id);
    if (!t) throw new ErreurHttp(404, 'Ticket inconnu');
    const { v, brut } = await corps(ctx, S.ticket);
    const now = new Date().toISOString();
    if (v.status && v.status !== t.status) { t.history.push({ at: now, what: `statut → ${v.status}` }); t.status = v.status; }
    if (v.urgency && v.urgency !== t.urgency) { t.history.push({ at: now, what: `urgence → ${v.urgency}` }); t.urgency = v.urgency; }
    for (const k of ['subject', 'host', 'service', 'notes']) if (present(brut, k)) t[k] = v[k] ?? '';
    if (!t.subject) t.subject = '(sans objet)';
    if (t.history.length > 500) t.history.splice(0, t.history.length - 500);
    t.updatedAt = now;
    depot.saveState();
    webhook.envoyer('ticket.updated', t);
    return t;
  }, { role: 'membre' });

  r.del('/api/tickets/:id', ctx => {
    const a = acces(ctx, { role: 'membre', machine: 'traitement' });
    const i = state.tickets.findIndex(x => x.id === ctx.params.id);
    if (i < 0) throw new ErreurHttp(404, 'Ticket inconnu');
    const [t] = state.tickets.splice(i, 1);
    state.messages.forEach(m => { if (m.ticketId === t.id) m.ticketId = null; });
    depot.saveState();
    trace(ctx, a, 'ticket.supprime', t.id);
    return { ok: true };
  }, { role: 'membre' });

  r.post('/api/send', async ctx => {
    const a = acces(ctx, { role: 'membre', machine: 'envoi' });
    if (!debitEnvoi.prendre('envoi')) throw new ErreurHttp(429, 'Trop d’envois cette minute.');
    const { v } = await corps(ctx, S.envoi, 256 * 1024);
    const acc = config.accounts.find(x => x.id === v.accountId) ||
      config.accounts.find(x => x.addr === v.from) ||
      config.accounts.find(x => (x.aliases || []).some(al => al.addr === v.from));
    if (!acc) throw new ErreurHttp(400, 'Aucune boîte ne correspond à cet expéditeur');
    if (!acc.smtpHost) throw new ErreurHttp(400, `Pas de serveur SMTP réglé sur ${acc.addr}`);
    const from = String(v.from || acc.addr).toLowerCase();
    if (from !== acc.addr) {
      const al = (acc.aliases || []).find(x => x.addr === from);
      if (!al) throw new ErreurHttp(400, `${from} n'est pas un alias de ${acc.addr}`);
      if (al.send === false) throw new ErreurHttp(403, `L'envoi depuis ${from} est désactivé`);
    }
    if (!v.to || !v.subject) throw new ErreurHttp(400, 'Destinataire ou objet manquant');
    const destinataires = (Array.isArray(v.to) ? v.to : String(v.to).split(/[,;]/)).map(x => String(x).trim()).filter(Boolean);
    if (!destinataires.length || destinataires.length > 50 || !destinataires.every(d => COURRIEL.test(d))) {
      throw new ErreurHttp(400, 'Adresse du destinataire invalide');
    }
    try {
      const res = await smtp.send({
        host: acc.smtpHost, port: acc.smtpPort || 587,
        user: acc.imapUser || acc.addr, pass: depot.motDePasse(acc),
        epingle: acc.smtpPin || '',
        surEpingle: vue => { acc.smtpPin = vue; depot.saveConfig(); journal.ecrire({ acteur: 'système', action: 'boite.certificat_epingle', objet: acc.id, details: { serveur: 'smtp', empreinte: vue } }); },
        from, fromName: v.fromName || acc.name,
        to: destinataires, subject: v.subject, text: v.text || '',
        inReplyTo: v.inReplyTo, references: v.inReplyTo,
      });
      // On garde une copie : sinon il ne resterait qu'une ligne de journal.
      state.messages.unshift({
        id: 'envoi:' + crypto.randomUUID(), sent: true,
        accountId: acc.id, account: acc.addr,
        fromName: v.fromName || acc.name, fromAddr: from,
        toList: destinataires, ccList: [], deliveredTo: [],
        subject: v.subject, messageId: res.messageId,
        date: new Date().toUTCString(), receivedAt: new Date().toISOString(),
        text: v.text || '', html: '', imagesMasquees: 0,
        unread: false, folder: null, ticketId: null,
      });
      releve.logLine({ kind: 'envoi', from, to: destinataires.join(', '), what: v.subject });
      depot.saveState();
      trace(ctx, a, 'courriel.envoye', acc.id, { destinataires: destinataires.length });
      return { ok: true, messageId: res.messageId };
    } catch (e) {
      // L'erreur SMTP est rendue telle quelle : c'est elle qui dit quoi corriger.
      releve.logLine({ kind: 'erreur', from, to: destinataires.join(', '), what: e.message });
      depot.saveState();
      repondreJson(ctx.res, 502, { error: e.message, code: e.code || null, ...(e.empreinte ? { empreinte: e.empreinte } : {}) });
    }
  }, { role: 'membre' });

  r.get('/api/settings', ctx => { acces(ctx, { role: 'lecture', machine: 'lecture' }); return snapshot().settings; }, { role: 'lecture' });

  r.patch('/api/settings', async ctx => {
    const a = acces(ctx, { role: 'admin' });
    const { v } = await corps(ctx, S.reglages);
    // Changer où partent les tickets, ou avec quels secrets : confirmation récente.
    const sensible = v.webhook?.url !== undefined || v.webhook?.key || v.webhook?.secret || v.telegram?.token || v.telegram?.chatId !== undefined || v.api;
    if (sensible) socle.comptes.exigerRenfort(a.session);
    const s = config.settings;
    if (v.pollSeconds !== undefined) s.pollSeconds = v.pollSeconds;
    if (v.dedupMinutes !== undefined) s.dedupMinutes = v.dedupMinutes;
    if (v.retentionDays !== undefined) s.retentionDays = v.retentionDays;
    if (v.api?.origins) {
      const origines = v.api.origins.map(o => o.trim().replace(/\/$/, '')).filter(Boolean);
      if (!origines.every(o => ORIGINE.test(o))) throw new ErreurHttp(400, 'Origine invalide : une adresse complète (https://exemple.fr), jamais « * ».');
      s.api.origins = origines;
    }
    if (v.webhook) {
      const w = s.webhook;
      if (v.webhook.enabled !== undefined) w.enabled = v.webhook.enabled;
      if (v.webhook.url !== undefined) {
        const url = v.webhook.url.trim();
        if (url && !adresseWebhook(url)) throw new ErreurHttp(400, 'Adresse du webhook : http:// ou https://, sans identifiants.');
        w.url = url;
      }
      if (v.webhook.keyHeader !== undefined) {
        const nom = v.webhook.keyHeader.trim().toLowerCase();
        w.keyHeader = /^[a-z0-9-]{1,40}$/.test(nom) ? nom : 'x-cachet-key';
      }
      if (v.webhook.key) w.key = depot.sceller('webhook', v.webhook.key, 'cle');
      if (v.webhook.secret) w.secret = depot.sceller('webhook', v.webhook.secret, 'signature');
    }
    if (v.telegram) {
      const t = s.telegram;
      if (v.telegram.enabled !== undefined) t.enabled = v.telegram.enabled;
      if (v.telegram.chatId !== undefined) t.chatId = v.telegram.chatId;
      if (v.telegram.minUrgency) t.minUrgency = v.telegram.minUrgency;
      if (v.telegram.token) t.token = depot.sceller('telegram', v.telegram.token, 'jeton');
    }
    depot.saveConfig();
    trace(ctx, a, 'reglages.modifies', null, { champs: Object.keys(v) });
    if (v.pollSeconds !== undefined) releve.start();
    return { ok: true };
  }, { role: 'admin' });

  // Les clés ne se relisent pas : CACHET n'en garde que l'empreinte. Cette
  // route dit lesquelles existent ; une clé se voit une fois, à sa création.
  r.get('/api/apikey', ctx => {
    acces(ctx, { role: 'admin' });
    return { cles: depot.clesPosees(), origins: config.settings.api.origins || [] };
  }, { role: 'admin' });

  // Créer une clé, c'est aussi retirer l'ancienne : administrateur, identité confirmée.
  r.post('/api/apikey/rotate', ctx => {
    const a = acces(ctx, { role: 'admin', renfort: true });
    const envoi = ctx.url.searchParams.get('quoi') === 'envoi';
    const v = depot.nouvelleCle(envoi ? 'envoi' : 'complete');
    trace(ctx, a, 'cle.tournee', envoi ? 'envoi' : 'complete');
    return envoi ? { sendKey: v } : { key: v };
  }, { role: 'admin' });

  r.post('/api/webhook/test', async ctx => {
    acces(ctx, { role: 'admin' });
    const faux = {
      id: 'TCK-TEST', service: 'Cachet', subject: 'Essai de liaison', host: '', urgency: 'basse', status: 'nouveau',
      auto: false, via: null, occurrences: 1, createdAt: new Date().toISOString(), history: [],
    };
    const ok = await webhook.envoyer('ticket.test', faux);
    return { ok, ...webhook.statut() };
  }, { role: 'admin' });

  // CORS : seules les origines déclarées, jamais « * » ni de cookie. Un front
  // servi d'ailleurs appelle avec une clé, pas avec la session de quelqu'un.
  function cors(ctx) {
    const o = ctx.req.headers.origin;
    if (!o || !(config.settings.api.origins || []).includes(o)) return false;
    const h = ctx.res;
    h.setHeader('Access-Control-Allow-Origin', o);
    h.setHeader('Vary', 'Origin');
    h.setHeader('Access-Control-Allow-Methods', 'GET,POST,PATCH,DELETE,OPTIONS');
    h.setHeader('Access-Control-Allow-Headers', 'content-type,x-cachet-key,authorization');
    h.setHeader('Access-Control-Max-Age', '600');
    return true;
  }

  return {
    async traiter(ctx) {
      const p = ctx.url.pathname;
      if (p !== '/api' && !p.startsWith('/api/')) return false;
      const corsOk = cors(ctx);
      if (ctx.req.method === 'OPTIONS') { ctx.res.writeHead(corsOk ? 204 : 403).end(); return true; }
      let t = r.trouver(ctx.req.method, p);
      // Un client peut ranger ses appels sous son propre préfixe.
      const m = /^\/api\/[a-z0-9_-]+\/(.+)$/i.exec(p);
      if ((!t || t.methodes) && m) {
        const t2 = r.trouver(ctx.req.method, '/api/' + m[1]);
        if (t2 && !t2.methodes) t = t2;
      }
      if (!t) { repondreJson(ctx.res, 404, { error: 'Route inconnue', method: ctx.req.method, path: p.slice(0, 200), hint: 'GET /api liste les routes disponibles' }); return true; }
      if (t.methodes) { ctx.res.setHeader('Allow', t.methodes.join(', ')); throw new ErreurHttp(405, 'Méthode non admise.'); }
      if (Object.values(t.params).some(v => !PARAM.test(v))) throw new ErreurHttp(404, 'Introuvable.');
      ctx.params = t.params;
      const reponse = await t.route.gestionnaire(ctx);
      if (reponse !== undefined && !ctx.res.headersSent) repondreJson(ctx.res, 200, reponse);
      return true;
    },
    routeur: r,
  };
}
