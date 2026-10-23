'use strict';
const { Imap } = require('./imap');
const mime = require('./mime');
const assainit = require('./html');
const regles = require('./rules');
const { ingest, RANK, aliasForMessage } = require('./tickets');
const { config, state, saveState, decrypt } = require('./store');
const { notify } = require('./notify');
const webhook = require('./webhook');

let inFlight = null;
let last = { at: null, ok: null, error: null, fetched: 0, durationMs: 0 };

function logLine(entry) {
  state.log.unshift({ at: new Date().toISOString(), ...entry });
  if (state.log.length > 500) state.log.length = 500;
}

function toMessage(acc, raw, uid) {
  const { headers, text, html } = mime.extractText(raw.body);
  const propre = html ? assainit.nettoie(html) : { html: '', imagesMasquees: 0 };
  const from = mime.addressOf(headers.from);
  return {
    id: `${acc.id}:${uid}`,
    uid,
    accountId: acc.id,
    account: acc.addr,
    fromName: from.name,
    fromAddr: from.addr,
    toList: mime.addressList(headers.to),
    ccList: mime.addressList(headers.cc),
    deliveredTo: [headers['delivered-to'], headers['x-original-to'], headers['envelope-to']]
      .filter(Boolean).map(v => mime.addressOf(v).addr),
    subject: mime.decodeWords(headers.subject) || '(sans objet)',
    messageId: headers['message-id'] || null,
    date: headers.date || raw.internaldate || new Date().toUTCString(),
    receivedAt: new Date().toISOString(),
    text: String(text || '').slice(0, 20000),
    html: propre.html.slice(0, 200000),
    imagesMasquees: propre.imagesMasquees,
    unread: !(raw.flags || []).includes('\\Seen'),
    folder: null,
    ticketId: null
  };
}

async function pollAccount(acc) {
  if (acc.disabled) return { fetched: 0 };
  const im = new Imap({
    host: acc.imapHost, port: acc.imapPort || 993,
    user: acc.imapUser || acc.addr, pass: decrypt(acc.imapPass),
    tls: acc.imapTls !== false,
    rejectUnauthorized: acc.insecureTls !== true
  });
  let fetched = 0;
  try {
    await im.connect();
    await im.login();
    await im.select(acc.folder || 'INBOX');

    const seen = state.uidState[acc.id] || { lastUid: 0 };
    const rescan = state.rescan && state.rescan[acc.id];
    // Relève complète : on reprend les N derniers, lus ou non. Sinon premier passage
    // = non-lus seulement, passages suivants = tout ce qui est arrivé depuis.
    const criteria = rescan ? 'ALL' : (seen.lastUid ? `UID ${seen.lastUid + 1}:*` : 'UNSEEN');
    let uids = await im.search(criteria);
    if (rescan) {
      uids = uids.sort((a, b) => a - b).slice(-rescan);
      delete state.rescan[acc.id];
    } else {
      uids = uids.filter(u => u > seen.lastUid).sort((a, b) => a - b).slice(-50);
    }

    if (uids.length) {
      const raws = await im.fetch(uids);
      for (const raw of raws) {
        const msg = toMessage(acc, raw, raw.uid);
        const alias = aliasForMessage(config, msg);

        // Filtre « alias seulement » : la boîte reçoit tout le domaine, on ne garde
        // que ce qui visait un alias déclaré.
        if (acc.aliasOnly && !alias) {
          logLine({ kind: 'ignore', from: msg.fromAddr, to: (msg.toList || [])[0] || acc.addr,
            what: 'ignoré · aucun alias déclaré' });
          if (acc.markSeen !== false) { try { await im.addFlag(raw.uid, '\\Seen'); } catch {} }
          continue;
        }

        const decision = regles.evalue(config, msg, alias ? alias.addr : null);
        if (decision.supprimer) {
          logLine({ kind: 'regle', from: msg.fromAddr, to: (msg.toList || [])[0] || acc.addr,
            what: `supprimé par « ${decision.reglesAppliquees.join(', ')} »` });
          if (acc.markSeen !== false) { try { await im.addFlag(raw.uid, '\\Seen'); } catch {} }
          continue;
        }
        if (decision.folder !== undefined) msg.folder = decision.folder;
        if (decision.unread !== undefined) msg.unread = decision.unread;

        const connu = state.messages.find(m => m.id === msg.id);
        if (connu) {
          // Déjà relevé : lors d'une relève complète il peut lui manquer un ticket,
          // par exemple s'il est arrivé avant que la boîte passe en boîte à tickets.
          if (rescan && (acc.kind || 'mail') === 'tickets' && !connu.ticketId) {
            const { ticket, created } = ingest({ config, state, msg: connu });
            connu.ticketId = ticket.id;
            fetched++;
            logLine({ kind: created ? 'ticket' : 'dedup', from: connu.fromAddr,
              to: ticket.via || acc.addr, what: `${ticket.id} rattaché · ${ticket.service}` });
            if (created) {
              notify(ticket).catch(() => {});
              webhook.envoyer('ticket.created', ticket).catch(() => {});
            }
          }
          continue;
        }

        state.messages.unshift(msg);
        fetched++;

        const veutTicket = decision.ticket === 'oui' ||
          (decision.ticket !== 'non' && (acc.kind || 'mail') === 'tickets');

        if (veutTicket) {
          const { ticket, created } = ingest({ config, state, msg });
          // Une règle peut forcer le service ou l'urgence, au-dessus de l'alias.
          if (decision.service) ticket.service = decision.service;
          if (decision.urgence && RANK[decision.urgence] !== undefined) ticket.urgency = decision.urgence;
          if (decision.reglesAppliquees.length) {
            ticket.history.push({ at: new Date().toISOString(),
              what: `règle appliquée : ${decision.reglesAppliquees.join(', ')}` });
          }
          msg.ticketId = ticket.id;
          logLine({
            kind: created ? 'ticket' : 'dedup',
            from: msg.fromAddr, to: ticket.via || acc.addr,
            what: created
              ? `${ticket.id} ouvert · ${ticket.service} · ${ticket.urgency}`
              : `${ticket.id} incrémenté (${ticket.occurrences})`
          });
          if (created) {
            notify(ticket).catch(() => {});
            webhook.envoyer('ticket.created', ticket).catch(() => {});
          } else {
            webhook.envoyer('ticket.repeated', ticket).catch(() => {});
          }
        } else {
          logLine({ kind: 'mail', from: msg.fromAddr, to: acc.addr, what: 'reçu' });
        }

        if (acc.markSeen !== false) { try { await im.addFlag(raw.uid, '\\Seen'); } catch {} }
      }
      seen.lastUid = Math.max(seen.lastUid, ...uids);
      state.uidState[acc.id] = seen;
    } else if (!seen.lastUid) {
      // Rien à relever : on mémorise le point de départ pour ne pas rejouer l'historique.
      const all = await im.search('ALL');
      state.uidState[acc.id] = { lastUid: all.length ? Math.max(...all) : 0 };
    }

    acc.lastError = null;
    acc.lastOk = new Date().toISOString();
    await im.logout();
  } catch (e) {
    im.close();
    acc.lastError = e.message;
    logLine({ kind: 'erreur', to: acc.addr, what: e.message });
    throw e;
  }
  return { fetched };
}

// Deux relèves ne se marchent pas dessus : la seconde attend le résultat de la
// première au lieu de renvoyer un état périmé.
function pollAll() {
  if (inFlight) return inFlight;
  inFlight = runPoll().finally(() => { inFlight = null; });
  return inFlight;
}

async function runPoll() {
  const started = Date.now();
  let fetched = 0;
  const errors = [];
  for (const acc of config.accounts) {
    try {
      const r = await pollAccount(acc);
      fetched += r.fetched;
    } catch (e) {
      errors.push(`${acc.addr} : ${e.message}`);
    }
  }
  prune();
  saveState();
  last = {
    at: new Date().toISOString(),
    ok: errors.length === 0,
    error: errors.length ? errors.join(' | ') : null,
    fetched,
    durationMs: Date.now() - started
  };
  return last;
}

function prune() {
  const days = config.settings.retentionDays ?? 30;
  const cutoff = Date.now() - days * 86400000;
  const keep = new Set();
  for (const t of state.tickets) {
    if (t.status !== 'traite' || new Date(t.updatedAt).getTime() >= cutoff) {
      keep.add(t.id);
      (t.messageIds || []).forEach(id => keep.add(id));
    }
  }
  state.tickets = state.tickets.filter(t => keep.has(t.id));
  // Un message envoyé n'a pas de raison de disparaître avec la rétention.
  state.messages = state.messages.filter(m =>
    m.sent || new Date(m.receivedAt).getTime() >= cutoff || keep.has(m.id));
  if (state.messages.length > 2000) state.messages.length = 2000;
}

let timer = null;
function start() {
  const every = Math.max(30, config.settings.pollSeconds || 120) * 1000;
  if (timer) clearInterval(timer);
  pollAll().catch(e => console.error('[poller]', e.message));
  timer = setInterval(() => pollAll().catch(e => console.error('[poller]', e.message)), every);
  return timer;
}

module.exports = { pollAll, pollAccount, start, status: () => last, toMessage, prune, logLine };
