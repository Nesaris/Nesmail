// Alerte Telegram à l'ouverture d'un ticket, au-dessus d'un seuil d'urgence.
import { RANK, URG } from './tickets.js';

export const JETON_TELEGRAM = /^\d{5,15}:[A-Za-z0-9_-]{30,60}$/;

export function creerTelegram(depot, { fetch: tirer = fetch } = {}) {
  return async function notify(ticket) {
    const t = depot.config.settings.telegram || {};
    if (!t.enabled || !t.token || !t.chatId) return false;
    if (RANK[ticket.urgency] < RANK[t.minUrgency || 'haute']) return false;
    const text = [
      `${ticket.id} · ${URG[ticket.urgency]}`,
      `${ticket.service}${ticket.host ? ' · ' + ticket.host : ''}`,
      ticket.subject,
    ].join('\n');
    const jeton = depot.ouvrir('telegram', t.token, 'jeton');
    // Validé à l'enregistrement ; revérifié ici, il entre dans le chemin de l'URL.
    if (!JETON_TELEGRAM.test(jeton)) return false;
    const reponse = await tirer(`https://api.telegram.org/bot${jeton}/sendMessage`, {
      method: 'POST', redirect: 'error', signal: AbortSignal.timeout(8000),
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ chat_id: t.chatId, text, disable_notification: ticket.urgency !== 'crit' }),
    });
    return reponse.ok;
  };
}
