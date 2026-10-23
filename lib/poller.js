// Relève des boîtes IMAP : chaque message neuf passe par les règles, puis
// devient un ticket (boîte à tickets) ou reste du courrier.
import crypto from 'node:crypto';
import { Imap } from './imap.js';
import * as mime from './mime.js';
import * as assainit from './html.js';
import * as regles from './rules.js';
import { ingest, RANK, aliasForMessage } from './tickets.js';

function toMessage(acc, raw, uid) {
  const { headers, text, html } = mime.extractText(raw.body);
  const propre = html ? assainit.nettoie(html) : { html: '', imagesMasquees: 0 };
  const from = mime.addressOf(headers.from);
  return {
    id: 'm-' + crypto.randomBytes(12).toString('base64url'),
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

// Connexion IMAP d'une boîte : TLS implicite ou STARTTLS, certificat vérifié
// ou épinglé. Une première empreinte retenue (reprise d'une 1.0) est écrite.
export function imapDe(depot, acc, { journal = null } = {}) {
  return new Imap({
    host: acc.imapHost, port: acc.imapPort || 993,
    user: acc.imapUser || acc.addr, pass: depot.motDePasse(acc),
    tls: acc.imapTls !== false, epingle: acc.imapPin || '',
    surEpingle: vue => {
      acc.imapPin = vue; depot.saveConfig();
      journal?.ecrire({ acteur: 'système', action: 'boite.certificat_epingle', objet: acc.id, details: { serveur: 'imap', empreinte: vue } });
    },
  });
}

export function creerReleve({ depot, notify = async () => false, webhook = { envoyer: async () => false }, journal = null }) {
  const { config, state } = depot;
  const saveState = () => depot.saveState();
  let inFlight = null;
  let last = { at: null, ok: null, error: null, fetched: 0, durationMs: 0 };

  function logLine(entry) {
    state.log.unshift({ at: new Date().toISOString(), ...entry });
    if (state.log.length > 500) state.log.length = 500;
  }

  // Un ticket ouvert prévient Telegram et le webhook ; une répétition, le
  // webhook seul. Le webhook garde son dernier échec pour Réglages ; un échec
  // de Telegram va au journal du conteneur.
  function prevenir(ticket, created) {
    if (created) notify(ticket).catch(e => console.warn('[telegram]', e.message));
    webhook.envoyer(created ? 'ticket.created' : 'ticket.repeated', ticket);
  }

  // Le marquage « lu » chez le fournisseur n'est qu'un confort : la relève
  // avance par UID, un marquage refusé ne fait rien relire.
  async function marquerLu(acc, im, uid) {
    if (acc.markSeen === false) return;
    try { await im.addFlag(uid, '\\Seen'); } catch (e) { logLine({ kind: 'erreur', to: acc.addr, what: `marquage lu refusé : ${e.message}` }); }
  }

  async function pollAccount(acc) {
    if (acc.disabled) return { fetched: 0 };
    const im = imapDe(depot, acc, { journal });
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
            await marquerLu(acc, im, raw.uid);
            continue;
          }

          const decision = regles.evalue(config, msg, alias ? alias.addr : null);
          if (decision.supprimer) {
            logLine({ kind: 'regle', from: msg.fromAddr, to: (msg.toList || [])[0] || acc.addr,
              what: `supprimé par « ${decision.reglesAppliquees.join(', ')} »` });
            await marquerLu(acc, im, raw.uid);
            continue;
          }
          if (decision.folder !== undefined) msg.folder = decision.folder;
          if (decision.unread !== undefined) msg.unread = decision.unread;

          const connu = state.messages.find(m => m.accountId === acc.id && m.uid === msg.uid);
          if (connu) {
            // Déjà relevé : lors d'une relève complète il peut lui manquer un ticket,
            // par exemple s'il est arrivé avant que la boîte passe en boîte à tickets.
            if (rescan && (acc.kind || 'mail') === 'tickets' && !connu.ticketId) {
              const { ticket, created } = ingest({ config, state, msg: connu });
              connu.ticketId = ticket.id;
              fetched++;
              logLine({ kind: created ? 'ticket' : 'dedup', from: connu.fromAddr,
                to: ticket.via || acc.addr, what: `${ticket.id} rattaché · ${ticket.service}` });
              if (created) prevenir(ticket, true);
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
            prevenir(ticket, created);
          } else {
            logLine({ kind: 'mail', from: msg.fromAddr, to: acc.addr, what: 'reçu' });
          }

          await marquerLu(acc, im, raw.uid);
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
    // Envoyés compris : la même durée de garde pour tout le courrier.
    state.messages = state.messages.filter(m =>
      new Date(m.receivedAt).getTime() >= cutoff || keep.has(m.id));
    if (state.messages.length > 2000) state.messages.length = 2000;
  }

  let timer = null;
  function stop() { if (timer) clearInterval(timer); timer = null; }
  function start() {
    const every = Math.max(30, config.settings.pollSeconds || 120) * 1000;
    if (timer) clearInterval(timer);
    pollAll().catch(e => console.error('[poller]', e.message));
    timer = setInterval(() => pollAll().catch(e => console.error('[poller]', e.message)), every);
    return timer;
  }

  return { pollAll, pollAccount, start, stop, status: () => last, prune, logLine };
}
