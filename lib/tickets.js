// Moteur de tickets : l'alias visé décide du service ; les mots-clés peuvent
// seulement faire monter l'urgence, jamais la baisser.

const RANK = { basse: 0, normale: 1, haute: 2, crit: 3 };
const URG = { basse: 'Basse', normale: 'Normale', haute: 'Haute', crit: 'Critique' };
const STATUS = { nouveau: 'Nouveau', cours: 'En cours', traite: 'Traité' };

const ESCALATE = [
  { urg: 'crit', re: /\b(critique|critical|boucle|crashloop|redémarr\w*\s+\d|corrompu|disque plein|no space|out of memory|oom|panic|fatal)\b/i },
  { urg: 'haute', re: /\b(hors ligne|offline|unreachable|down|échec|echec|failed|failure|erreur|error|bloqu[ée]|expir[ée]|timeout|refus[ée])\b/i }
];

function normalise(s) {
  return String(s || '')
    .toLowerCase()
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .replace(/\b\d{1,4}([:h]\d{2})?\b/g, '#')
    .replace(/[^a-z0-9# ]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function findAlias(config, addr) {
  if (!addr) return null;
  const target = String(addr).toLowerCase();
  for (const acc of config.accounts) {
    for (const al of acc.aliases || []) {
      if (al.active !== false && String(al.addr).toLowerCase() === target) return { ...al, box: acc.addr };
    }
  }
  return null;
}

function aliasForMessage(config, msg) {
  const cands = [].concat(msg.toList || [], msg.ccList || [], msg.deliveredTo || []);
  for (const c of cands) {
    const hit = findAlias(config, c);
    if (hit) return hit;
  }
  return null;
}

function extractHost(text) {
  const m = String(text || '').match(/^\s*(?:machine|h[oô]te|host|cible|serveur|device|agent)\s*[:=]\s*(.+)$/im);
  if (m) return m[1].trim().slice(0, 60);
  const ip = String(text || '').match(/\b(?:\d{1,3}\.){3}\d{1,3}\b/);
  return ip ? ip[0] : '';
}

function classify(config, msg) {
  const alias = aliasForMessage(config, msg);
  const hay = `${msg.fromName} ${msg.fromAddr} ${msg.subject} ${msg.text}`;
  let urg = alias ? (alias.urg || 'normale') : 'normale';
  for (const rule of ESCALATE) {
    if (rule.re.test(hay) && RANK[rule.urg] > RANK[urg]) { urg = rule.urg; break; }
  }
  return {
    service: alias ? alias.svc : 'autre',
    urgency: urg,
    via: alias ? alias.addr : null,
    host: extractHost(msg.text)
  };
}

function findDuplicate(state, cand, windowMinutes) {
  const cutoff = Date.now() - windowMinutes * 60000;
  const sig = normalise(cand.subject);
  return state.tickets.find(t =>
    t.status !== 'traite' &&
    t.service === cand.service &&
    (t.host || '') === (cand.host || '') &&
    normalise(t.subject) === sig &&
    new Date(t.updatedAt).getTime() >= cutoff
  );
}

function nextId(state) {
  return 'TCK-' + String(state.seq++).padStart(4, '0');
}

// Retourne { ticket, created }
function ingest({ config, state, msg }) {
  const c = classify(config, msg);
  const cand = { service: c.service, host: c.host, subject: msg.subject || '(sans objet)' };
  const dup = findDuplicate(state, cand, config.settings.dedupMinutes ?? 30);
  const now = new Date().toISOString();

  if (dup) {
    dup.occurrences = (dup.occurrences || 1) + 1;
    dup.updatedAt = now;
    dup.messageIds = [...new Set([...(dup.messageIds || []), msg.id])];
    if (RANK[c.urgency] > RANK[dup.urgency]) {
      dup.urgency = c.urgency;
      dup.history.push({ at: now, what: `urgence montée à ${URG[c.urgency].toLowerCase()} (répétition)` });
    } else {
      dup.history.push({ at: now, what: `répétition n°${dup.occurrences}` });
    }
    return { ticket: dup, created: false };
  }

  const ticket = {
    id: nextId(state),
    service: c.service,
    subject: cand.subject,
    host: c.host,
    urgency: c.urgency,
    status: 'nouveau',
    auto: true,
    via: c.via,
    occurrences: 1,
    messageIds: [msg.id],
    notes: '',
    createdAt: now,
    updatedAt: now,
    history: [{ at: now, what: c.via ? `ouvert depuis ${c.via}` : 'ouvert depuis un message' }]
  };
  state.tickets.unshift(ticket);
  return { ticket, created: true };
}

export { ingest, classify, findDuplicate, normalise, findAlias, aliasForMessage, RANK, URG, STATUS };
