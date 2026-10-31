// Webhook sortant : prévient un service externe à chaque événement de ticket.
// L'adresse est réglée par un administrateur sous renfort ; seules http: et
// https: partent, sans suivre de redirection (une redirection mènerait ailleurs
// que là où l'administrateur a dit), avec un délai court, et jamais vers des
// métadonnées de nuage ni une plage réservée, au moment même de la connexion.
import crypto from 'node:crypto';
import http from 'node:http';
import https from 'node:https';
import { lookupGarde, hoteInterdit } from './reseau.js';

export function signature(corps, secret) {
  return 'sha256=' + crypto.createHmac('sha256', secret).update(corps).digest('hex');
}

export function adresseWebhook(v) {
  try {
    const u = new URL(String(v));
    if (!['http:', 'https:'].includes(u.protocol) || u.username || u.password || hoteInterdit(u.hostname)) return null;
    return u.toString();
  } catch { return null; }
}

// Un POST, une réponse : le corps rendu n'est jamais lu au-delà de son statut.
function poster(url, corps, entetes, { delai = 8000 } = {}) {
  const u = new URL(url);
  const client = u.protocol === 'https:' ? https : http;
  return new Promise((resolve, reject) => {
    const r = client.request(u, { method: 'POST', headers: { ...entetes, 'content-length': Buffer.byteLength(corps) }, lookup: lookupGarde, timeout: delai, minVersion: 'TLSv1.2' }, reponse => {
      reponse.resume();
      resolve({ status: reponse.statusCode, ok: reponse.statusCode >= 200 && reponse.statusCode < 300 });
    });
    r.on('timeout', () => r.destroy(Object.assign(new Error('délai dépassé'), { name: 'TimeoutError' })));
    r.on('error', reject);
    r.end(corps);
  });
}

export function creerWebhook(depot, { envoyer: envoi = poster } = {}) {
  let dernier = { at: null, ok: null, status: null, error: null };

  // Ne rejette jamais : le résultat est gardé pour Réglages (« dernier appel »).
  async function envoyer(evenement, ticket) {
    const w = depot.config.settings.webhook || {};
    if (!w.enabled || !w.url || !adresseWebhook(w.url)) return false;
    const corps = JSON.stringify({ event: evenement, ticket, at: new Date().toISOString() });
    const entetes = { 'content-type': 'application/json', 'user-agent': 'Nesmail/2' };
    try {
      // Le nom de l'en-tête est réglable : chaque service attend le sien.
      if (w.key) {
        const nom = String(w.keyHeader || 'x-nesmail-key').toLowerCase();
        const valeur = depot.ouvrir('webhook', w.key, 'cle');
        entetes[nom] = nom === 'authorization' ? `Bearer ${valeur}` : valeur;
      }
      // Signature sous les trois noms : un récepteur réglé du temps de CACHET ou de RAVYN la vérifie encore.
      if (w.secret) entetes['x-nesmail-signature'] = entetes['x-ravyn-signature'] = entetes['x-cachet-signature'] = signature(corps, depot.ouvrir('webhook', w.secret, 'signature'));
      const r = await envoi(w.url, corps, entetes);
      dernier = { at: new Date().toISOString(), ok: r.ok, status: r.status, error: r.ok ? null : `HTTP ${r.status}` };
      return r.ok;
    } catch (e) {
      dernier = { at: new Date().toISOString(), ok: false, status: null, error: e.name === 'TimeoutError' ? 'délai dépassé' : e.code === 'EINTERDITE' ? 'adresse interdite' : 'injoignable' };
      return false;
    }
  }

  return { envoyer, statut: () => dernier };
}
