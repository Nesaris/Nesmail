// Moteur de règles. Évaluées dans l'ordre, à la relève, avant la création du ticket.

const CHAMPS = ['from', 'to', 'subject', 'body', 'account', 'alias', 'any'];
const OPERATEURS = ['contient', 'contientpas', 'egal', 'commence', 'termine', 'regex'];
// Une expression s'évalue à chaque message relevé, sans délai possible en JS :
// longueur bornée, texte examiné borné, et refus des quantificateurs imbriqués
// (« (a+)+ », « (x|y*)* »), source des retours arrière exponentiels.
const REGEX_MAX = 200;
const TEXTE_MAX = 20000;
const IMBRIQUE = /\((?:[^()\\]|\\.)*[+*}](?:[^()\\]|\\.)*\)\s*[+*{]/;
const compilees = new Map();

function expressionSure(source) {
  const v = String(source ?? '');
  if (!v || v.length > REGEX_MAX || IMBRIQUE.test(v) || /\\[1-9]/.test(v)) return null;
  try { return new RegExp(v, 'i'); } catch { return null; }
}

function expression(source) {
  if (!compilees.has(source)) {
    if (compilees.size > 500) compilees.clear();
    compilees.set(source, expressionSure(source));
  }
  return compilees.get(source);
}

function normalise(v) {
  return String(v ?? '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
}

function valeurDuChamp(msg, champ, alias) {
  switch (champ) {
    case 'from': return `${msg.fromName || ''} ${msg.fromAddr || ''}`;
    case 'to': return [].concat(msg.toList || [], msg.ccList || [], msg.deliveredTo || []).join(' ');
    case 'subject': return msg.subject || '';
    case 'body': return msg.text || '';
    case 'account': return msg.account || '';
    case 'alias': return alias || '';
    case 'any': return [msg.fromName, msg.fromAddr, (msg.toList || []).join(' '), msg.subject, msg.text].join(' ');
    default: return '';
  }
}

function teste(condition, msg, alias) {
  const brut = valeurDuChamp(msg, condition.champ, alias).slice(0, TEXTE_MAX);
  const cible = normalise(brut);
  const attendu = normalise(condition.valeur);
  if (!attendu && condition.op !== 'regex') return false;
  switch (condition.op) {
    case 'contient': return cible.includes(attendu);
    case 'contientpas': return !cible.includes(attendu);
    case 'egal': return cible.trim() === attendu.trim();
    case 'commence': return cible.trimStart().startsWith(attendu);
    case 'termine': return cible.trimEnd().endsWith(attendu);
    // Une expression invalide ne doit jamais faire tomber la relève.
    case 'regex': { const re = expression(condition.valeur); return re ? re.test(brut) : false; }
    default: return false;
  }
}

function evalue(config, msg, alias) {
  const resultat = {
    folder: undefined, unread: undefined, supprimer: false,
    ticket: undefined, urgence: undefined, service: undefined,
    reglesAppliquees: []
  };
  for (const r of (config.rules || []).filter(x => x.enabled !== false)) {
    const items = (r.conditions && r.conditions.items) || [];
    if (!items.length) continue;
    const mode = (r.conditions.mode === 'any') ? 'any' : 'all';
    const resultats = items.map(c => teste(c, msg, alias));
    const ok = mode === 'any' ? resultats.some(Boolean) : resultats.every(Boolean);
    if (!ok) continue;

    const a = r.actions || {};
    resultat.reglesAppliquees.push(r.name || r.id);
    if (a.folder !== undefined && a.folder !== null && a.folder !== '') resultat.folder = a.folder;
    if (a.folder === null) resultat.folder = null;
    if (a.read === true) resultat.unread = false;
    if (a.read === false) resultat.unread = true;
    if (a.delete) resultat.supprimer = true;
    if (a.ticket === 'oui' || a.ticket === 'non') resultat.ticket = a.ticket;
    if (a.urgency) resultat.urgence = a.urgency;
    if (a.service) resultat.service = a.service;
    if (a.stop) break;
  }
  return resultat;
}

function nettoie(brut) {
  const items = ((brut.conditions && brut.conditions.items) || [])
    .filter(c => c && CHAMPS.includes(c.champ) && OPERATEURS.includes(c.op))
    .map(c => ({ champ: c.champ, op: c.op, valeur: String(c.valeur ?? '').slice(0, REGEX_MAX) }))
    .slice(0, 10);
  const a = brut.actions || {};
  return {
    name: String(brut.name || 'Sans nom').slice(0, 80),
    enabled: brut.enabled !== false,
    conditions: { mode: brut.conditions && brut.conditions.mode === 'any' ? 'any' : 'all', items },
    actions: {
      folder: a.folder === null ? null : (a.folder ? String(a.folder) : undefined),
      read: typeof a.read === 'boolean' ? a.read : undefined,
      delete: Boolean(a.delete),
      ticket: (a.ticket === 'oui' || a.ticket === 'non') ? a.ticket : undefined,
      urgency: ['basse', 'normale', 'haute', 'crit'].includes(a.urgency) ? a.urgency : undefined,
      service: a.service ? String(a.service).slice(0, 60) : undefined,
      stop: Boolean(a.stop)
    }
  };
}

export { evalue, teste, nettoie, expressionSure, CHAMPS, OPERATEURS };
