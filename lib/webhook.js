'use strict';
// Webhook sortant : prévient un service externe à chaque événement de ticket.
const crypto = require('node:crypto');
const { config, decrypt } = require('./store');

let dernier = { at: null, ok: null, status: null, error: null };

function signature(corps, secret) {
  return 'sha256=' + crypto.createHmac('sha256', secret).update(corps).digest('hex');
}

async function envoyer(evenement, ticket) {
  const w = (config.settings && config.settings.webhook) || {};
  if (!w.enabled || !w.url) return false;

  const corps = JSON.stringify({ event: evenement, ticket, at: new Date().toISOString() });
  const entetes = { 'content-type': 'application/json', 'user-agent': 'Cachet/1.0' };

  // Le nom de l'en-tête est réglable : chaque service attend le sien.
  if (w.key) {
    const nom = String(w.keyHeader || 'x-cachet-key').toLowerCase();
    const valeur = decrypt(w.key);
    entetes[nom] = nom === 'authorization' ? `Bearer ${valeur}` : valeur;
  }
  if (w.secret) entetes['x-cachet-signature'] = signature(corps, decrypt(w.secret));

  try {
    const r = await fetch(w.url, {
      method: 'POST', headers: entetes, body: corps, signal: AbortSignal.timeout(8000)
    });
    dernier = { at: new Date().toISOString(), ok: r.ok, status: r.status, error: r.ok ? null : `HTTP ${r.status}` };
    return r.ok;
  } catch (e) {
    dernier = { at: new Date().toISOString(), ok: false, status: null, error: e.message };
    return false;
  }
}

module.exports = { envoyer, statut: () => dernier, signature };
