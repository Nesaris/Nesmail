'use strict';
// Nettoyage du HTML des mails : on garde la mise en forme, on retire tout ce qui
// peut exécuter du code, pister ou sortir du cadre. Liste blanche, pas liste noire.

const BALISES = new Set([
  'p', 'br', 'hr', 'div', 'span', 'section', 'article',
  'b', 'strong', 'i', 'em', 'u', 's', 'strike', 'del', 'ins', 'mark', 'small', 'sub', 'sup',
  'h1', 'h2', 'h3', 'h4', 'h5', 'h6',
  'ul', 'ol', 'li', 'dl', 'dt', 'dd',
  'blockquote', 'q', 'cite', 'pre', 'code', 'kbd', 'samp',
  'a', 'table', 'thead', 'tbody', 'tfoot', 'tr', 'td', 'th', 'caption', 'col', 'colgroup'
]);

// Blocs retirés avec leur contenu : ils ne contiennent rien de lisible.
const BLOCS = /<(script|style|head|title|noscript|template|iframe|object|embed|svg|math|form|button|input|select|textarea)\b[\s\S]*?<\/\1\s*>/gi;

function echappe(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;')
    .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function lienSur(valeur) {
  const v = String(valeur || '').trim().replace(/[\u0000-\u001f]/g, '');
  // Seuls les schémas inoffensifs : surtout pas javascript: ni data:
  if (/^(https?:|mailto:|tel:)/i.test(v)) return v;
  if (/^[#/]/.test(v)) return null;
  return null;
}

function nettoie(html, { max = 400000 } = {}) {
  if (!html) return { html: '', imagesMasquees: 0 };
  let s = String(html).slice(0, max);

  s = s.replace(BLOCS, ' ');
  s = s.replace(/<!--[\s\S]*?-->/g, '');
  s = s.replace(/<\?[\s\S]*?\?>/g, '');

  // Les images distantes servent presque toujours de mouchard : on les compte et on les retire.
  let imagesMasquees = 0;
  s = s.replace(/<img\b[^>]*>/gi, () => { imagesMasquees++; return ''; });

  s = s.replace(/<\/?([a-zA-Z][a-zA-Z0-9]*)\b([^>]*)>/g, (brut, nom, attrs) => {
    const balise = nom.toLowerCase();
    if (!BALISES.has(balise)) return '';
    if (brut.startsWith('</')) return '</' + balise + '>';

    let gardes = '';
    if (balise === 'a') {
      const m = attrs.match(/\bhref\s*=\s*("([^"]*)"|'([^']*)'|([^\s>]+))/i);
      const url = m ? lienSur(m[2] ?? m[3] ?? m[4]) : null;
      if (url) gardes = ` href="${echappe(url)}" target="_blank" rel="noopener noreferrer nofollow"`;
      else return ''; // un lien sans cible valable n'a pas à rester cliquable
    }
    const auto = /^(br|hr|col)$/.test(balise) ? ' /' : '';
    return `<${balise}${gardes}${auto}>`;
  });

  // Un lien ouvert sans fermeture laisserait le reste du message dans l'ancre.
  s = s.replace(/\s{3,}/g, ' ').replace(/(<br\s*\/>\s*){3,}/gi, '<br /><br />').trim();
  return { html: s, imagesMasquees };
}

module.exports = { nettoie, BALISES };
