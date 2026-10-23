// Persistance de CACHET : une base SQLite (node:sqlite) dans le volume de
// données. Le socle y range ses comptes, sessions et journal ; CACHET y garde
// deux documents JSON, la configuration (boîtes, alias, dossiers, règles,
// réglages) et l'état (messages relevés, tickets, journal des relèves). Un seul
// fichier à sauvegarder, écrit de façon atomique par SQLite.
//
// Les secrets (mots de passe des boîtes, clés d'API, clé du webhook, jeton
// Telegram) sont scellés sous la clé maîtresse du socle, chacun lié à son
// propriétaire : un secret copié d'une ligne à une autre ne s'ouvre plus.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { PREMIERE } from './tls.js';

export const DEFAUT_CONFIG = {
  accounts: [],
  folders: [],
  rules: [],
  settings: {
    pollSeconds: 120,
    dedupMinutes: 30,
    retentionDays: 30,
    telegram: { enabled: false, token: '', chatId: '', minUrgency: 'haute' },
    api: { key: '', sendKey: '', origins: [] },
    webhook: { enabled: false, url: '', key: '', keyHeader: 'x-cachet-key', secret: '' },
  },
};
export const DEFAUT_ETAT = { messages: [], tickets: [], log: [], seq: 1, uidState: {}, rescan: {} };

export function ouvrirBase(dossier) {
  fs.mkdirSync(dossier, { recursive: true, mode: 0o700 });
  const fichier = path.join(dossier, 'cachet.db');
  // La base garde des secrets scellés et le courrier relevé : lisible par
  // CACHET seul. SQLite donne aux journaux WAL les droits de la base.
  fs.closeSync(fs.openSync(fichier, 'a', 0o600));
  for (const f of [fichier, fichier + '-wal', fichier + '-shm']) if (fs.existsSync(f)) fs.chmodSync(f, 0o600);
  const db = new DatabaseSync(fichier);
  db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000; PRAGMA synchronous = NORMAL;');
  db.exec('CREATE TABLE IF NOT EXISTS cachet_documents (nom TEXT PRIMARY KEY, json TEXT NOT NULL, modifie INTEGER NOT NULL)');
  return db;
}

// Les usages du coffre : une sous-clé chacun.
const U = { boite: 'cachet:boite', cle: 'cachet:cle', webhook: 'cachet:webhook', telegram: 'cachet:telegram' };

export class Depot {
  constructor(db, { coffre, log = console }) {
    this.db = db; this.coffre = coffre; this.log = log;
    this.config = completerConfig(this.lire('config') ?? structuredClone(DEFAUT_CONFIG));
    this.state = completerEtat(this.lire('etat') ?? structuredClone(DEFAUT_ETAT));
    this.sale = false;
    // L'état change à chaque relève : écrit au plus toutes les deux secondes.
    this.minuterie = setInterval(() => this.flush(), 2000);
    this.minuterie.unref?.();
  }

  lire(nom) {
    const l = this.db.prepare('SELECT json FROM cachet_documents WHERE nom = ?').get(nom);
    return l ? JSON.parse(l.json) : null;
  }

  ecrire(nom, valeur) {
    this.db.prepare('INSERT INTO cachet_documents(nom, json, modifie) VALUES (?, ?, ?) ON CONFLICT(nom) DO UPDATE SET json = excluded.json, modifie = excluded.modifie')
      .run(nom, JSON.stringify(valeur), Math.floor(Date.now() / 1000));
  }

  // La configuration change rarement mais compte : écrite aussitôt.
  saveConfig() { this.ecrire('config', this.config); }
  saveState() { this.sale = true; }
  flush() { if (this.sale) { this.ecrire('etat', this.state); this.sale = false; } }
  arreter() { clearInterval(this.minuterie); this.flush(); }

  sceller(usage, clair, aad = '') { return clair ? this.coffre.scelle(U[usage], clair, aad) : ''; }
  ouvrir(usage, scelle, aad = '') {
    if (!scelle) return '';
    try { return this.coffre.ouvre(U[usage], scelle, aad); }
    catch { throw new Error('Secret illisible sous la clé maîtresse actuelle : ressaisis-le.'); }
  }

  // Mot de passe d'une boîte, lié à son identifiant.
  motDePasse(acc) { return this.ouvrir('boite', acc.imapPass, acc.id); }

  // Clés d'API : 'complete' ou 'envoi'. Créées au premier démarrage.
  cle(quelle) { return this.ouvrir('cle', quelle === 'envoi' ? this.config.settings.api.sendKey : this.config.settings.api.key, quelle); }
  nouvelleCle(quelle) {
    const v = (quelle === 'envoi' ? 'sk_' : 'pk_') + crypto.randomBytes(24).toString('base64url');
    this.config.settings.api[quelle === 'envoi' ? 'sendKey' : 'key'] = this.sceller('cle', v, quelle);
    this.saveConfig();
    return v;
  }
  assurerCles() {
    for (const q of ['complete', 'envoi']) {
      try { if (this.cle(q)) continue; } catch { /* illisible : remplacée */ }
      this.nouvelleCle(q);
    }
  }

  // Après une rotation de SOCLE_CLE : chaque secret relu sous l'ancienne clé est
  // rescellé sous la neuve. Rend le nombre de secrets rescellés et retirés.
  resceller(ancien) {
    const n = { rescelles: 0, retires: 0 };
    const tourne = (usage, valeur, aad) => {
      if (!valeur) return valeur;
      try { this.coffre.ouvre(U[usage], valeur, aad); return valeur; } catch { /* pas sous la clé actuelle */ }
      try { const clair = ancien.ouvre(U[usage], valeur, aad); n.rescelles++; return this.coffre.scelle(U[usage], clair, aad); }
      catch { n.retires++; return ''; }
    };
    this.parcourirSecrets(tourne);
    if (n.rescelles || n.retires) this.saveConfig();
    return n;
  }

  parcourirSecrets(fn) {
    const s = this.config.settings;
    for (const a of this.config.accounts) a.imapPass = fn('boite', a.imapPass, a.id);
    s.api.key = fn('cle', s.api.key, 'complete');
    s.api.sendKey = fn('cle', s.api.sendKey, 'envoi');
    s.webhook.key = fn('webhook', s.webhook.key, 'cle');
    s.webhook.secret = fn('webhook', s.webhook.secret, 'signature');
    s.telegram.token = fn('telegram', s.telegram.token, 'jeton');
  }

  // Reprise d'une 1.0 : config.json et state.json du volume, une fois. Les
  // secrets chiffrés sous CACHET_SECRET sont rescellés sous la clé maîtresse ;
  // sans ce secret, ils sont retirés et se ressaisissent. Le mot de passe
  // unique de la 1.0 ne passe pas : les comptes sont ceux du socle. Les
  // fichiers sont renommés, jamais relus.
  reprendreV1(dossier, secretV1) {
    const fc = path.join(dossier, 'config.json'), fe = path.join(dossier, 'state.json');
    if (!fs.existsSync(fc) || this.lire('config')) return null;
    const v1 = JSON.parse(fs.readFileSync(fc, 'utf8'));
    const etat = fs.existsSync(fe) ? JSON.parse(fs.readFileSync(fe, 'utf8')) : structuredClone(DEFAUT_ETAT);
    const cle = secretV1 ? crypto.createHash('sha256').update(secretV1).digest() : null;
    const bilan = { boites: 0, secrets: 0, perdus: 0 };
    const ouvrirV1 = v => {
      if (!v) return '';
      if (!String(v).startsWith('enc:')) return String(v);
      if (!cle) { bilan.perdus++; return ''; }
      const b = Buffer.from(String(v).slice(4), 'base64');
      try {
        const d = crypto.createDecipheriv('aes-256-gcm', cle, b.subarray(0, 12));
        d.setAuthTag(b.subarray(12, 28));
        return Buffer.concat([d.update(b.subarray(28)), d.final()]).toString('utf8');
      } catch { bilan.perdus++; return ''; }
    };
    delete v1.admin;
    this.config = completerConfig(v1);
    for (const a of this.config.accounts) {
      bilan.boites++;
      // « Accepter un auto-signé » devient l'épinglage du certificat vu à la
      // prochaine connexion ; TLS n'est plus jamais facultatif.
      if (a.insecureTls) { a.imapPin = PREMIERE; a.smtpPin = PREMIERE; }
      delete a.insecureTls;
    }
    this.parcourirSecrets((usage, valeur, aad) => {
      const clair = ouvrirV1(valeur);
      if (clair) bilan.secrets++;
      return this.sceller(usage, clair, aad);
    });
    this.state = completerEtat(etat);
    this.saveConfig();
    this.ecrire('etat', this.state);
    const suffixe = `.v1-reprise-${Date.now()}`;
    fs.renameSync(fc, fc + suffixe);
    if (fs.existsSync(fe)) fs.renameSync(fe, fe + suffixe);
    return bilan;
  }
}

// Complète les champs absents après une mise à jour de version.
function completerConfig(c) {
  const config = { ...structuredClone(DEFAUT_CONFIG), ...c };
  config.settings = Object.assign(structuredClone(DEFAUT_CONFIG.settings), c.settings);
  for (const k of ['telegram', 'api', 'webhook']) config.settings[k] = Object.assign({}, DEFAUT_CONFIG.settings[k], c.settings?.[k]);
  for (const k of ['accounts', 'folders', 'rules']) if (!Array.isArray(config[k])) config[k] = [];
  for (const a of config.accounts) { a.imapPin ??= ''; a.smtpPin ??= ''; }
  return config;
}

function completerEtat(e) {
  const etat = { ...e };
  for (const k of Object.keys(DEFAUT_ETAT)) if (etat[k] === undefined) etat[k] = structuredClone(DEFAUT_ETAT[k]);
  return etat;
}
