'use strict';
const { config, decrypt } = require('./store');
const { RANK, URG } = require('./tickets');

async function notify(ticket) {
  const t = config.settings.telegram || {};
  if (!t.enabled || !t.token || !t.chatId) return false;
  if (RANK[ticket.urgency] < RANK[t.minUrgency || 'haute']) return false;

  const text = [
    `${ticket.id} · ${URG[ticket.urgency]}`,
    `${ticket.service}${ticket.host ? ' · ' + ticket.host : ''}`,
    ticket.subject
  ].join('\n');

  const res = await fetch(`https://api.telegram.org/bot${decrypt(t.token)}/sendMessage`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ chat_id: t.chatId, text, disable_notification: ticket.urgency !== 'crit' })
  });
  return res.ok;
}

module.exports = { notify };
