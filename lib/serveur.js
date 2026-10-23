// Démarrage de CACHET : configuration validée, base, socle commun (comptes,
// sessions, coffre, gamme), reprise d'une 1.0, relève des boîtes, serveur HTTP.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { lireConfigCachet, VERSION } from './config.js';
import { ouvrirBase, Depot } from './base.js';
import { creerReleve } from './poller.js';
import { creerWebhook } from './webhook.js';
import { creerTelegram } from './notify.js';
import { creerApi } from './api.js';
import {
  Debit, ErreurHttp, demarrerSocle, entetesSecurite, envelopper, nonceCsp, politiqueContenu,
  repondreErreur, repondreJson, servirFichier, GAMMES,
} from '../socle/src/index.js';

const RACINE = path.resolve(import.meta.dirname, '..');
const WEB = path.join(RACINE, 'public');
const PAGE = fs.readFileSync(path.join(WEB, 'index.html'), 'utf8').replaceAll('__VERSION__', encodeURIComponent(VERSION));
const CONSOLE = { info: (...a) => console.log(...a), warn: (...a) => console.warn(...a), error: (...a) => console.error(...a) };
// Signalement privé d'une faille, sur le dépôt : lu par le mainteneur.
const CONTACT_SECURITE = 'https://github.com/CodexX64/cachet/security/advisories/new';

export async function demarrer(env = process.env, { log = CONSOLE, fetch: tirer = fetch } = {}) {
  const cfg = lireConfigCachet(env);
  const db = ouvrirBase(cfg.donnees);
  const socle = await demarrerSocle({ service: { id: 'cachet', nom: 'CACHET', contactSecurite: CONTACT_SECURITE }, db, dossier: cfg.donnees, env, log });

  const depot = new Depot(db, { coffre: socle.coffre, log });
  const reprise = depot.reprendreV1(cfg.donnees, cfg.secretV1);
  if (reprise) {
    log.info?.(`[reprise] CACHET 1.0 repris : ${reprise.boites} boîte(s), ${reprise.secrets} secret(s) rescellé(s) sous la clé maîtresse.`);
    if (reprise.perdus) log.warn?.(`[reprise] ${reprise.perdus} secret(s) illisible(s) sans CACHET_SECRET_V1 : à ressaisir dans Comptes et Réglages.`);
    socle.journal.ecrire({ acteur: 'système', action: 'reprise.v1', details: reprise });
  }
  if (socle.coffre.precedente) {
    const n = depot.resceller(socle.coffre.precedente);
    if (n.rescelles || n.retires) log.info?.(`[coffre] ${n.rescelles} secret(s) de CACHET rescellé(s), ${n.retires} illisible(s) retiré(s).`);
  }

  const webhook = creerWebhook(depot);
  const notify = creerTelegram(depot, { fetch: tirer });
  const releve = creerReleve({ depot, notify, webhook, journal: socle.journal });
  const api = creerApi({ socle, cfg, depot, releve, webhook, version: VERSION, log });

  // Toute requête compte : une page en demande une vingtaine, une rafale des milliers.
  const debit = new Debit({ max: 900 });
  const serveur = http.createServer(envelopper(async (req, res) => {
    try {
      const url = new URL(req.url, 'http://cachet');
      const ctx = socle.portail.contexte(req, res);
      if (!debit.prendre(ctx.ip)) { socle.journal.rare(`debit:${ctx.ip}`, { action: 'limite.atteinte', objet: 'requetes', ip: ctx.ip, resultat: 'refus' }); throw new ErreurHttp(429, 'Trop de requêtes.'); }
      ctx.url = url;
      const nonce = nonceCsp();
      entetesSecurite(res, { secure: ctx.securise, csp: politiqueContenu({ nonce, secure: ctx.securise, connect: ["'self'"] }) });
      if (await socle.portail.traiter(req, res, url, ctx)) return;
      if (await api.traiter(ctx)) return;
      if (!['GET', 'HEAD'].includes(req.method)) return repondreJson(res, 405, { error: 'Méthode non admise.' });
      if (url.pathname.startsWith('/socle/') && servirFichier(req, res, path.join(RACINE, 'socle', 'web'), url.pathname.slice(6), { nonce, cache: 'public, max-age=3600' })) return;
      // La page porte la version dans l'adresse de ses fichiers : un relais qui
      // impose sa durée de cache au navigateur ne sert jamais l'interface
      // d'avant après une mise à jour. La page elle-même : no-store.
      const fichier = url.pathname === '/' ? '/index.html' : url.pathname;
      if (fichier === '/index.html') {
        const html = PAGE.replaceAll('__NONCE__', nonce).replaceAll('__GAMME__', GAMMES.includes(socle.cfg.gamme) ? socle.cfg.gamme : 'soma');
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', 'Content-Length': Buffer.byteLength(html) });
        return res.end(req.method === 'HEAD' ? undefined : html);
      }
      if (servirFichier(req, res, WEB, fichier, { nonce, gamme: socle.cfg.gamme })) return;
      repondreJson(res, 404, { error: 'Introuvable.' });
    } catch (e) { repondreErreur(res, e, { journal: log }); }
  }));

  serveur.headersTimeout = 20000;
  serveur.requestTimeout = 60000;
  serveur.keepAliveTimeout = 5000;
  await new Promise(r => serveur.listen(cfg.port, cfg.hote, r));
  log.info(`CACHET ${VERSION} à l'écoute sur ${cfg.hote}:${serveur.address().port}`);
  if (!depot.config.accounts.length) log.info('Aucune boîte configurée pour l’instant.');
  releve.start();

  const arreter = () => new Promise(r => {
    releve.stop(); socle.arreter(); depot.arreter();
    serveur.close(() => { db.close(); r(); });
    serveur.closeAllConnections?.();
  });
  return { serveur, socle, cfg, db, depot, releve, api, arreter };
}
