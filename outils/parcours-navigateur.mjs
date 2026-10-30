// Parcours réel de RAVYN dans Chromium : installation du premier compte (clé
// d'accès virtuelle), une boîte à tickets relevée sur un serveur IMAP d'essai,
// puis chaque écran dans chaque gamme (SOMA, Console, Exploitation, Lavande),
// clair et sombre, avec le contrôle de mise en page du socle à chaque largeur.
// Usage : node outils/parcours-navigateur.mjs [dossier-des-captures]
// (Playwright est cherché dans PLAYWRIGHT, sinon dans les modules du projet.)
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import tls from 'node:tls';
import { chevauchements, LARGEURS } from '../socle/essai/mise-en-page.mjs';
import { passerAssistant, ouvrirReglagesService } from '../socle/essai/assistant-navigateur.mjs';
import { certificatEssai } from '../socle/essai/smtp.js';
import { imapServer, makeMessage } from '../test/mocks.js';
import { demarrer } from '../lib/serveur.js';

const { chromium } = await import(process.env.PLAYWRIGHT || 'playwright');
const sortie = process.argv[2] || path.join(os.tmpdir(), 'captures-ravyn');
fs.mkdirSync(sortie, { recursive: true });
const MDP = 'phrase de passe pour ravyn en local';
const JETON = 'jeton-installation-du-parcours-0123456789';
const SONDE = '<img src=x onerror=window.__xss=1>';

const cert = certificatEssai('localhost');
tls.setDefaultCACertificates([...tls.getCACertificates('default'), cert.cert]);
const imap = imapServer([
  makeMessage({ from: 'noreply@sup.exemple.fr', to: 'rmm@exemple.fr', subject: 'Agent hors ligne sur srv01', body: 'Machine : srv01\nDurée : 11 minutes' }),
  makeMessage({ from: 'bot@conteneurs.exemple.fr', to: 'conteneurs@exemple.fr', subject: 'api redémarre en boucle', body: 'Machine : srv01\nCode : 137', encoded: 'multipart' }),
  makeMessage({ from: 'proxy@exemple.fr', to: 'proxy@exemple.fr', subject: 'Certificat renouvelé', body: 'Machine : proxy\nRAS' }),
  // Sonde : du balisage dans chaque champ affiché. Il doit rester du texte.
  makeMessage({ from: '"<b>Sonde</b>" <sonde@exemple.fr>', to: 'rmm@exemple.fr', subject: SONDE + ' sonde', body: 'Machine : ' + SONDE + '\n<svg onload=window.__xss=1></svg>', encoded: 'multipart' }),
], { mode: 'tls', certificat: cert });
const portImap = await imap.ecouter();

const dossier = fs.mkdtempSync(path.join(os.tmpdir(), 'ravyn-parcours-'));
const muet = { info() {}, warn() {}, error: (...a) => console.error(...a) };
const env = gamme => ({ RAVYN_DATA: dossier, PORT: '0', HOTE: '127.0.0.1', SOCLE_JETON_INSTALLATION: JETON, SOCLE_THEME: gamme, SOCLE_ARGON2_M: '19456', SOCLE_ARGON2_T: '2', SOCLE_ARGON2_P: '1' });

const navigateur = await chromium.launch();
const rapport = [];
const erreurs = [];

async function controle(page, nom) {
  for (const w of LARGEURS) {
    await page.setViewportSize({ width: w, height: w < 500 ? 780 : 900 });
    await page.waitForTimeout(200);
    const defauts = await page.evaluate(chevauchements);
    const brut = await page.evaluate(() => (document.body.innerText.match(/\b(null|undefined|NaN)\b/) || [])[0]);
    if (brut) defauts.push({ type: 'texte-brut', detail: `« ${brut} » affiché` });
    const injecte = await page.evaluate(() => (window.__xss ? 1 : 0) + document.querySelectorAll('[onerror],[onload],img[src="x"]').length);
    if (injecte) defauts.push({ type: 'injection', detail: `${injecte} élément(s) de la sonde interprété(s)` });
    rapport.push({ ecran: nom, largeur: w, defauts });
    if ([360, 1280].includes(w)) await page.screenshot({ path: `${sortie}/${nom}-${w}.png` });
  }
  await page.setViewportSize({ width: 1280, height: 860 });
}

let app = await demarrer(env('soma'), { log: muet });
const contexte = await navigateur.newContext({ viewport: { width: 1280, height: 860 } });
contexte.setDefaultTimeout(12000);
const page = await contexte.newPage();
page.on('console', m => { if (m.type() === 'error') erreurs.push(m.text()); });
page.on('pageerror', e => erreurs.push(String(e)));
const cdp = await contexte.newCDPSession(page);
await cdp.send('WebAuthn.enable');
await cdp.send('WebAuthn.addVirtualAuthenticator', { options: { protocol: 'ctap2', transport: 'internal', hasResidentKey: true, hasUserVerification: true, isUserVerified: true, automaticPresenceSimulation: true } });
const base = () => `http://localhost:${app.serveur.address().port}`;

// Installation : jeton, identifiant, mot de passe, clé d'accès, codes de secours.
await page.goto(base());
await page.getByLabel('Jeton d’installation').fill(JETON);
await page.getByLabel('Identifiant').fill('ana');
await page.getByLabel('Mot de passe').fill(MDP);
await page.getByRole('button', { name: 'Créer le compte' }).click();
await page.getByRole('button', { name: /Créer la clé maintenant/ }).click();
await page.getByText('J’ai rangé ces codes en lieu sûr.').click();
await page.getByRole('button', { name: 'Terminer' }).click();
await passerAssistant(page, { controle });
await page.locator('#app:not(.hidden)').waitFor();
await page.getByRole('heading', { name: 'Arrivée des tickets' }).waitFor();

// Une boîte à tickets, créée et relevée depuis la session du navigateur.
const graine = await page.evaluate(async ([port, sonde]) => {
  const { session } = await (await fetch('/api/compte/etat')).json();
  const h = { 'Content-Type': 'application/json', 'X-CSRF': session.csrf };
  const refus = [];
  const poster = async (url, corps) => { const r = await fetch(url, { method: 'POST', headers: h, body: JSON.stringify(corps) }); if (!r.ok) refus.push(`${url} ${r.status}`); };
  await poster('/api/accounts', {
    name: 'Arrivée', addr: 'alertes@exemple.fr', kind: 'tickets', imapHost: 'localhost', imapPort: port, imapTls: true,
    smtpHost: 'localhost', smtpPort: 465, password: 'mot-de-passe-de-la-boite',
    aliases: [{ addr: 'conteneurs@exemple.fr', svc: 'conteneurs', urg: 'crit' }, { addr: 'rmm@exemple.fr', svc: 'supervision', urg: 'haute' }, { addr: 'proxy@exemple.fr', svc: 'proxy', urg: 'basse', send: false }],
  });
  await poster('/api/folders', { name: 'Archives' });
  await poster('/api/folders', { name: sonde });
  await poster('/api/rules', { name: sonde, conditions: { mode: 'all', items: [{ champ: 'subject', op: 'contient', valeur: 'sonde' }] }, actions: { service: sonde } });
  await poster('/api/rules', { name: 'Certificats en sourdine', conditions: { mode: 'all', items: [{ champ: 'subject', op: 'contient', valeur: 'certificat' }] }, actions: { read: true } });
  await poster('/api/poll', {});
  return refus;
}, [portImap, SONDE]);
if (graine.length) throw new Error('semis refusé : ' + graine.join(', '));

const ECRANS = [
  ['Arrivée', 'Arrivée des tickets', 'arrivee'], ['Tickets', 'Tickets', 'tickets'], ['Courrier', 'Courrier', 'courrier'],
  ['Boîtes', 'Boîtes', 'boites'], ['Journal', 'Journal', 'journal'], ['Réglages', 'Réglages', 'reglages'],
  ['Comptes', 'Comptes', 'comptes'], ['Sécurité', 'Sécurité', 'securite'],
];

for (const gamme of ['soma', 'console', 'exploitation', 'lavande']) {
  // La page quitte le service avant son arrêt : sa relève périodique ne vise
  // pas un serveur éteint (refus de connexion pris pour une erreur de l'écran).
  if (gamme !== 'soma') { await page.goto('about:blank'); await app.arreter(); app = await demarrer(env(gamme), { log: muet }); }
  for (const theme of gamme === 'console' ? ['dark'] : ['light', 'dark']) {
    await page.goto(base());
    await page.evaluate(t => localStorage.setItem('theme', t), theme);
    await page.reload();
    // Après un redémarrage, la session tient (même base) : l'application s'ouvre.
    await page.locator('#app:not(.hidden)').waitFor();
    for (const [bouton, titre, nom] of ECRANS) {
      await page.locator('.side').getByRole('button', { name: new RegExp('^' + bouton) }).click();
      await page.getByRole('heading', { name: titre, exact: true }).first().waitFor();
      await page.waitForTimeout(250);
      await controle(page, `${gamme}-${theme}-${nom}`);
    }
    // Feuilles : une boîte, un ticket, une règle.
    await page.locator('.side').getByRole('button', { name: /^Boîtes/ }).click();
    await page.getByRole('button', { name: 'Modifier' }).first().click();
    await page.locator('#acctScrim.on').waitFor();
    await controle(page, `${gamme}-${theme}-feuille-boite`);
    await page.keyboard.press('Escape');
    await page.locator('.side').getByRole('button', { name: /^Tickets/ }).click();
    await page.getByRole('button', { name: 'Nouveau ticket' }).click();
    await page.locator('#tkScrim.on').waitFor();
    await controle(page, `${gamme}-${theme}-feuille-ticket`);
    await page.keyboard.press('Escape');
  }
}

// Le corps HTML d'un message : mis en forme, sans script ni image.
await page.locator('.side').getByRole('button', { name: /^Arrivée/ }).click();
await page.getByRole('button', { name: /api redémarre en boucle/ }).click();
const corps = await page.locator('#reader .bodyhtml').innerHTML();
if (/<script|<img|onclick/i.test(corps)) erreurs.push(`corps HTML dangereux rendu : ${corps.slice(0, 200)}`);
if (!/<b>vous<\/b>/.test(corps)) erreurs.push(`mise en forme perdue : ${corps.slice(0, 200)}`);

// Ce que les gabarits construisent hors des écrans : menu contextuel, réponse,
// éditeur de règle, chacun rempli et contrôlé à chaque largeur.
await page.locator('#intakeList .mailrow').first().click({ button: 'right' });
if (await page.locator('.menu button').count() < 3) erreurs.push('menu contextuel incomplet');
await page.keyboard.press('Escape');
await page.mouse.click(2, 2);
await page.locator('#reader [data-reply]').click();
await page.locator('#replyScrim.on').waitFor();
if (!(await page.locator('#rFrom option').count())) erreurs.push('aucun expéditeur proposé');
await controle(page, 'feuille-reponse');
await page.keyboard.press('Escape');
await page.locator('.side').getByRole('button', { name: /^Réglages/ }).click();
await page.locator('#rulesList [data-rule]').first().click();
await page.locator('#ruleScrim.on').waitFor();
if (!(await page.locator('#rConds .cond select option[selected]').count())) erreurs.push('condition de règle sans opérateur choisi');
await controle(page, 'feuille-regle');
await page.keyboard.press('Escape');

// Envoyés puis Courrier : la page revient à toutes les boîtes, titre et texte compris.
await page.locator('.side').getByRole('button', { name: /^Envoyés/ }).click();
await page.getByRole('heading', { name: 'Envoyés', exact: true }).first().waitFor();
await page.locator('.side').getByRole('button', { name: /^Courrier/ }).click();
if ((await page.locator('#mailTitle').textContent()) !== 'Courrier') erreurs.push('Courrier reste sur Envoyés');
if (/envoyés/i.test(await page.locator('#mailLede').textContent())) erreurs.push('texte d’Envoyés resté sur Courrier');

const defauts = rapport.filter(r => r.defauts.length);
fs.writeFileSync(`${sortie}/rapport.json`, JSON.stringify({ defauts, erreurs }, null, 2));
console.log(`${rapport.length} contrôles, ${defauts.length} avec défauts, ${erreurs.length} erreur(s) de console`);
for (const d of defauts.slice(0, 30)) console.log(`  ${d.ecran} @${d.largeur} : ${d.defauts.map(x => `${x.type} ${x.detail || ''}`).join(' ; ').slice(0, 300)}`);
for (const e of erreurs.slice(0, 10)) console.log('  console : ' + e.slice(0, 300));
await navigateur.close();
await app.arreter();
imap.close();
process.exit(defauts.length || erreurs.length ? 1 : 0);
