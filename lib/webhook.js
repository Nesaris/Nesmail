// Webhook sortant : prévient un service externe à chaque événement de ticket.
// L'adresse est réglée par un administrateur ; seules http: et https: partent,
// sans suivre de redirection (une redirection mènerait ailleurs que là où
// l'administrateur a dit), avec un délai court.
import crypto from 'node:crypto';

export function signature(corps, secret) {
  return 'sha256=' + crypto.createHmac('sha256', secret).update(corps).digest('hex');
}

export function adresseWebhook(v) {
  try {
    const u = new URL(String(v));
    return ['http:', 'https:'].includes(u.protocol) && !u.username && !u.password ? u.toString() : null;
  } catch { return null; }
}

export function creerWebhook(depot, { fetch: tirer = fetch } = {}) {
  let dernier = { at: null, ok: null, status: null, error: null };

  async function envoyer(evenement, ticket) {
    const w = depot.config.settings.webhook || {};
    if (!w.enabled || !w.url || !adresseWebhook(w.url)) return false;
    const corps = JSON.stringify({ event: evenement, ticket, at: new Date().toISOString() });
    const entetes = { 'content-type': 'application/json', 'user-agent': 'Cachet/2' };
    try {
      // Le nom de l'en-tête est réglable : chaque service attend le sien.
      if (w.key) {
        const nom = String(w.keyHeader || 'x-cachet-key').toLowerCase();
        const valeur = depot.ouvrir('webhook', w.key, 'cle');
        entetes[nom] = nom === 'authorization' ? `Bearer ${valeur}` : valeur;
      }
      if (w.secret) entetes['x-cachet-signature'] = signature(corps, depot.ouvrir('webhook', w.secret, 'signature'));
      const r = await tirer(w.url, { method: 'POST', headers: entetes, body: corps, redirect: 'manual', signal: AbortSignal.timeout(8000) });
      dernier = { at: new Date().toISOString(), ok: r.ok, status: r.status, error: r.ok ? null : `HTTP ${r.status}` };
      return r.ok;
    } catch (e) {
      dernier = { at: new Date().toISOString(), ok: false, status: null, error: e.name === 'TimeoutError' ? 'délai dépassé' : 'injoignable' };
      return false;
    }
  }

  return { envoyer, statut: () => dernier };
}
