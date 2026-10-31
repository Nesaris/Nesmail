// Configuration de Nesmail, lue et validée une fois au démarrage. Les variables
// SOCLE_* (comptes, relais, clé maîtresse, gamme) sont lues par le socle. Une
// valeur invalide arrête le processus avec la liste complète des erreurs.
import { lireConfig } from '../socle/src/index.js';

export const VERSION = '2.2.0';

// Le service s'est appelé CACHET puis RAVYN : un ancien .env (CACHET_*, RAVYN_*)
// vaut encore, le nouveau nom l'emporte, puis le plus récent des anciens.
function avecAnciensNoms(env) {
  const out = { ...env };
  for (const prefixe of ['RAVYN_', 'CACHET_']) {
    for (const [k, v] of Object.entries(env)) {
      if (!k.startsWith(prefixe)) continue;
      const neuf = 'NESMAIL_' + k.slice(prefixe.length);
      if (out[neuf] === undefined) out[neuf] = v;
    }
  }
  return out;
}

export const SPEC_NESMAIL = {
  port: { env: 'PORT', type: 'entier', min: 0, max: 65535, defaut: 8787 },
  hote: { env: 'HOTE', type: 'chaine', defaut: '0.0.0.0' },
  donnees: { env: 'NESMAIL_DATA', type: 'chaine', defaut: '/data' },
  // Jeton de service du Hub : ouvre l'API des messages, des tickets et de
  // l'envoi, comme la clé d'API complète ; jamais les comptes, les boîtes, les
  // règles ni les réglages, qui demandent une personne connectée.
  jetonHub: { env: 'NESMAIL_HUB_TOKEN', type: 'secret', min: 24 },
  // Reprise d'une 1.0 : son CACHET_SECRET rouvre les mots de passe des boîtes
  // et les clés enregistrés, qui sont rescellés sous la clé maîtresse. Inutile
  // ensuite.
  secretV1: { env: 'NESMAIL_SECRET_V1', type: 'secret', min: 1 },
  // Envois par minute, toutes clés confondues : une clé d'envoi volée ne fait
  // pas de Nesmail un relais de pourriel.
  envoisMinute: { env: 'NESMAIL_ENVOIS_MINUTE', type: 'entier', min: 1, max: 600, defaut: 30 },
};

// Ce que l'assistant de configuration demande (première installation, puis
// seulement les réglages nouveaux d'une mise à jour). depuis : la version qui
// a ajouté le réglage. Les boîtes, elles, s'ajoutent dans l'interface.
export const REGLAGES_NESMAIL = [
  { env: 'NESMAIL_ENVOIS_MINUTE', groupe: 'Envois', libelle: 'Courriels envoyés par minute au plus', depuis: '2.2.0',
    aide: 'Toutes clés d’envoi confondues : une clé volée ne fait pas de Nesmail un relais de pourriel.' },
];

export function lireConfigNesmail(env = process.env) {
  env = avecAnciensNoms(env);
  return lireConfig(SPEC_NESMAIL, env);
}
