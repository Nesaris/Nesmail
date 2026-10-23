// Interface de CACHET. La porte du socle gère la connexion (mot de passe,
// clés d'accès, second facteur) ; tout ce qui suit suppose une session
// complète, et le serveur revérifie chaque droit. Le corps HTML d'un message
// n'est jamais injecté comme balisage : il est relu par le navigateur dans un
// document inerte, puis reconstruit élément par élément sur une liste blanche.
import { Api, porte, pageSecurite, pageComptes, appliquerTheme, estSombre, confirmer, dialogue, h } from '/socle/compte.js';
// Tout balisage de l'interface passe par html`…` du socle : les chaînes
// littérales du code seules sont lues comme du HTML, chaque valeur devient un
// nœud texte ou un attribut. Aucune affectation d'innerHTML.
import { html, poser } from '/socle/gabarit.js';

const URG = { basse: 'Basse', normale: 'Normale', haute: 'Haute', crit: 'Critique' };
const STATUS = { nouveau: 'Nouveau', cours: 'En cours', traite: 'Traité' };
const CHAMPS = { from: 'Expéditeur', to: 'Destinataire', subject: 'Objet', body: 'Corps',
  account: 'Boîte', alias: 'Alias visé', any: "N'importe où" };
const OPS = { contient: 'contient', contientpas: 'ne contient pas', egal: 'est exactement',
  commence: 'commence par', termine: 'finit par', regex: 'correspond à (regex)' };

const PROVIDERS = {
  manual:  { label: 'IMAP / SMTP', mono: '@', imap: '', imapPort: '993', smtp: '', smtpPort: '465', hint: 'réglage manuel' },
  gmail:   { label: 'Gmail',   mono: 'G', imap: 'imap.gmail.com',        imapPort: '993', smtp: 'smtp.gmail.com',     smtpPort: '587', hint: 'mot de passe d’app' },
  outlook: { label: 'Outlook', mono: 'M', imap: 'outlook.office365.com', imapPort: '993', smtp: 'smtp.office365.com', smtpPort: '587', hint: 'Microsoft 365' },
  icloud:  { label: 'iCloud',  mono: 'i', imap: 'imap.mail.me.com',      imapPort: '993', smtp: 'smtp.mail.me.com',   smtpPort: '587', hint: 'mot de passe d’app' },
  proton:  { label: 'Proton',  mono: 'P', imap: '127.0.0.1',             imapPort: '1143', smtp: '127.0.0.1',         smtpPort: '1025', hint: 'via Bridge' },
  zimbra:  { label: 'Zimbra',  mono: 'Z', imap: '',                      imapPort: '993', smtp: '',                   smtpPort: '587', hint: 'serveur au choix' }
};

const ICON = {
  ticket: html`<svg class="i" viewBox="0 0 24 24"><rect x="3.5" y="5.5" width="17" height="13" rx="2.4"/><path d="M8 5.5v13M11.5 9.5h6M11.5 13h4"/></svg>`,
  mail: html`<svg class="i" viewBox="0 0 24 24"><rect x="3" y="5.5" width="18" height="13" rx="2.4"/><path d="M3.8 7.2 12 13l8.2-5.8"/></svg>`,
  warn: html`<svg class="i" viewBox="0 0 24 24"><path d="M12 4.6 20.5 19.4h-17z"/><path d="M12 10v4M12 16.8h.01"/></svg>`,
  clock: html`<svg class="i" viewBox="0 0 24 24"><circle cx="12" cy="12" r="8.4"/><path d="M12 7.4V12l3 1.8"/></svg>`,
  check: html`<svg class="i" viewBox="0 0 24 24"><path d="M5.5 12.5 10 17l8.5-9.5"/></svg>`,
  route: html`<svg class="i" viewBox="0 0 24 24"><path d="M4 7h9M17 7h3M4 17h3M11 17h9"/><circle cx="15" cy="7" r="2.2"/><circle cx="7.5" cy="17" r="2.2"/></svg>`,
  folder: html`<svg class="i" viewBox="0 0 24 24"><path d="M4 7.5h4.6l1.6-2h9.8v11.6a1.4 1.4 0 0 1-1.4 1.4H5.4A1.4 1.4 0 0 1 4 17.1z"/></svg>`
};
const ENVOI_OK = html`<span class="arrow">·</span>envoi ok`;

let S = { accounts: [], tickets: [], messages: [], folders: [], rules: [], log: [], settings: {}, poll: {} };
let view = { page: 'intake', intakeAlias: 'all', mailAcct: 'all', folder: 'all', sel: 0, sel2: 0, q: '', html: {} };

const $ = id => document.getElementById(id);

// Le client du socle : jeton anti-CSRF, confirmation d'identité demandée par
// le serveur (renfort, dévoilement), retour à la porte si la session tombe.
const socle = new Api({ surDeconnexion: () => location.reload() });
const api = (method, path, body) => socle.req(method, path, body);

// Une question à une ligne : le nom d'un dossier.
async function demander(titre, libelle) {
  const champ = h('input', { class: 'field', type: 'text', 'aria-label': libelle, placeholder: libelle, maxlength: '60' });
  const ok = await dialogue({ titre, contenu: [champ], boutons: [{ texte: 'Annuler', classe: 'flat', valeur: false }, { texte: 'Créer', classe: 'solid', valeur: true }] });
  return ok ? champ.value.trim() : '';
}

let toastTimer;
function toast(msg) {
  const t = $('toast');
  t.textContent = msg; t.classList.add('on');
  clearTimeout(toastTimer); toastTimer = setTimeout(() => t.classList.remove('on'), 3000);
}

function ago(iso) {
  if (!iso) return '—';
  const s = Math.floor((Date.now() - new Date(iso)) / 1000);
  if (s < 60) return 'à l’instant';
  if (s < 3600) return `il y a ${Math.floor(s / 60)} min`;
  if (s < 86400) return `il y a ${Math.floor(s / 3600)} h`;
  return `il y a ${Math.floor(s / 86400)} j`;
}
function clock(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  return new Date().toDateString() === d.toDateString()
    ? d.toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' })
    : d.toLocaleDateString('fr-FR', { day: '2-digit', month: '2-digit' });
}

const aliasesOf = a => (a.aliases || []);
const allAliases = () => S.accounts.flatMap(a => aliasesOf(a).map(al => ({ ...al, box: a.addr, accountId: a.id })));
const ticketOf = id => S.tickets.find(t => t.id === id);
const isIntake = a => (a.kind || 'mail') === 'tickets';
const folderName = id => ((S.folders || []).find(f => f.id === id) || {}).name;

function initials(name, addr) {
  const src = String(name || '').trim();
  if (src && !src.includes('@')) {
    const mots = src.split(/[\s._-]+/).filter(Boolean);
    if (mots.length >= 2) return (mots[0][0] + mots[1][0]).toUpperCase();
    return src.slice(0, 2).toUpperCase();
  }
  return String(addr || '?').replace(/^[^a-z0-9]*/i, '').slice(0, 2).toUpperCase();
}
// Teinte stable : la même adresse garde toujours la même couleur.
function tone(addr) {
  let h = 0;
  for (const c of String(addr || '')) h = (h * 31 + c.charCodeAt(0)) >>> 0;
  return ['', 'a2', 'a3', 'a4'][h % 4];
}

let menuOuvert = null;
function fermeMenu() {
  if (menuOuvert) { menuOuvert.remove(); menuOuvert = null; }
  document.querySelectorAll('.mailrow.cible').forEach(x => x.classList.remove('cible'));
}
document.addEventListener('click', fermeMenu);
document.addEventListener('scroll', fermeMenu, true);
window.addEventListener('resize', fermeMenu);

function menu(x, y, items) {
  fermeMenu();
  const el = document.createElement('div');
  el.className = 'menu';
  poser(el, items.map((it, i) => {
    if (it.sep) return html`<div class="sep"></div>`;
    if (it.titre) return html`<div class="titre">${it.titre}</div>`;
    return html`<button type="button" data-i=${i} class=${it.danger ? 'danger' : ''} disabled=${Boolean(it.disabled)}>${it.icon || ''}<span>${it.label}</span></button>`;
  }));
  document.body.appendChild(el);
  const r = el.getBoundingClientRect();
  el.style.left = Math.max(8, Math.min(x, window.innerWidth - r.width - 8)) + 'px';
  el.style.top = Math.max(8, Math.min(y, window.innerHeight - r.height - 8)) + 'px';
  el.querySelectorAll('[data-i]').forEach(b => {
    b.onclick = ev => { ev.stopPropagation(); const it = items[+b.dataset.i]; fermeMenu(); if (it && it.action) it.action(); };
  });
  el.onclick = ev => ev.stopPropagation();
  menuOuvert = el;
}

$('logout').addEventListener('click', async () => { try { await api('POST', '/api/compte/deconnexion'); } finally { location.reload(); } });

function aller(page, bouton) {
  view.page = page;
  document.querySelectorAll('.nav-item').forEach(x => x.classList.remove('on'));
  if (bouton) bouton.classList.add('on');
  document.querySelectorAll('.page').forEach(p => p.classList.toggle('on', p.id === 'p-' + page));
  // Les pages des comptes viennent du socle : construites à l'ouverture, à jour.
  if (page === 'comptes') $('p-comptes').replaceChildren(pageComptes(socle, { service: 'CACHET' }));
  if (page === 'securite') $('p-securite').replaceChildren(pageSecurite(socle, { service: 'CACHET', confidentialite: '/confidentialite.txt' }));
  window.scrollTo(0, 0);
}
document.querySelectorAll('[data-go]').forEach(b => b.addEventListener('click', () => aller(b.dataset.go, b)));
$('navSent').onclick = () => {
  view.folder = '__sent'; view.mailAcct = 'all'; view.sel2 = 0;
  aller('mail', $('navSent'));
  renderMailPage();
};
// Clair ou sombre : le même choix que la porte et les autres services du socle.
$('mode').addEventListener('click', () => {
  document.documentElement.dataset.theme = estSombre() ? 'light' : 'dark';
  try { localStorage.setItem('theme', document.documentElement.dataset.theme); } catch { /* stockage indisponible */ }
  appliquerTheme();
});
$('q').addEventListener('input', e => { view.q = e.target.value.toLowerCase(); renderTickets(); renderIntake(); });
document.addEventListener('keydown', e => {
  if (e.key === 'Escape') ['acctScrim', 'tkScrim', 'ruleScrim', 'replyScrim'].forEach(s => $(s).classList.remove('on'));
});

function render() {
  // Chaque bloc est isolé : une erreur dans les tickets ne doit pas laisser
  // les réglages vides sans que personne ne soit prévenu.
  const blocs = [
    ['compteurs', renderCounters], ['dossiers', renderFolders], ['arrivée', renderIntake],
    ['courrier', renderMailPage], ['tickets', renderTickets], ['comptes', renderAccounts],
    ['journal', renderLog], ['règles', renderRules], ['réglages', renderPrefs], ['alertes', renderAlerts]
  ];
  const rates = [];
  for (const [nom, fn] of blocs) {
    try { fn(); } catch (e) { rates.push(nom); console.error(`[render:${nom}]`, e); }
  }
  if (rates.length) toast(`Affichage incomplet : ${rates.join(', ')} — voir la console`);
}

function renderCounters() {
  const intake = S.messages.filter(m => !m.sent && isIntakeMsg(m));
  $('cIntake').textContent = intake.length;
  $('cTick').textContent = S.tickets.filter(t => t.status !== 'traite').length;
  $('cMail').textContent = S.messages.filter(m => !m.sent && !isIntakeMsg(m)).length;
  $('cSent').textContent = S.messages.filter(m => m.sent).length;
  $('cAcct').textContent = S.accounts.length;
  $('lastPoll').textContent = ago(S.poll?.at);
}
function isIntakeMsg(m) {
  const a = S.accounts.find(x => x.id === m.accountId);
  return Boolean(a && isIntake(a));
}

function renderAlerts() {
  const bad = S.accounts.filter(a => a.lastError);
  poser($('alerts'),
    S.accounts.length ? '' : html`<div class="banner warn">${ICON.warn}<span>Aucune boîte configurée. Ajoutez-en une dans Comptes pour démarrer.</span></div>`,
    bad.map(a => html`<div class="banner">${ICON.warn}<span><b>${a.addr}</b> — ${a.lastError}</span></div>`));
}

function renderFolders() {
  const nav = $('folderNav');
  const dossiers = S.folders || [];
  if (!dossiers.length) {
    poser(nav, html`<p class="vide-nav">Aucun dossier</p>`);
    return;
  }
  poser(nav, dossiers.map(f => {
    const n = S.messages.filter(m => m.folder === f.id).length;
    return html`<button class="nav-item ${view.page === 'mail' && view.folder === f.id ? 'on' : ''}" data-donnee data-folder=${f.id}>${ICON.folder}<span class="nom" title=${f.name}>${f.name}</span>${n ? html`<span class="count">${n}</span>` : ''}</button>`;
  }));
  nav.querySelectorAll('[data-folder]').forEach(b => {
    b.onclick = () => {
      view.folder = b.dataset.folder; view.mailAcct = 'all'; view.sel2 = 0;
      aller('mail', b);
      renderMailPage();
    };
    b.oncontextmenu = e => {
      e.preventDefault();
      const f = (S.folders || []).find(x => x.id === b.dataset.folder);
      menu(e.clientX, e.clientY, [{
        label: `Supprimer « ${f.name} »`, danger: true, action: async () => {
          if (!await confirmer(`Supprimer le dossier « ${f.name} » ?`, 'Les messages qu’il contient ne sont pas supprimés.', { danger: true, oui: 'Supprimer' })) return;
          await api('DELETE', '/api/folders/' + f.id);
          if (view.folder === f.id) view.folder = 'all';
          toast('Dossier supprimé'); await refresh();
        }
      }]);
    };
  });
}
$('addFolder').onclick = async () => {
  const nom = await demander('Nouveau dossier', 'Nom du dossier');
  if (!nom) return;
  try { await api('POST', '/api/folders', { name: nom }); toast('Dossier créé'); await refresh(); }
  catch (e) { toast(e.message); }
};

function renderIntake() {
  const aliases = allAliases().filter(al => {
    const a = S.accounts.find(x => x.id === al.accountId);
    return a && isIntake(a);
  });
  const boxes = S.accounts.filter(isIntake);
  $('intakeLede').textContent = boxes.length
    ? `${boxes.map(b => b.addr).join(', ')} — ${aliases.length} alias, chaque message ouvre son ticket.`
    : 'Aucune boîte réglée en « boîte à tickets » pour l’instant.';

  const tous = S.messages.filter(m => !m.sent && isIntakeMsg(m));
  poser($('intakeChips'),
    html`<button class="chip ${view.intakeAlias === 'all' ? 'on' : ''}" data-alias="all">Tous les services<span class="n">${tous.length}</span></button>`,
    aliases.map(al => {
      const n = tous.filter(m => (m.toList || []).concat(m.deliveredTo || []).includes(al.addr)).length;
      return html`<button class="chip ${view.intakeAlias === al.addr ? 'on' : ''}" data-alias=${al.addr}>${al.addr.split('@')[0]}@<span class="n">${n}</span></button>`;
    }));
  $('intakeChips').querySelectorAll('[data-alias]').forEach(b => b.onclick = () => {
    view.intakeAlias = b.dataset.alias; view.sel = 0; renderIntake();
  });

  const items = tous.filter(m => {
    if (view.intakeAlias !== 'all' && !(m.toList || []).concat(m.deliveredTo || []).includes(view.intakeAlias)) return false;
    if (view.q && !`${m.subject} ${m.fromAddr} ${m.text}`.toLowerCase().includes(view.q)) return false;
    return true;
  });
  $('intakeTitle').textContent = view.intakeAlias === 'all' ? 'Tous les services' : view.intakeAlias;
  $('intakeNote').textContent = `${items.length} alerte${items.length > 1 ? 's' : ''} · ${items.filter(m => m.ticketId).length} en ticket`;
  renderMessageList($('intakeList'), items, 'sel', $('reader'), $('readerNote'), true);
}

function renderMailPage() {
  const envoyes = view.folder === '__sent';
  const boxes = S.accounts.filter(a => !isIntake(a));
  poser($('mailChips'), envoyes ? '' : [
    html`<button class="chip ${view.mailAcct === 'all' ? 'on' : ''}" data-macct="all">Toutes les boîtes</button>`,
    ...boxes.map(a => html`<button class="chip ${view.mailAcct === a.id ? 'on' : ''}" data-macct=${a.id}>${a.addr}</button>`)
  ]);
  $('mailChips').querySelectorAll('[data-macct]').forEach(b => b.onclick = () => {
    view.mailAcct = b.dataset.macct; view.folder = 'all'; view.sel2 = 0; renderFolders(); renderMailPage();
  });

  const items = S.messages.filter(m => {
    if (envoyes) return Boolean(m.sent);
    if (m.sent) return false;
    const a = S.accounts.find(x => x.id === m.accountId);
    if (!a || isIntake(a)) return false;
    if (view.folder !== 'all' && m.folder !== view.folder) return false;
    return view.mailAcct === 'all' || a.id === view.mailAcct;
  });

  const nom = envoyes ? 'Envoyés' : (view.folder === 'all' ? null : folderName(view.folder));
  $('mailTitle').textContent = nom || 'Courrier';
  $('mailListTitle').textContent = nom || (view.mailAcct === 'all' ? 'Toutes les boîtes'
    : (S.accounts.find(a => a.id === view.mailAcct) || {}).addr || '');
  $('mailNote').textContent = `${items.length} message${items.length > 1 ? 's' : ''}`;
  renderMessageList($('mailList'), items, 'sel2', $('reader2'), $('readerNote2'), false);
}

function renderMessageList(list, items, selKey, readerEl, noteEl, intake) {
  if (!items.length) {
    poser(list, html`<div class="empty"><strong>Rien ici</strong><p>${intake ? 'Aucune alerte relevée pour ce filtre.' : 'Aucun message.'}</p></div>`);
    poser(readerEl, html`<div class="empty"><p>${intake ? 'Le calme plat, c’est plutôt bon signe.' : 'Sélectionnez un message.'}</p></div>`);
    noteEl.textContent = '—';
    return;
  }
  if (view[selKey] >= items.length) view[selKey] = 0;
  poser(list, items.map((m, i) => {
    const t = m.ticketId ? ticketOf(m.ticketId) : null;
    const urgTone = t ? (t.urgency === 'crit' ? 'hot' : t.urgency === 'haute' ? 'amber' : 'key') : '';
    const qui = m.sent ? 'À ' + ((m.toList || [])[0] || '') : (m.fromName || m.fromAddr);
    return html`<button class="mailrow ${i === view[selKey] ? 'on' : ''}" type="button" data-donnee data-i=${i}>
      <span class="itile ${t ? urgTone : 'ini ' + tone(m.fromAddr)}">${t ? ICON.ticket : initials(m.fromName, m.fromAddr)}</span>
      <span>
        <span class="head"><span class="dot ${m.unread ? '' : 'off'}"></span><b>${qui}</b>
          ${!intake && m.folder ? html`<span class="mini">${folderName(m.folder) || ''}</span>` : ''}
          ${t ? html`<span class="mini tk">${t.id}</span><span class="urg ${t.urgency}"><i></i>${URG[t.urgency]}</span>` : ''}
          ${t && t.occurrences > 1 ? html`<span class="occ">×${t.occurrences}</span>` : ''}</span>
        <span class="subj">${m.subject}</span>
        <span class="prev">${String(m.text || '').replace(/\s+/g, ' ').slice(0, 120)}</span>
      </span>
      <span class="side-note">${clock(m.receivedAt)}<br>${((m.toList || [])[0] || m.account || '').split('@')[0]}</span>
    </button>`;
  }));
  list.querySelectorAll('[data-i]').forEach(b => {
    b.onclick = () => { view[selKey] = +b.dataset.i; renderMessageList(list, items, selKey, readerEl, noteEl, intake); };
    b.oncontextmenu = e => menuMessage(e, items[+b.dataset.i]);
  });
  renderReader(readerEl, noteEl, items[view[selKey]]);
}

function renderReader(el, noteEl, m) {
  if (!m) return;
  const acc = S.accounts.find(a => a.id === m.accountId) || {};
  const hitAlias = allAliases().find(al => (m.toList || []).concat(m.deliveredTo || []).includes(al.addr));
  const from = hitAlias && hitAlias.send !== false ? hitAlias.addr : acc.addr;
  const t = m.ticketId ? ticketOf(m.ticketId) : null;
  noteEl.textContent = m.sent ? 'envoyé' : (hitAlias ? `reçu sur ${hitAlias.addr}` : (acc.addr || ''));

  const aHtml = Boolean(m.html);
  const brut = view.html[m.id] === 'texte';
  const corps = (aHtml && !brut)
    ? html`<div class="bodyhtml" data-corps></div>`
    : html`<p class="bodytext">${m.text || '(corps vide)'}</p>`;
  const bascule = aHtml
    ? html`<button class="bascule" type="button" data-bascule>${brut ? 'Afficher la mise en forme' : 'Afficher en texte brut'}${m.imagesMasquees ? ` · ${m.imagesMasquees} image(s) bloquée(s)` : ''}</button>`
    : '';

  const dests = [...new Set([].concat(m.toList || [], m.ccList || [], m.deliveredTo || []))];
  const connus = allAliases().map(a => a.addr);

  poser(el, html`
    ${t ? html`<button class="linkbar" type="button" data-tk=${t.id}>${ICON.ticket}
      <span><b>${t.id} · ${STATUS[t.status]}</b><span>${`${t.service} · urgence ${URG[t.urgency].toLowerCase()}${t.occurrences > 1 ? ` · ${t.occurrences} occurrences` : ''}`}</span></span>
      <svg class="i sm pousse" viewBox="0 0 24 24"><path d="M9 5.5 15.5 12 9 18.5"/></svg></button>` : ''}
    <h3>${m.subject}</h3>
    <div class="meta">
      <span class="itile ini ${tone(m.fromAddr)}">${initials(m.fromName, m.fromAddr)}</span>
      <span><b>${m.fromName || ''}</b><span>${m.fromAddr}</span></span>
      <span class="pousse cell-mono">${clock(m.receivedAt)}</span>
    </div>
    ${bascule}
    ${corps}
    <div class="dests">
      ${dests.length ? dests.map((d, i) => html`${i ? ' ' : ''}<span class="mini ${connus.includes(d) ? 'tk' : ''}">${d}</span>`) : 'aucun destinataire lisible'}
    </div>
    <div class="toolbar">
      <button class="btn sm" type="button" data-reply><svg class="i sm" viewBox="0 0 24 24"><path d="M9 7 4.5 11.5 9 16"/><path d="M4.5 11.5H14a5.5 5.5 0 0 1 5.5 5.5v1.5"/></svg>Répondre<span class="depuis"> depuis ${from ? from.split('@')[0] + '@' : '—'}</span></button>
      ${t ? html`<button class="btn sm" type="button" data-tk=${t.id}>${ICON.ticket}Voir ${t.id}</button>` : ''}
    </div>`);

  el.querySelector('[data-corps]')?.append(htmlSur(m.html));
  el.querySelectorAll('[data-tk]').forEach(b => b.onclick = () => openTicket(b.dataset.tk));
  const rep = el.querySelector('[data-reply]');
  if (rep) rep.onclick = () => openReply(m, from);
  const bas = el.querySelector('[data-bascule]');
  if (bas) bas.onclick = () => {
    view.html[m.id] = brut ? 'html' : 'texte';
    renderReader(el, noteEl, m);
  };
}

// Le HTML d'un message, déjà nettoyé par le serveur, est relu ici dans un
// document inerte (rien ne s'y charge ni ne s'y exécute) et reconstruit : les
// balises de mise en forme seules, aucun attribut sinon la cible d'un lien
// http(s), mailto ou tel. Une seconde barrière, indépendante de la première.
const BALISES_SURES = new Set(['p', 'br', 'hr', 'div', 'span', 'section', 'article', 'b', 'strong', 'i', 'em', 'u', 's', 'strike', 'del', 'ins', 'mark', 'small', 'sub', 'sup',
  'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'ul', 'ol', 'li', 'dl', 'dt', 'dd', 'blockquote', 'q', 'cite', 'pre', 'code', 'kbd', 'samp', 'a', 'table', 'thead', 'tbody', 'tfoot', 'tr', 'td', 'th', 'caption']);
function htmlSur(source) {
  const doc = new DOMParser().parseFromString(String(source || ''), 'text/html');
  const copier = (noeud, profondeur) => {
    if (noeud.nodeType === Node.TEXT_NODE) return document.createTextNode(noeud.nodeValue);
    if (noeud.nodeType !== Node.ELEMENT_NODE || profondeur > 40) return null;
    const nom = noeud.localName;
    const enfants = [...noeud.childNodes].map(n => copier(n, profondeur + 1)).filter(Boolean);
    if (!BALISES_SURES.has(nom)) { const f = document.createDocumentFragment(); f.append(...enfants); return f; }
    const el = document.createElement(nom);
    if (nom === 'a') {
      const href = noeud.getAttribute('href') || '';
      if (/^(https?:|mailto:|tel:)/i.test(href.trim())) { el.href = href.trim(); el.target = '_blank'; el.rel = 'noopener noreferrer nofollow'; }
    }
    el.append(...enfants);
    return el;
  };
  const f = document.createDocumentFragment();
  f.append(...[...doc.body.childNodes].map(n => copier(n, 0)).filter(Boolean));
  return f;
}

function menuMessage(e, m) {
  e.preventDefault();
  e.currentTarget.classList.add('cible');
  const t = m.ticketId ? ticketOf(m.ticketId) : null;
  const dossiers = S.folders || [];
  const items = [];
  if (t) items.push({ label: `Voir ${t.id}`, icon: ICON.ticket, action: () => openTicket(t.id) });
  items.push({
    label: m.unread ? 'Marquer comme lu' : 'Marquer comme non lu', icon: ICON.mail,
    action: async () => { await api('PATCH', '/api/messages/' + encodeURIComponent(m.id), { unread: !m.unread }); await refresh(); }
  });
  items.push({ sep: true }, { titre: 'Déplacer vers' });
  if (!dossiers.length) items.push({ label: 'Aucun dossier — créez-en un à gauche', disabled: true });
  for (const f of dossiers) {
    items.push({
      label: (m.folder === f.id ? '● ' : '') + f.name, icon: ICON.folder,
      action: async () => {
        await api('PATCH', '/api/messages/' + encodeURIComponent(m.id), { folder: f.id });
        toast('Déplacé dans ' + f.name); await refresh();
      }
    });
  }
  if (m.folder) items.push({
    label: 'Retirer du dossier',
    action: async () => { await api('PATCH', '/api/messages/' + encodeURIComponent(m.id), { folder: null }); await refresh(); }
  });
  items.push({ sep: true });
  items.push({ label: "Copier l'adresse", action: () => copier(m.fromAddr, 'Adresse copiée') });
  items.push({ label: 'Copier le texte', action: () => copier(m.text || '', 'Texte copié') });
  items.push({ sep: true });
  items.push({
    label: 'Supprimer le message', danger: true,
    action: async () => {
      if (!await confirmer('Supprimer ce message ?', t ? `Le ticket ${t.id} est conservé.` : '', { danger: true, oui: 'Supprimer' })) return;
      await api('DELETE', '/api/messages/' + encodeURIComponent(m.id));
      toast('Message supprimé'); await refresh();
    }
  });
  menu(e.clientX, e.clientY, items);
}

function copier(texte, ok) {
  if (!navigator.clipboard) { toast('Copie impossible dans ce contexte'); return; }
  navigator.clipboard.writeText(texte).then(() => toast(ok), () => toast('Copie impossible'));
}

function renderTickets() {
  const q = view.q;
  const match = t => !q || `${t.id} ${t.service} ${t.subject} ${t.host}`.toLowerCase().includes(q);
  const cols = { nouveau: 'col-nouveau', cours: 'col-cours', traite: 'col-traite' };
  const notes = { nouveau: 'nNouveau', cours: 'nCours', traite: 'nTraite' };

  for (const st of Object.keys(cols)) {
    const items = S.tickets.filter(t => t.status === st && match(t));
    $(notes[st]).textContent = items.length;
    const box = $(cols[st]);
    if (!items.length) { poser(box, html`<div class="empty serre"><p>Aucun ticket ici.</p></div>`); continue; }
    poser(box, items.map(t => html`
      <button class="tk ${t.urgency}" type="button" data-tk=${t.id}>
        <span class="top"><span class="id">${t.id}</span><span class="svc">${t.service}</span>
          ${t.host ? html`<span class="mini">${t.host}</span>` : ''}
          ${t.occurrences > 1 ? html`<span class="occ">×${t.occurrences}</span>` : ''}</span>
        <strong>${t.subject}</strong>
        <span class="foot">
          <span class="urg ${t.urgency}"><i></i>${URG[t.urgency]}</span>
          <span class="auto">${t.auto ? 'auto' : 'manuel'} · ${ago(t.createdAt)}</span>
          ${st !== 'traite' ? html`<span class="adv" data-adv=${t.id} title="Étape suivante"><svg class="i sm" viewBox="0 0 24 24"><path d="M5 12h13M13 7l5 5-5 5"/></svg></span>` : ''}
        </span>
      </button>`));
    box.querySelectorAll('[data-tk]').forEach(b => b.onclick = e => {
      if (e.target.closest('[data-adv]')) return;
      openTicket(b.dataset.tk);
    });
    box.querySelectorAll('[data-adv]').forEach(b => b.onclick = async e => {
      e.stopPropagation();
      const t = ticketOf(b.dataset.adv);
      const next = t.status === 'nouveau' ? 'cours' : 'traite';
      await api('PATCH', `/api/tickets/${t.id}`, { status: next });
      toast(`${t.id} · ${STATUS[next].toLowerCase()}`);
      await refresh();
    });
  }

  const open = S.tickets.filter(t => t.status !== 'traite');
  const als = allAliases();
  poser($('tickFigs'), [
    { t: 'warn', l: 'Critiques ouverts', v: open.filter(t => t.urgency === 'crit').length, s: 'à regarder en premier', i: ICON.warn },
    { t: 'amber', l: 'En cours', v: S.tickets.filter(t => t.status === 'cours').length, s: 'pris en charge', i: ICON.clock },
    { t: '', l: 'Traités', v: S.tickets.filter(t => t.status === 'traite').length, s: 'sur la période gardée', i: ICON.check },
    { t: 'plain', l: 'Alias surveillés', v: als.length, s: `${S.accounts.filter(isIntake).length} boîte(s) à tickets`, i: ICON.route }
  ].map(f => html`<div class="fig"><div class="tile ${f.t}">${f.i}</div><span>${f.l}</span><strong>${f.v}</strong><div class="delta">${f.s}</div></div>`));

  $('aliasNote').textContent = `${als.length} alias`;
  poser($('aliasFlow'), als.length ? als.map(al => {
    const tone = al.urg === 'crit' ? 'hot' : al.urg === 'haute' ? 'amber' : 'key';
    const n = S.messages.filter(m => (m.toList || []).concat(m.deliveredTo || []).includes(al.addr)).length;
    return html`<div class="flowrow">
      <div class="toggle ${al.active !== false ? 'on' : ''} dead"><i></i></div>
      <span class="itile ${tone}">${ICON.route}</span>
      <div><strong>${al.addr}</strong>
        <span class="chain">${al.svc}<span class="arrow">→</span>ticket<span class="arrow">→</span><span class="mk">${URG[al.urg].toLowerCase()}</span>${al.send !== false ? ENVOI_OK : ''}</span></div>
      <div class="stat"><b>${n} reçu${n > 1 ? 's' : ''}</b>gardés</div>
    </div>`;
  }) : html`<div class="empty"><strong>Aucun alias</strong><p>Ajoutez un alias par service sur votre boîte à tickets.</p></div>`);
}

let openAliases = new Set();
function renderAccounts() {
  $('acctNote').textContent = `${S.accounts.length} boîte${S.accounts.length > 1 ? 's' : ''} · ${allAliases().length} alias`;
  const lignes = [];
  for (const a of S.accounts) {
    const p = PROVIDERS[a.provider] || PROVIDERS.manual;
    const als = aliasesOf(a);
    lignes.push(html`<tr data-arow=${a.id}>
      <td><div class="who-cell">
        ${als.length ? html`<button class="chev ${openAliases.has(a.id) ? 'open' : ''}" type="button" data-chev=${a.id}><svg class="i sm" viewBox="0 0 24 24"><path d="M9.5 5.5 16 12l-6.5 6.5"/></svg></button>` : html`<span class="cale"></span>`}
        <span class="itile mono ${isIntake(a) ? 'amber' : ''}">${p.mono}</span>
        <span><b>${a.name}</b><span>${a.addr}</span></span></div></td>
      <td class="cell-mono col-cache">${a.imapHost || '—'}:${a.imapPort}</td>
      <td class="col-cache2">${isIntake(a) ? html`<span class="pill amber">Boîte à tickets</span>` : html`<span class="pill">Courrier</span>`}</td>
      <td class="col-cache">${isIntake(a)
        ? html`<span class="chain">${als.length} alias<span class="arrow">→</span><span class="mk">un ticket par message</span>${a.aliasOnly ? html`<span class="arrow">·</span>alias seulement` : ''}</span>`
        : html`<span class="cell-muted">Livré dans la boîte</span>`}</td>
      <td class="col-cache2"><span class="tag ${a.lastError ? 'held' : a.lastOk ? '' : 'idle'}"><i class="d"></i>${a.lastError ? 'erreur' : a.lastOk ? 'relevée ' + ago(a.lastOk) : 'jamais relevée'}</span></td>
      <td class="cell-right"><button class="btn quiet sm" data-acct=${a.id}>Modifier</button></td>
    </tr>`);
    if (als.length && openAliases.has(a.id)) {
      lignes.push(...als.map(al => html`<tr class="sub">
        <td><div class="al"><span class="twig"></span><span class="addr">${al.addr}</span></div></td>
        <td class="cell-muted col-cache">alias</td>
        <td class="col-cache2"><span class="pill">${al.svc}</span></td>
        <td class="col-cache"><span class="chain">ticket<span class="arrow">→</span><span class="mk">${URG[al.urg].toLowerCase()}</span>${al.send !== false ? ENVOI_OK : ''}</span></td>
        <td class="col-cache2"><span class="tag ${al.active !== false ? '' : 'idle'}"><i class="d"></i>${al.active !== false ? 'actif' : 'inactif'}</span></td>
        <td class="cell-right"><button class="btn quiet sm" data-acct=${a.id}>Régler</button></td>
      </tr>`));
    }
  }
  poser($('acctBody'), lignes);
  $('acctBody').querySelectorAll('[data-acct]').forEach(b => b.onclick = () => openAccount(b.dataset.acct));
  $('acctBody').querySelectorAll('[data-chev]').forEach(b => b.onclick = () => {
    const id = b.dataset.chev;
    openAliases.has(id) ? openAliases.delete(id) : openAliases.add(id);
    renderAccounts();
  });
  $('acctBody').querySelectorAll('[data-arow]').forEach(tr => {
    tr.oncontextmenu = e => menuCompte(e, S.accounts.find(a => a.id === tr.dataset.arow));
  });
}

function menuCompte(e, a) {
  if (!a) return;
  e.preventDefault();
  menu(e.clientX, e.clientY, [
    { titre: a.addr },
    { label: 'Modifier la boîte', icon: ICON.mail, action: () => openAccount(a.id) },
    { label: 'Tester la connexion', action: async () => {
        toast('Test en cours…');
        try {
          const r = await api('POST', `/api/accounts/${a.id}/test`);
          toast(r.ok ? `Connexion OK · ${r.messages} messages` : `Échec : ${r.error}`);
        } catch (err) { toast(err.message); }
        await refresh();
      } },
    { label: 'Relever maintenant', icon: ICON.route, action: () => doPoll() },
    { label: 'Relever depuis zéro', action: async () => {
        if (!await confirmer('Relever depuis zéro ?', 'Les 20 derniers messages sont repris, lus ou non.')) return;
        const r = await api('POST', `/api/accounts/${a.id}/rescan`);
        toast(r.error ? `Erreur : ${r.error}` : `${r.fetched} message(s) repris`);
        await refresh();
      } },
    { sep: true },
    { label: a.aliasOnly ? "N'accepter que les alias : activé" : "N'accepter que les alias : désactivé",
      icon: ICON.ticket,
      action: async () => {
        await api('PATCH', `/api/accounts/${a.id}`, { aliasOnly: !a.aliasOnly });
        toast(a.aliasOnly ? 'Filtre désactivé' : 'Filtre activé');
        await refresh();
      } },
    { label: 'Purger les messages hors alias', danger: true, disabled: !a.aliasOnly,
      action: async () => {
        if (!await confirmer('Retirer les messages qui ne visaient aucun alias ?', 'Leurs tickets partent aussi.', { danger: true, oui: 'Retirer' })) return;
        const r = await api('POST', '/api/messages/purge-hors-alias?avecTickets=1');
        toast(`${r.retires} message(s) retiré(s)`); await refresh();
      } },
    { sep: true },
    { label: 'Supprimer la boîte', danger: true, action: async () => {
        if (!await confirmer(`Supprimer ${a.addr} ?`, 'Les tickets déjà ouverts restent.', { danger: true, oui: 'Supprimer' })) return;
        await api('DELETE', `/api/accounts/${a.id}`);
        toast('Boîte supprimée'); await refresh();
      } }
  ]);
}

function renderLog() {
  $('logNote').textContent = `${S.log.length} lignes`;
  const pill = k => k === 'ticket' ? 'pill amber' : k === 'erreur' ? 'pill bad'
    : k === 'envoi' ? 'pill out' : 'pill';
  poser($('logBody'), S.log.length ? S.log.map(l => html`<tr>
    <td class="cell-mono col-cache2">${l.from || '—'}</td>
    <td class="cell-muted col-cache">${l.to || '—'}</td>
    <td><span class=${pill(l.kind)}>${l.what}</span></td>
    <td class="cell-right cell-mono">${new Date(l.at).toLocaleTimeString('fr-FR')}</td>
  </tr>`) : html`<tr><td colspan="4"><div class="empty"><p>Rien encore.</p></div></td></tr>`);
}

const ruleScrim = $('ruleScrim');
let rDraft = { id: null, mode: 'all', conds: [] };

function resumeRegle(r) {
  const c = (r.conditions.items || []).map(i =>
    `${CHAMPS[i.champ] || i.champ} ${OPS[i.op] || i.op} « ${i.valeur} »`).join(r.conditions.mode === 'any' ? ' ou ' : ' et ');
  const a = r.actions || {};
  const actes = [];
  if (a.folder) actes.push('ranger dans ' + (folderName(a.folder) || a.folder));
  if (a.read === true) actes.push('marquer lu');
  if (a.read === false) actes.push('marquer non lu');
  if (a.ticket === 'non') actes.push('pas de ticket');
  if (a.ticket === 'oui') actes.push('forcer le ticket');
  if (a.urgency) actes.push('urgence ' + URG[a.urgency].toLowerCase());
  if (a.service) actes.push('service ' + a.service);
  if (a.delete) actes.push('supprimer');
  if (a.stop) actes.push('arrêter là');
  return { c, a: actes.join(', ') || 'aucune action' };
}

function renderRules() {
  const box = $('rulesList');
  const liste = S.rules || [];
  $('rulesNote').textContent = liste.length ? `${liste.length} règle${liste.length > 1 ? 's' : ''}` : '';
  if (!liste.length) {
    poser(box, html`<div class="empty"><strong>Aucune règle</strong><p>Une règle trie, marque, range ou supprime un message à son arrivée, avant la création du ticket.</p></div>`);
    return;
  }
  poser(box, liste.map(r => {
    const { c, a } = resumeRegle(r);
    return html`<div class="flowrow" data-rule=${r.id}>
      <div class="toggle ${r.enabled !== false ? 'on' : ''}" data-bascule=${r.id}><i></i></div>
      <span class="itile ${r.actions && r.actions.delete ? 'hot' : 'key'}">${ICON.route}</span>
      <div><strong>${r.name}</strong><span class="chain">${c}<span class="arrow">→</span><span class="mk">${a}</span></span></div>
      <div class="stat col-cache2"><b>${r.enabled !== false ? 'active' : 'en pause'}</b>clic droit</div>
    </div>`;
  }));
  box.querySelectorAll('[data-bascule]').forEach(t => t.onclick = async e => {
    e.stopPropagation();
    const r = (S.rules || []).find(x => x.id === t.dataset.bascule);
    await api('PATCH', '/api/rules/' + r.id, { enabled: r.enabled === false });
    await refresh();
  });
  box.querySelectorAll('[data-rule]').forEach(l => {
    l.onclick = () => openRule(l.dataset.rule);
    l.oncontextmenu = e => {
      e.preventDefault();
      const r = (S.rules || []).find(x => x.id === l.dataset.rule);
      menu(e.clientX, e.clientY, [
        { titre: r.name },
        { label: 'Modifier', action: () => openRule(r.id) },
        { label: 'Essayer à blanc', action: () => essaiRegle(r) },
        { sep: true },
        { label: 'Supprimer la règle', danger: true, action: async () => {
            if (!await confirmer(`Supprimer « ${r.name} » ?`, '', { danger: true, oui: 'Supprimer' })) return;
            await api('DELETE', '/api/rules/' + r.id); toast('Règle supprimée'); await refresh();
          } }
      ]);
    };
  });
}

function renderConds() {
  const box = $('rConds');
  if (!rDraft.conds.length) rDraft.conds = [{ champ: 'subject', op: 'contient', valeur: '' }];
  poser(box, rDraft.conds.map((c, i) => html`
    <div class="ligne cond">
      <select data-c=${i}>${Object.entries(CHAMPS).map(([k, v]) => html`<option value=${k} selected=${k === c.champ}>${v}</option>`)}</select>
      <select data-o=${i}>${Object.entries(OPS).map(([k, v]) => html`<option value=${k} selected=${k === c.op}>${v}</option>`)}</select>
      <input data-v=${i} value=${c.valeur} placeholder="texte à chercher">
      <button class="del" type="button" data-d=${i}><svg class="i sm" viewBox="0 0 24 24"><path d="M6.5 6.5l11 11M17.5 6.5l-11 11"/></svg></button>
    </div>`));
  box.querySelectorAll('[data-c]').forEach(el => el.onchange = () => rDraft.conds[+el.dataset.c].champ = el.value);
  box.querySelectorAll('[data-o]').forEach(el => el.onchange = () => rDraft.conds[+el.dataset.o].op = el.value);
  box.querySelectorAll('[data-v]').forEach(el => el.oninput = () => rDraft.conds[+el.dataset.v].valeur = el.value);
  box.querySelectorAll('[data-d]').forEach(el => el.onclick = () => { rDraft.conds.splice(+el.dataset.d, 1); renderConds(); });
}
$('rAddCond').onclick = () => { rDraft.conds.push({ champ: 'subject', op: 'contient', valeur: '' }); renderConds(); };
document.querySelectorAll('#rMode button').forEach(b => b.onclick = () => {
  rDraft.mode = b.dataset.mode;
  document.querySelectorAll('#rMode button').forEach(x => x.classList.toggle('on', x.dataset.mode === rDraft.mode));
});
$('rDelete').onclick = function () { this.classList.toggle('on'); };
$('rStop').onclick = function () { this.classList.toggle('on'); };

function corpsRegle() {
  return {
    name: $('rName').value.trim() || 'Sans nom',
    conditions: { mode: rDraft.mode, items: rDraft.conds.filter(c => c.valeur.trim() || c.op === 'regex') },
    actions: {
      folder: $('rFolder').value || undefined,
      read: $('rRead').value === '' ? undefined : $('rRead').value === '1',
      ticket: $('rTicket').value || undefined,
      urgency: $('rUrg').value || undefined,
      service: $('rService').value.trim() || undefined,
      delete: $('rDelete').classList.contains('on'),
      stop: $('rStop').classList.contains('on')
    }
  };
}

async function essaiRegle(r) {
  try {
    const res = await api('POST', '/api/rules/essai', { rule: r || corpsRegle() });
    toast(`${res.touches} message(s) touché(s) sur ${res.examines} examinés`);
  } catch (e) { toast(e.message); }
}
$('rEssai').onclick = () => essaiRegle();

function openRule(id) {
  const r = id ? (S.rules || []).find(x => x.id === id) : null;
  rDraft = { id: r ? r.id : null, mode: r ? r.conditions.mode : 'all',
    conds: r ? (r.conditions.items || []).map(c => ({ ...c })) : [] };
  $('rName').value = r ? r.name : '';
  poser($('rFolder'), html`<option value="">ne pas déplacer</option>`,
    (S.folders || []).map(f => html`<option value=${f.id}>${f.name}</option>`));
  const a = (r && r.actions) || {};
  $('rFolder').value = a.folder || '';
  $('rRead').value = a.read === undefined ? '' : (a.read ? '1' : '0');
  $('rTicket').value = a.ticket || '';
  $('rUrg').value = a.urgency || '';
  $('rService').value = a.service || '';
  $('rDelete').classList.toggle('on', Boolean(a.delete));
  $('rStop').classList.toggle('on', Boolean(a.stop));
  $('ruleTitle').textContent = r ? 'Modifier la règle' : 'Nouvelle règle';
  $('rSave').textContent = r ? 'Enregistrer' : 'Créer';
  document.querySelectorAll('#rMode button').forEach(x => x.classList.toggle('on', x.dataset.mode === rDraft.mode));
  renderConds();
  ruleScrim.classList.add('on');
  setTimeout(() => $('rName').focus(), 60);
}
$('addRule').onclick = () => openRule(null);
document.querySelectorAll('[data-close-rule]').forEach(b => b.onclick = () => ruleScrim.classList.remove('on'));
ruleScrim.onclick = e => { if (e.target === ruleScrim) ruleScrim.classList.remove('on'); };
$('ruleSheet').addEventListener('submit', async e => {
  e.preventDefault();
  const corps = corpsRegle();
  if (!corps.conditions.items.length) { toast('Ajoutez au moins une condition'); return; }
  try {
    if (rDraft.id) await api('PATCH', '/api/rules/' + rDraft.id, corps);
    else await api('POST', '/api/rules', corps);
    ruleScrim.classList.remove('on');
    toast(rDraft.id ? 'Règle enregistrée' : 'Règle créée');
    await refresh();
  } catch (err) { toast(err.message); }
});

const acctScrim = $('acctScrim');
let draft = { id: null, provider: 'manual', kind: 'mail', aliases: [] };

function renderProvs() {
  poser($('provs'), Object.entries(PROVIDERS).map(([k, p]) => html`
    <button type="button" class="prov ${draft.provider === k ? 'on' : ''}" data-prov=${k}>
      <span class="itile mono">${p.mono}</span><span><b>${p.label}</b><small>${p.hint}</small></span></button>`));
  $('provs').querySelectorAll('[data-prov]').forEach(b => b.onclick = () => {
    draft.provider = b.dataset.prov;
    const p = PROVIDERS[draft.provider];
    if (p.imap) { $('aImap').value = p.imap; $('aSmtp').value = p.smtp; }
    $('aImapPort').value = p.imapPort; $('aSmtpPort').value = p.smtpPort;
    renderProvs();
  });
}
function applyKind() {
  document.querySelectorAll('#kindSeg button').forEach(b => b.classList.toggle('on', b.dataset.kind === draft.kind));
  $('kindNote').classList.toggle('hidden', draft.kind !== 'tickets');
  poser($('aliasSect'), draft.kind === 'tickets'
    ? html`Alias <span class="hint">un alias par service — c’est lui qui décide du service et de l’urgence</span>`
    : html`Alias <span class="hint">adresse, service, urgence, droit d’envoi</span>`);
}
document.querySelectorAll('#kindSeg button').forEach(b => b.onclick = () => { draft.kind = b.dataset.kind; applyKind(); });
$('aOnly').onclick = function () { this.classList.toggle('on'); };

function renderAliasEditor() {
  const box = $('aliasEditor');
  if (!draft.aliases.length) {
    poser(box, html`<p class="vide-alias">Aucun alias.</p>`);
    return;
  }
  poser(box, draft.aliases.map((al, i) => html`
    <div class="ligne alias">
      <input class="mono" value=${al.addr} data-a=${i} placeholder="service@exemple.fr">
      <input value=${al.svc} data-s=${i} placeholder="service">
      <select data-u=${i}>${Object.entries(URG).map(([k, v]) => html`<option value=${k} selected=${k === al.urg}>${v}</option>`)}</select>
      <button class="send ${al.send !== false ? 'on' : ''}" type="button" data-x=${i} title=${al.send !== false ? 'Envoi autorisé' : 'Réception seule'}><svg class="i sm" viewBox="0 0 24 24"><path d="M20.5 3.5 3.5 10.4l6.6 2.6 2.6 6.6z"/><path d="M10.1 13 20.5 3.5"/></svg></button>
      <button class="del" type="button" data-d=${i}><svg class="i sm" viewBox="0 0 24 24"><path d="M6.5 6.5l11 11M17.5 6.5l-11 11"/></svg></button>
    </div>`));
  box.querySelectorAll('[data-a]').forEach(el => el.oninput = () => draft.aliases[+el.dataset.a].addr = el.value.trim());
  box.querySelectorAll('[data-s]').forEach(el => el.oninput = () => draft.aliases[+el.dataset.s].svc = el.value.trim());
  box.querySelectorAll('[data-u]').forEach(el => el.onchange = () => draft.aliases[+el.dataset.u].urg = el.value);
  box.querySelectorAll('[data-x]').forEach(el => el.onclick = () => {
    const a = draft.aliases[+el.dataset.x]; a.send = a.send === false; renderAliasEditor();
  });
  box.querySelectorAll('[data-d]').forEach(el => el.onclick = () => { draft.aliases.splice(+el.dataset.d, 1); renderAliasEditor(); });
}
$('addAlias').onclick = () => { draft.aliases.push({ addr: '', svc: 'autre', urg: 'normale', active: true, send: true }); renderAliasEditor(); };

function openAccount(id) {
  const a = id ? S.accounts.find(x => x.id === id) : null;
  draft = a
    ? { id: a.id, provider: a.provider || 'manual', kind: a.kind || 'mail', aliases: aliasesOf(a).map(x => ({ ...x })) }
    : { id: null, provider: 'manual', kind: 'mail', aliases: [] };
  $('aName').value = a?.name || '';
  $('aAddr').value = a?.addr || '';
  $('aUser').value = a?.imapUser || '';
  $('aPass').value = '';
  $('aImap').value = a?.imapHost || '';
  $('aImapPort').value = a?.imapPort || 993;
  $('aSmtp').value = a?.smtpHost || '';
  $('aSmtpPort').value = a?.smtpPort || 465;
  $('aFolder').value = a?.folder || 'INBOX';
  $('aSeen').value = a?.markSeen === false ? '0' : '1';
  $('aTls').value = a?.imapTls === false ? '0' : '1';
  $('aCert').value = a?.imapPin || a?.smtpPin ? '0' : '1';
  $('aImapPin').value = a?.imapPin === 'premiere' ? '' : (a?.imapPin || '');
  $('aSmtpPin').value = a?.smtpPin === 'premiere' ? '' : (a?.smtpPin || '');
  $('aPins').classList.toggle('hidden', $('aCert').value === '1');
  $('aOnly').classList.toggle('on', Boolean(a?.aliasOnly));
  $('acctSheetTitle').textContent = a ? 'Modifier la boîte' : 'Ajouter une boîte';
  $('acctSheetSub').textContent = a ? a.addr : 'IMAP et SMTP';
  $('acctSaveLabel').textContent = a ? 'Enregistrer' : 'Ajouter';
  $('delAccount').classList.toggle('hidden', !a);
  $('testAccount').classList.toggle('hidden', !a);
  renderProvs(); applyKind(); renderAliasEditor();
  acctScrim.classList.add('on');
  setTimeout(() => $('aName').focus(), 60);
}
$('addAccount').onclick = () => openAccount(null);
$('aCert').onchange = () => $('aPins').classList.toggle('hidden', $('aCert').value === '1');
document.querySelectorAll('[data-close-acct]').forEach(b => b.onclick = () => acctScrim.classList.remove('on'));
acctScrim.onclick = e => { if (e.target === acctScrim) acctScrim.classList.remove('on'); };

$('acctSheet').addEventListener('submit', async e => {
  e.preventDefault();
  const body = {
    name: $('aName').value.trim(), addr: $('aAddr').value.trim().toLowerCase(),
    imapUser: $('aUser').value.trim(), imapHost: $('aImap').value.trim(), imapPort: +$('aImapPort').value || 993,
    smtpHost: $('aSmtp').value.trim(), smtpPort: +$('aSmtpPort').value || 465,
    folder: $('aFolder').value.trim() || 'INBOX', markSeen: $('aSeen').value === '1',
    imapTls: $('aTls').value === '1',
    imapPin: $('aCert').value === '0' ? $('aImapPin').value.trim() : '',
    smtpPin: $('aCert').value === '0' ? $('aSmtpPin').value.trim() : '',
    aliasOnly: $('aOnly').classList.contains('on'),
    provider: draft.provider, kind: draft.kind, aliases: draft.aliases.filter(a => a.addr)
  };
  const pass = $('aPass').value;
  if (pass) body.password = pass;
  try {
    if (draft.id) await api('PATCH', `/api/accounts/${draft.id}`, body);
    else await api('POST', '/api/accounts', body);
    acctScrim.classList.remove('on');
    toast(draft.id ? 'Boîte enregistrée' : 'Boîte ajoutée');
    await refresh();
  } catch (err) { toast(err.message); }
});
$('delAccount').onclick = async () => {
  if (!await confirmer('Supprimer cette boîte ?', 'Les tickets déjà ouverts restent.', { danger: true, oui: 'Supprimer' })) return;
  await api('DELETE', `/api/accounts/${draft.id}`);
  acctScrim.classList.remove('on'); toast('Boîte supprimée'); await refresh();
};
$('testAccount').onclick = async () => {
  const btn = $('testAccount');
  poser(btn, html`<span class="spin"></span> Test…`);
  try {
    const r = await api('POST', `/api/accounts/${draft.id}/test`);
    if (r.ok) toast(`Connexion OK · ${r.messages} messages dans le dossier`);
    else if (r.empreinte && await confirmer('Certificat non reconnu', `Le serveur présente l’empreinte ${r.empreinte}. Si c’est bien ton serveur (vérifie-la sur la machine), épingle-la : seul ce certificat sera accepté.`, { oui: 'Épingler' })) {
      $('aCert').value = '0'; $('aPins').classList.remove('hidden'); $('aImapPin').value = r.empreinte;
      await api('PATCH', `/api/accounts/${draft.id}`, { imapPin: r.empreinte });
      toast('Empreinte épinglée : teste à nouveau');
    } else if (!r.ok) toast(`Échec : ${r.error}`);
  } catch (e) { toast(e.message); }
  btn.textContent = 'Tester';
  await refresh();
};

const tkScrim = $('tkScrim');
let tDraft = { id: null, urgency: 'normale', status: 'nouveau', messageId: null };
function syncTk() {
  document.querySelectorAll('#urgSeg button').forEach(b => b.classList.toggle('on', b.dataset.urg === tDraft.urgency));
  document.querySelectorAll('#stSeg button').forEach(b => b.classList.toggle('on', b.dataset.st === tDraft.status));
}
document.querySelectorAll('#urgSeg button').forEach(b => b.onclick = () => { tDraft.urgency = b.dataset.urg; syncTk(); });
document.querySelectorAll('#stSeg button').forEach(b => b.onclick = () => { tDraft.status = b.dataset.st; syncTk(); });

function openTicket(id, fromMsg) {
  const t = id ? ticketOf(id) : null;
  tDraft = { id: t?.id || null, urgency: t?.urgency || 'normale', status: t?.status || 'nouveau', messageId: fromMsg?.id || null };
  $('tService').value = t?.service || '';
  $('tHost').value = t?.host || '';
  $('tSubj').value = t?.subject || fromMsg?.subject || '';
  $('tNotes').value = t?.notes || '';
  $('tkTitle').textContent = t ? t.id : 'Nouveau ticket';
  $('tkSub').textContent = t
    ? `${t.service} · ${t.auto ? 'ouvert automatiquement' : 'créé à la main'}${t.occurrences > 1 ? ` · ${Number(t.occurrences)} occurrences` : ''}`
    : 'créé à la main';
  $('tkSaveLabel').textContent = t ? 'Enregistrer' : 'Créer';
  $('tkDelete').classList.toggle('hidden', !t);
  $('tkHistWrap').classList.toggle('hidden', !t);
  if (t) poser($('tkHist'), (t.history || []).slice().reverse()
    .map(e => html`<li><time>${new Date(e.at).toLocaleString('fr-FR')}</time><span>${e.what}</span></li>`));
  syncTk();
  tkScrim.classList.add('on');
  setTimeout(() => $('tSubj').focus(), 60);
}
document.querySelectorAll('[data-close-tk]').forEach(b => b.onclick = () => tkScrim.classList.remove('on'));
tkScrim.onclick = e => { if (e.target === tkScrim) tkScrim.classList.remove('on'); };
$('newTicket').onclick = () => openTicket(null);
$('tkDelete').onclick = async () => {
  await api('DELETE', `/api/tickets/${tDraft.id}`);
  tkScrim.classList.remove('on'); toast('Ticket supprimé'); await refresh();
};
$('tkSheet').addEventListener('submit', async e => {
  e.preventDefault();
  const body = {
    service: $('tService').value.trim() || 'autre', host: $('tHost').value.trim(),
    subject: $('tSubj').value.trim(), notes: $('tNotes').value,
    urgency: tDraft.urgency, status: tDraft.status
  };
  try {
    if (tDraft.id) await api('PATCH', `/api/tickets/${tDraft.id}`, body);
    else await api('POST', '/api/tickets', { ...body, messageId: tDraft.messageId });
    tkScrim.classList.remove('on'); toast(tDraft.id ? 'Ticket enregistré' : 'Ticket ouvert');
    await refresh();
  } catch (err) { toast(err.message); }
});

const replyScrim = $('replyScrim');
let rCtx = {};
function expediteursPossibles(acc) {
  const liste = acc ? [acc] : S.accounts;
  return liste.flatMap(a => [a.addr, ...aliasesOf(a).filter(x => x.send !== false).map(x => x.addr)]).filter(Boolean);
}
function openReply(m, defaultFrom) {
  const acc = S.accounts.find(a => a.id === m.accountId);
  const options = expediteursPossibles(acc);
  $('replyTitle').textContent = 'Répondre';
  poser($('rFrom'), options.map(o => html`<option value=${o} selected=${o === defaultFrom}>${o}</option>`));
  $('rTo').value = m.fromAddr;
  $('rSubj').value = /^re\s*:/i.test(m.subject) ? m.subject : `Re: ${m.subject}`;
  $('rText').value = '\n\n— ' + (m.fromName || m.fromAddr) + ' a écrit :\n' + String(m.text || '').split('\n').map(l => '> ' + l).join('\n');
  $('replySub').textContent = m.subject;
  $('replyErr').textContent = '';
  rCtx = { inReplyTo: m.messageId };
  replyScrim.classList.add('on');
  setTimeout(() => $('rText').focus(), 60);
}
function openCompose() {
  const options = expediteursPossibles(null);
  if (!options.length) { toast('Ajoutez d’abord une boîte'); return; }
  $('replyTitle').textContent = 'Écrire';
  $('replySub').textContent = 'nouveau message';
  poser($('rFrom'), options.map(o => html`<option value=${o}>${o}</option>`));
  $('rTo').value = ''; $('rSubj').value = ''; $('rText').value = '';
  $('replyErr').textContent = '';
  rCtx = { inReplyTo: null };
  replyScrim.classList.add('on');
  setTimeout(() => $('rTo').focus(), 60);
}
$('composeNow').onclick = openCompose;
document.querySelectorAll('[data-close-reply]').forEach(b => b.onclick = () => replyScrim.classList.remove('on'));
replyScrim.onclick = e => { if (e.target === replyScrim) replyScrim.classList.remove('on'); };
$('replySheet').addEventListener('submit', async e => {
  e.preventDefault();
  $('replyErr').textContent = '';
  $('replyLabel').textContent = 'Envoi…';
  try {
    await api('POST', '/api/send', {
      from: $('rFrom').value, to: $('rTo').value,
      subject: $('rSubj').value, text: $('rText').value, inReplyTo: rCtx.inReplyTo
    });
    replyScrim.classList.remove('on'); toast('Message envoyé'); await refresh();
  } catch (err) {
    // L'erreur SMTP est affichée telle quelle : c'est elle qui dit quoi corriger.
    $('replyErr').textContent = err.message;
  }
  $('replyLabel').textContent = 'Envoyer';
});

function renderPrefs() {
  const s = S.settings || {};
  $('sPoll').value = s.pollSeconds ?? 120;
  $('sDedup').value = s.dedupMinutes ?? 30;
  $('sRet').value = s.retentionDays ?? 30;
  const t = s.telegram || {};
  $('tgOn').classList.toggle('on', Boolean(t.enabled));
  $('tgChat').value = t.chatId || '';
  $('tgMin').value = t.minUrgency || 'haute';
  $('apiOrigins').value = (s.api?.origins || []).join('\n');
  const cles = s.api?.cles || {};
  $('apiKey').value = cles.complete ? 'posée · pk_…' : 'aucune';
  $('apiSendKey').value = cles.envoi ? 'posée · sk_…' : 'aucune';
  if ($('apiRotate')) $('apiRotate').textContent = cles.complete ? 'Régénérer la clé complète' : 'Créer la clé complète';
  if ($('apiRotateSend')) $('apiRotateSend').textContent = cles.envoi ? 'Régénérer la clé d’envoi' : 'Créer la clé d’envoi';
  const w = s.webhook || {};
  $('hookOn').classList.toggle('on', Boolean(w.enabled));
  $('hookUrl').value = w.url || '';
  $('hookHeader').value = w.keyHeader || 'x-cachet-key';
  const l = w.last || {};
  $('hookNote').textContent = !l.at ? 'jamais appelé'
    : l.ok ? `dernier appel accepté · ${ago(l.at)}`
    : `dernier appel en échec : ${l.error || 'HTTP ' + l.status}`;
}
$('tgOn').onclick = function () { this.classList.toggle('on'); };
$('hookOn').onclick = function () { this.classList.toggle('on'); };

$('saveSettings').onclick = async () => {
  await api('PATCH', '/api/settings', {
    pollSeconds: +$('sPoll').value, dedupMinutes: +$('sDedup').value, retentionDays: +$('sRet').value
  });
  toast('Réglages enregistrés'); await refresh();
};
$('saveTg').onclick = async () => {
  await api('PATCH', '/api/settings', {
    telegram: { enabled: $('tgOn').classList.contains('on'), chatId: $('tgChat').value,
      minUrgency: $('tgMin').value, token: $('tgToken').value || undefined }
  });
  $('tgToken').value = ''; toast('Telegram enregistré'); await refresh();
};
$('saveApi').onclick = async () => {
  const origines = $('apiOrigins').value.split(/[\n,]+/).map(o => o.trim()).filter(Boolean);
  await api('PATCH', '/api/settings', { api: { origins: origines } });
  toast('Origines enregistrées'); await refresh();
};
// Une clé neuve ne se montre qu'ici, une fois : CACHET n'en garde que l'empreinte.
async function creerCle(envoi) {
  const posee = S.settings?.api?.cles?.[envoi ? 'envoi' : 'complete'];
  if (posee && !await confirmer(envoi ? 'Régénérer la clé d’envoi ?' : 'Régénérer la clé complète ?',
    envoi ? 'Les services qui utilisent l’ancienne ne pourront plus envoyer.' : 'Les services qui utilisent l’ancienne perdront l’accès.', { danger: true, oui: 'Régénérer' })) return;
  try {
    const r = await api('POST', '/api/apikey/rotate' + (envoi ? '?quoi=envoi' : ''));
    const valeur = envoi ? r.sendKey : r.key;
    const champ = h('input', { class: 'field mono', type: 'text', readonly: true, value: valeur, 'aria-label': 'Clé' });
    await dialogue({
      titre: envoi ? 'Clé d’envoi' : 'Clé complète',
      texte: 'Copie-la maintenant : elle ne sera plus affichée. CACHET n’en garde que l’empreinte.',
      contenu: [champ],
      boutons: [{ texte: 'Copier', classe: 'solid', agir: () => { copier(valeur, 'Clé copiée'); return false; } }, { texte: 'J’ai copié la clé', classe: '', valeur: true }],
    });
    await refresh();
  } catch (e) { toast(e.message); }
}
$('apiRotate').onclick = () => creerCle(false);
$('apiRotateSend').onclick = () => creerCle(true);
$('saveHook').onclick = async () => {
  await api('PATCH', '/api/settings', {
    webhook: {
      enabled: $('hookOn').classList.contains('on'),
      url: $('hookUrl').value.trim(),
      keyHeader: $('hookHeader').value.trim() || 'x-cachet-key',
      key: $('hookKey').value || undefined,
      secret: $('hookSecret').value || undefined
    }
  });
  $('hookKey').value = ''; $('hookSecret').value = '';
  toast('Webhook enregistré'); await refresh();
};
$('testHook').onclick = async () => {
  const b = $('testHook'); poser(b, html`<span class="spin"></span> Essai…`);
  try {
    const r = await api('POST', '/api/webhook/test');
    toast(r.ok ? 'Le service a répondu, liaison bonne' : `Échec : ${r.error || 'HTTP ' + r.status}`);
  } catch (e) { toast(e.message); }
  b.textContent = 'Envoyer un essai'; await refresh();
};

async function doPoll() {
  try {
    const r = await api('POST', '/api/poll');
    if (r.error) toast(`Relève partielle : ${r.error}`);
    else if (r.fetched) toast(`${r.fetched} nouveau${r.fetched > 1 ? 'x' : ''} message${r.fetched > 1 ? 's' : ''}`);
    else toast('Rien de neuf');
  } catch (e) { toast(e.message); }
  await refresh();
}
$('pollNow').onclick = () => doPoll();
$('pollNow2').onclick = () => doPoll();

async function refresh() {
  try {
    // Une réponse tronquée (service qui redémarre) ne remplace pas l'état connu.
    const neuf = await api('GET', '/api/state');
    if (!neuf || !Array.isArray(neuf.accounts)) return;
    S = neuf;
  } catch (e) {
    // Réseau coupé ou service qui redémarre : on le dit, et la prochaine relève réessaie.
    if (e instanceof TypeError) toast('Service injoignable pour l’instant : nouvel essai bientôt.');
    else if (!/Session expirée/i.test(e.message)) { console.error('[refresh]', e); toast(e.message); }
    return;
  }
  render();
}

let clockTimer;
function startClock() {
  clearInterval(clockTimer);
  clockTimer = setInterval(() => {
    const every = (S.settings?.pollSeconds || 120) * 1000;
    const last = S.poll?.at ? new Date(S.poll.at).getTime() : Date.now();
    const left = Math.max(0, Math.round((last + every - Date.now()) / 1000));
    $('next').textContent = `${Math.floor(left / 60)}:${String(left % 60).padStart(2, '0')}`;
    $('pollBar').style.width = `${Math.min(100, 100 - (left / (every / 1000)) * 100)}%`;
    $('lastPoll').textContent = ago(S.poll?.at);
    if (left === 0) refresh();
  }, 1000);
  setInterval(refresh, 30000);
}

// Renseigné tout de suite : cette valeur ne dépend d'aucune donnée du serveur.
if ($('apiBase')) $('apiBase').value = location.origin + '/api';

appliquerTheme();
const marque = h('img', { src: '/mark.png', alt: '', width: '18', height: '18', class: 'marque-porte' });
const etat = await porte({ api: socle, service: 'CACHET', marque, sousTitre: 'arrivée des alertes et suivi des tickets' });
const role = etat.session.compte.role;
// Ce que le rôle ne permet pas n'est pas proposé ; le serveur le refuserait.
document.body.dataset.role = role;
document.querySelectorAll('[data-admin]').forEach(el => { if (role !== 'admin') el.remove(); });
document.querySelectorAll('[data-membre]').forEach(el => { if (role === 'lecture') el.remove(); });
$('app').classList.remove('hidden');
await refresh();
startClock();
