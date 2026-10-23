// Administration de CACHET en ligne de commande, dans le conteneur :
//   docker exec <cachet> node lib/cli.js <commande>
//
// Chaque geste laisse sa trace au journal de sécurité, chaîné comme celui du
// service, qui tourne pendant ce temps : la base est en WAL, les deux écrivent
// sans se bloquer.
//
// La sauvegarde est chiffrée pour une clé publique dont la clé privée ne vit
// pas sur la machine de CACHET : qui prend la machine ne relit pas les
// sauvegardes. Elle garde les secrets scellés sous SOCLE_CLE : sans une copie
// de cette clé, une base restaurée ne rouvre ni les boîtes ni les TOTP.
import fs from 'node:fs';
import { lireConfigCachet, VERSION } from './config.js';
import { ouvrirBase } from './base.js';
import { Journal, sauvegarder, dechiffrer } from '../socle/src/index.js';

const [, , cmd, ...rest] = process.argv;

function die(m) { console.error('erreur : ' + m); process.exit(1); }

// Sur la machine qui garde la clé privée : aucune base, aucune configuration.
function restaurer(prive, cible) {
  if (!prive || !cible) die('usage : restaurer <clé-privée.pem> <cible.db> < cachet.sauv');
  if (fs.existsSync(cible)) die(`${cible} existe déjà : la restauration écrit un fichier neuf`);
  let lu;
  try { lu = dechiffrer(fs.readFileSync(0), fs.readFileSync(prive, 'utf8')); } catch (e) { die(`sauvegarde illisible avec cette clé (${e.message})`); }
  if (lu.entete.service !== 'cachet') die(`sauvegarde de ${lu.entete.service}, pas de CACHET`);
  fs.writeFileSync(cible, lu.base, { mode: 0o600, flag: 'wx' });
  process.stderr.write(`Base de CACHET ${lu.entete.version} du ${lu.entete.date} restaurée dans ${cible}.\n`);
}
if (cmd === 'restaurer') { restaurer(rest[0], rest[1]); process.exit(0); }

function usage() {
  console.log(`CACHET — administration

  sauvegarde < clé-publique.pem > cachet.sauv
  restaurer <clé-privée.pem> <cible.db> < cachet.sauv     (sur une autre machine)

Les comptes, les clés d'API et les boîtes se gèrent dans l'interface ; les
clés d'API se régénèrent dans Réglages (runbook d'incident : SECURITY.md).`);
}

const db = ouvrirBase(lireConfigCachet().donnees);
const journal = new Journal(db);

// La clé publique arrive sur l'entrée, la sauvegarde part sur la sortie : rien
// de sensible n'est écrit dans le conteneur.
async function sauvegarde() {
  if (process.stdout.isTTY) die('redirige la sortie : node lib/cli.js sauvegarde < sauvegarde.pub > cachet.sauv');
  let sortie;
  try { sortie = await sauvegarder(db, fs.readFileSync(0, 'utf8'), { service: 'cachet', version: VERSION }); } catch (e) { die(e.message); }
  journal.ecrire({ action: 'sauvegarde.faite', details: { par: 'ligne de commande', octets: sortie.length } });
  process.stdout.write(sortie);
}

switch (cmd) {
  case 'sauvegarde': await sauvegarde(); break;
  default: usage();
}
db.close();
