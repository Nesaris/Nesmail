// Configuration de RAVYN, lue et validée une fois au démarrage. Les variables
// SOCLE_* (comptes, relais, clé maîtresse, gamme) sont lues par le socle. Une
// valeur invalide arrête le processus avec la liste complète des erreurs.
import { lireConfig } from '../socle/src/index.js';

export const VERSION = '2.0.2';

// Le service s'appelait CACHET : un ancien .env (CACHET_*) vaut encore, le nouveau nom l'emporte.
function avecAnciensNoms(env) {
  const out = { ...env };
  for (const [k, v] of Object.entries(env)) {
    const neuf = k.replace(/^CACHET_/, 'RAVYN_');
    if (neuf !== k && out[neuf] === undefined) out[neuf] = v;
  }
  return out;
}

export function lireConfigRavyn(env = process.env) {
  env = avecAnciensNoms(env);
  return lireConfig({
    port: { env: 'PORT', type: 'entier', min: 0, max: 65535, defaut: 8787 },
    hote: { env: 'HOTE', type: 'chaine', defaut: '0.0.0.0' },
    donnees: { env: 'RAVYN_DATA', type: 'chaine', defaut: '/data' },
    // Jeton de service du Hub : ouvre l'API des messages, des tickets et de
    // l'envoi, comme la clé d'API complète ; jamais les comptes, les boîtes, les
    // règles ni les réglages, qui demandent une personne connectée.
    jetonHub: { env: 'RAVYN_HUB_TOKEN', type: 'secret', min: 24 },
    // Reprise d'une 1.0 : son CACHET_SECRET rouvre les mots de passe des boîtes
    // et les clés enregistrés, qui sont rescellés sous la clé maîtresse. Inutile
    // ensuite.
    secretV1: { env: 'RAVYN_SECRET_V1', type: 'secret', min: 1 },
    // Envois par minute, toutes clés confondues : une clé d'envoi volée ne fait
    // pas de RAVYN un relais de pourriel.
    envoisMinute: { env: 'RAVYN_ENVOIS_MINUTE', type: 'entier', min: 1, max: 600, defaut: 30 },
  }, env);
}
