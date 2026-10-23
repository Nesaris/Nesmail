// Connexions TLS sortantes vers les serveurs de courrier. Deux façons de faire
// confiance à un serveur : la chaîne d'autorités du système (par défaut), ou
// l'empreinte SHA-256 de son certificat, épinglée par l'administrateur pour un
// serveur auto-signé. Il n'existe pas de troisième voie : un certificat ni
// signé ni épinglé est refusé, et rien n'est écrit sur la connexion avant.
import tls from 'node:tls';
import net from 'node:net';
import { lookupGarde } from './reseau.js';

// Valeur spéciale venue de la 1.0 (« accepter un auto-signé ») : l'empreinte
// vue à la prochaine connexion est épinglée, et toutes les suivantes doivent
// la présenter.
export const PREMIERE = 'premiere';

const HEX = /^[0-9A-F]{64}$/;

export function normaliserEmpreinte(v) {
  const s = String(v || '').trim();
  if (!s) return '';
  if (s === PREMIERE) return PREMIERE;
  const hex = s.replace(/[:\s]/g, '').toUpperCase();
  if (!HEX.test(hex)) return null;
  return hex.match(/../g).join(':');
}

export class ErreurCertificat extends Error {
  constructor(message, empreinte) { super(message); this.empreinte = empreinte; }
}

// Ouvre une session TLS (sur une socket déjà ouverte pour STARTTLS) et ne la
// rend qu'une fois la confiance établie. surEpingle(empreinte) est appelé quand
// une première empreinte vient d'être retenue.
export function connecterTls({ host, port, socket = null, epingle = '', surEpingle = null, delai = 20000 }) {
  const pin = normaliserEmpreinte(epingle);
  if (pin === null) return Promise.reject(new ErreurCertificat('Empreinte de certificat invalide : 64 caractères hexadécimaux attendus.'));
  return new Promise((resolve, reject) => {
    // La vérification se fait ici, à la poignée de main achevée, avant le
    // premier octet applicatif : la chaîne d'autorités et le nom (authorized,
    // calculé par Node), ou l'empreinte épinglée. L'empreinte présentée est
    // ainsi connue même quand le certificat est refusé.
    const s = tls.connect({
      host, port, rejectUnauthorized: false, minVersion: 'TLSv1.2', lookup: lookupGarde,
      ...(socket ? { socket } : {}),
      ...(net.isIP(host) ? {} : { servername: host }),
    });
    const minuterie = setTimeout(() => s.destroy(new Error('délai TLS dépassé')), delai);
    s.once('error', e => { clearTimeout(minuterie); reject(e); });
    s.once('secureConnect', () => {
      clearTimeout(minuterie);
      const vue = s.getPeerCertificate()?.fingerprint256 || '';
      const refuser = message => { s.destroy(); reject(new ErreurCertificat(`${message} — empreinte présentée : ${vue}`, vue)); };
      if (!pin) {
        if (!s.authorized) return refuser(`certificat refusé (${s.authorizationError || 'non vérifié'})`);
      } else if (pin === PREMIERE) {
        surEpingle?.(vue);
      } else if (vue !== pin) {
        return refuser('certificat différent de celui épinglé');
      }
      resolve(s);
    });
  });
}
