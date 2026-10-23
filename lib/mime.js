'use strict';
// Décodage MIME : en-têtes encodés, quoted-printable, base64, multipart.

function decodeQP(str, charset) {
  const bytes = [];
  for (let i = 0; i < str.length; i++) {
    const c = str[i];
    if (c === '=') {
      const next = str.slice(i + 1, i + 3);
      if (/^\r?\n/.test(str.slice(i + 1))) { i += str[i + 1] === '\r' ? 2 : 1; continue; }
      if (/^[0-9A-Fa-f]{2}$/.test(next)) { bytes.push(parseInt(next, 16)); i += 2; continue; }
    }
    bytes.push(c.charCodeAt(0) & 0xff);
  }
  return Buffer.from(bytes).toString(charset || 'utf8');
}

function toNodeCharset(cs) {
  const c = String(cs || 'utf-8').toLowerCase().replace(/["']/g, '');
  if (c === 'utf-8' || c === 'utf8') return 'utf8';
  if (c === 'us-ascii' || c === 'ascii') return 'ascii';
  if (c.startsWith('iso-8859') || c.startsWith('windows-12')) return 'latin1';
  return 'utf8';
}

// =?UTF-8?B?...?= / =?ISO-8859-1?Q?...?=
function decodeWords(input) {
  if (!input) return '';
  return String(input).replace(/=\?([^?]+)\?([BbQq])\?([^?]*)\?=/g, (m, cs, enc, txt) => {
    const charset = toNodeCharset(cs);
    try {
      if (enc.toUpperCase() === 'B') return Buffer.from(txt, 'base64').toString(charset);
      return decodeQP(txt.replace(/_/g, ' '), charset);
    } catch { return txt; }
  });
}

function unfold(raw) { return String(raw).replace(/\r?\n[ \t]+/g, ' '); }

function parseHeaders(raw) {
  const out = {};
  for (const line of unfold(raw).split(/\r?\n/)) {
    const i = line.indexOf(':');
    if (i < 1) continue;
    const key = line.slice(0, i).trim().toLowerCase();
    const val = line.slice(i + 1).trim();
    if (out[key] === undefined) out[key] = val;
    else out[key] += ', ' + val;
  }
  return out;
}

function param(headerValue, name) {
  if (!headerValue) return null;
  const re = new RegExp(name + '\\s*=\\s*(?:"([^"]*)"|([^;\\s]+))', 'i');
  const m = headerValue.match(re);
  return m ? (m[1] || m[2]) : null;
}

function decodeBody(body, encoding, charset) {
  const enc = String(encoding || '7bit').toLowerCase();
  const cs = toNodeCharset(charset);
  if (enc === 'base64') return Buffer.from(body.replace(/\s+/g, ''), 'base64').toString(cs);
  if (enc === 'quoted-printable') return decodeQP(body, cs);
  return Buffer.from(body, 'binary').toString(cs);
}

function htmlToText(html) {
  return String(html)
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|tr|li|h[1-6]|table)>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#0?39;/g, "'")
    .replace(/\n{3,}/g, '\n\n').trim();
}

// Retourne le meilleur corps texte, et la version HTML d'origine si elle existe.
function extractText(raw) {
  const split = raw.indexOf('\r\n\r\n') >= 0 ? raw.indexOf('\r\n\r\n') : raw.indexOf('\n\n');
  if (split < 0) return { headers: parseHeaders(raw), text: '', html: '' };
  const headers = parseHeaders(raw.slice(0, split));
  const body = raw.slice(split).replace(/^\r?\n\r?\n/, '');
  const trouve = { html: '' };
  const text = walk(headers, body, 0, trouve);
  return { headers, text, html: trouve.html };
}

function walk(headers, body, depth = 0, trouve = null) {
  const ctype = headers['content-type'] || 'text/plain';
  if (depth > 6) return '';

  if (/^multipart\//i.test(ctype)) {
    const boundary = param(ctype, 'boundary');
    if (!boundary) return '';
    const parts = body.split(new RegExp('--' + boundary.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
    const found = [];
    for (const part of parts) {
      const trimmed = part.replace(/^\r?\n/, '');
      if (!trimmed || /^--/.test(trimmed)) continue;
      const cut = trimmed.indexOf('\r\n\r\n') >= 0 ? trimmed.indexOf('\r\n\r\n') : trimmed.indexOf('\n\n');
      if (cut < 0) continue;
      const ph = parseHeaders(trimmed.slice(0, cut));
      const pb = trimmed.slice(cut).replace(/^\r?\n\r?\n/, '');
      const txt = walk(ph, pb, depth + 1, trouve);
      if (txt) found.push({ type: String(ph['content-type'] || 'text/plain').toLowerCase(), txt });
    }
    const plain = found.find(f => f.type.startsWith('text/plain'));
    if (plain) return plain.txt;
    const html = found.find(f => f.type.startsWith('text/html'));
    if (html) return html.txt;
    return found.length ? found[0].txt : '';
  }

  const decoded = decodeBody(body, headers['content-transfer-encoding'], param(ctype, 'charset'));
  if (/^text\/html/i.test(ctype)) {
    // On garde la première version HTML : c'est d'elle que vient la mise en forme.
    if (trouve && !trouve.html) trouve.html = decoded;
    return htmlToText(decoded);
  }
  if (/^text\//i.test(ctype) || depth === 0) return decoded.trim();
  return '';
}

function addressOf(headerValue) {
  if (!headerValue) return { name: '', addr: '' };
  const v = decodeWords(headerValue);
  const m = v.match(/<([^>]+)>/);
  const addr = (m ? m[1] : v).trim().toLowerCase();
  let name = m ? v.slice(0, m.index).trim() : '';
  name = name.replace(/^["']|["']$/g, '').trim();
  return { name: name || addr.split('@')[0], addr };
}

function addressList(headerValue) {
  if (!headerValue) return [];
  return decodeWords(headerValue).split(/,(?![^<]*>)/).map(s => addressOf(s).addr).filter(Boolean);
}

module.exports = { decodeWords, parseHeaders, extractText, addressOf, addressList, htmlToText, decodeBody, param };
