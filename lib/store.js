'use strict';
// Persistance : deux fichiers JSON écrits de façon atomique.
//   config.json — comptes, alias, dossiers, règles, réglages (secrets chiffrés au repos)
//   state.json  — messages relevés, tickets, journal
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const DIR = process.env.CACHET_DATA || path.join(__dirname, '..', 'data');
const SECRET = process.env.CACHET_SECRET || '';

try {
  if (!fs.existsSync(DIR)) fs.mkdirSync(DIR, { recursive: true, mode: 0o700 });
  fs.accessSync(DIR, fs.constants.W_OK);
} catch (e) {
  const uid = typeof process.getuid === 'function' ? process.getuid() : '?';
  console.error(
    `\n  Cachet ne peut pas écrire dans ${DIR} (${e.code}).\n` +
    `  Le processus tourne en uid ${uid}, le dossier ne lui appartient pas.\n\n` +
    `  Volume nommé : docker compose down && docker volume rm cachet_cachet-data && docker compose up -d\n` +
    `  Bind mount   : sudo chown -R 10001:10001 ./data && docker compose up -d\n`
  );
  process.exit(1);
}

function key() {
  if (!SECRET) throw new Error('CACHET_SECRET manquant : impossible de chiffrer les secrets.');
  return crypto.createHash('sha256').update(SECRET).digest();
}

class SecretMismatch extends Error {}

function encrypt(plain) {
  if (plain === null || plain === undefined || plain === '') return '';
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', key(), iv);
  const out = Buffer.concat([c.update(String(plain), 'utf8'), c.final()]);
  return 'enc:' + Buffer.concat([iv, c.getAuthTag(), out]).toString('base64');
}

function decrypt(value) {
  if (!value) return '';
  if (!String(value).startsWith('enc:')) return String(value);
  const buf = Buffer.from(String(value).slice(4), 'base64');
  try {
    const d = crypto.createDecipheriv('aes-256-gcm', key(), buf.subarray(0, 12));
    d.setAuthTag(buf.subarray(12, 28));
    return Buffer.concat([d.update(buf.subarray(28)), d.final()]).toString('utf8');
  } catch {
    throw new SecretMismatch(
      'Secret illisible : CACHET_SECRET a changé depuis son enregistrement. ' +
      'Ressaisissez le mot de passe de la boîte dans Comptes.'
    );
  }
}

function writeAtomic(file, data) {
  const tmp = file + '.' + process.pid + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2), { mode: 0o600 });
  fs.renameSync(tmp, file);
}

function load(name, fallback) {
  const file = path.join(DIR, name);
  if (!fs.existsSync(file)) { writeAtomic(file, fallback); return structuredClone(fallback); }
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    const bad = file + '.corrompu.' + Date.now();
    fs.renameSync(file, bad);
    console.error(`[store] ${name} illisible, mis de côté dans ${path.basename(bad)}`);
    writeAtomic(file, fallback);
    return structuredClone(fallback);
  }
}

const DEFAULT_CONFIG = {
  accounts: [],
  folders: [],
  rules: [],
  settings: {
    pollSeconds: 120,
    dedupMinutes: 30,
    retentionDays: 30,
    telegram: { enabled: false, token: '', chatId: '', minUrgency: 'haute' },
    api: { key: '', sendKey: '', origins: [] },
    webhook: { enabled: false, url: '', key: '', keyHeader: 'x-cachet-key', secret: '' }
  }
};
const DEFAULT_STATE = { messages: [], tickets: [], log: [], seq: 1, uidState: {}, rescan: {} };

let config = load('config.json', DEFAULT_CONFIG);
let state = load('state.json', DEFAULT_STATE);

// Complète les champs absents après une mise à jour de version.
config.settings = Object.assign({}, DEFAULT_CONFIG.settings, config.settings);
for (const k of ['telegram', 'api', 'webhook']) {
  config.settings[k] = Object.assign({}, DEFAULT_CONFIG.settings[k], config.settings[k]);
}
for (const k of ['accounts', 'folders', 'rules']) {
  if (!Array.isArray(config[k])) config[k] = [];
}
for (const k of Object.keys(DEFAULT_STATE)) {
  if (state[k] === undefined) state[k] = structuredClone(DEFAULT_STATE[k]);
}

let stateDirty = false;
// La configuration change rarement mais compte : on l'écrit immédiatement.
// Un arrêt brutal dans les secondes suivant l'ajout d'une boîte la perdrait.
function saveConfig() { writeAtomic(path.join(DIR, 'config.json'), config); }
function saveState() { stateDirty = true; }
function flush() {
  if (stateDirty) { writeAtomic(path.join(DIR, 'state.json'), state); stateDirty = false; }
}
setInterval(flush, 2000).unref();
process.on('exit', flush);
for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => { flush(); process.exit(0); });

module.exports = { config, state, saveConfig, saveState, flush, encrypt, decrypt, SecretMismatch, DIR };
