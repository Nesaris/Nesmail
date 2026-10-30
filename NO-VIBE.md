# Code quality record — RAVYN (ex-CACHET)

Method: Project Baseline Requirements & Security Manual, Part III (chapters 37-49)
Reviewed: 2026-10-23   ·   Owner: Codex64

## Behaviour freeze
Point de départ : le commit racine, l’arbre de la 1.0.0 tel qu’il a été fourni (sans le fuseau horaire géographique de l’image, retiré avant toute publication de ce dépôt). Ensemble de référence relevé avant toute correction : les 57 essais de la 1.0 (`test/run.js`, faux serveurs IMAP et SMTP), tous verts, relancés sur un arbre de travail détaché du commit racine le 2026-10-23 : 57 réussis, 0 échoué.

Sur l’arbre final, relancés à la génération de ce fichier : 86 essais du service, tous verts (`test/run.js`), 77 essais du socle embarqué, tous verts (`node --test socle/test/`), empreintes du socle conformes (`sha256sum --check socle/EMPREINTES`). Des 57 essais de la 1.0, 39 sont gardés tels quels ; les 18 autres sont gardés sous un nom qui dit ce qu’ils vérifient désormais, ou passés au socle quand la fonction y est passée :

| Essai de la 1.0 | Devenu | Pourquoi |
|---|---|---|
| TOTP conforme aux vecteurs de la RFC 6238 | `socle/test/crypto.test.js` (mêmes vecteurs) | le TOTP est celui du socle |
| mauvais mot de passe refusé | `socle/test/parcours.test.js` « connexion : mot de passe + TOTP, rejeu refusé » | comptes du socle (C1) |
| connexion et lecture de l’état | premier compte par le jeton d’installation, puis lecture de l’état | comptes du socle (C1) |
| l’API refuse sans session | l’API refuse sans session ; /api/health répond à tous | même vérification, sonde publique ajoutée |
| connexion, login, select, search, fetch | TLS implicite vérifié : login, select, search, fetch | TLS exigé (C3) |
| envoi : en-têtes et corps corrects | envoi STARTTLS : en-têtes et corps corrects | STARTTLS exigé (C3) |
| un refus 550 remonte tel quel | un refus 550 remonte tel quel (relais d’essai en TLS) | même vérification ; le relais en clair de la 1.0 n’est plus joignable |
| le mot de passe est chiffré sur le disque | le mot de passe est scellé dans la base, jamais en clair | base SQLite, coffre du socle |
| les données survivent à un rechargement du store | les données survivent à un redémarrage | base SQLite |
| les deux clés sont générées et lisibles avec une session | une clé d’API se voit une fois, à sa création (renfort) ; seule son empreinte est gardée | C5 |
| aucune clé ne permet de lire les clés | aucune clé ne gère les boîtes, les règles, les réglages ni les clés | portée élargie (C6) |
| la clé complète ouvre l’API sans cookie | la clé complète traite le courrier sans cookie | C6 |
| une mauvaise clé est refusée | une mauvaise clé est refusée et comptée | C4 |
| CORS refusé tant que l’origine n’est pas déclarée, accepté ensuite | CORS : refusé tant que l’origine n’est pas déclarée, jamais « * » ni de cookie | C2 |
| le JS et la CSS portent une empreinte, le favicon est servi | la page porte la version et la gamme, la CSP interdit le script en ligne | C9 |
| l’accusé de réception accepte plusieurs formes | l’accusé de réception accepte plusieurs formes, borné | borne ajoutée |
| règles par l’API, avec essai à blanc | règles par l’API, avec essai à blanc ; expression dangereuse refusée | C8 |
| un préfixe client retombe sur la route équivalente | un préfixe client retombe sur la route équivalente, avec les mêmes droits | droits vérifiés (C6) |

Diff de l’API publique entre la 1.0 et la 2.0 : les routes de données sont les mêmes, avec les mêmes formes de réponse et les mêmes codes, à ces exceptions près, chacune étant le correctif d’un constat (SECURITY.md, « Findings ») :

| Avant | Après | Contrôle |
|---|---|---|
| `POST /api/login`, `POST /api/logout`, `GET /api/session`, un mot de passe unique | comptes, sessions et facteurs du socle sous `/api/compte/…` ; les anciennes routes répondent 404 | REQ-AUTH-001 |
| `GET /api/apikey` rendait les deux clés | rend `{cles: {complete, envoi}, origins}` ; une clé se voit une fois, dans la réponse de `POST /api/apikey/rotate` (renfort) | REQ-CRYPT-006 |
| la clé complète ouvrait boîtes, règles, réglages et webhook | 403 : une personne connectée, administrateur | SEC-AUTHZ-002 |
| CORS « * » et `Access-Control-Allow-Credentials: true` | origines exactes, sans cookie ; « * » refusé (400) | REQ-WEB-004 |
| IMAP et SMTP sans TLS, « accepter un auto-signé » | TLS implicite ou STARTTLS exigé ; certificat vérifié ou épinglé (`imapPin`, `smtpPin`) | REQ-DATA-002 |
| webhook et serveurs vers n’importe quelle adresse, redirections suivies | métadonnées et plages réservées refusées (400), redirections jamais suivies | SEC-CSRF-004 |
| gestes sensibles d’administration sans confirmation | 403 avec `details.renfort` tant que l’identité n’est pas confirmée | REQ-SESS-005 |
| champ inconnu dans un corps ignoré | 400 | REQ-WEB-006 |
| `GET /api/health` (et `ping`, `status`) public, avec l’état | `/api/health` public, `{ok:true}` seulement ; `ping` et `status` demandent une preuve ; `GET /api/summary` ajouté pour les sondes du Hub | SEC-BE-010 |
| 500 avec le message de l’exception | 500 avec un numéro de requête seulement | SEC-API-007 |
| messages envoyés gardés sans limite | même durée de garde que le reste du courrier | REQ-DATA-006 |
| tickets `TCK-0001`… ; message `<boîte>:<uid>` | `TCK-` et six signes tirés ; message `m-` et seize signes tirés ; ceux de la 1.0 gardés | SEC-AUTHZ-006 |
| `GET /api/state` rendait tous les tickets | mille au plus | SEC-API-003 |
| un envoi rejoué partait deux fois | `Idempotency-Key` (en-tête ou champ `idempotencyKey`) : rejoué, `"rejoue": true` | SEC-API-008 |
| EHLO sous le nom de la machine | EHLO sous le domaine de l’expéditeur | REQ-ANON-009 |
| `config.json` et `state.json` dans le volume | `cachet.db` (SQLite) ; les deux fichiers repris une fois, puis renommés | REQ-DATA-001 |

Démarrage et parcours de bout en bout sur l’arbre final : `outils/parcours-navigateur.mjs` (installation par clé d’accès virtuelle, boîte relevée sur un serveur IMAP d’essai, chaque écran dans les quatre gammes, clair et sombre, de 360 à 1920 pixels, feuilles de boîte, de ticket, de réponse et de règle, menu contextuel, sonde d’injection dans chaque champ affiché) → 504 contrôles, 0 défaut, 0 erreur de console.

Suivi 2.0.1 (2026-10-23) : retour d’« Envoyés » à « Courrier », espacement et alignement des cartes. Comportement changé voulu : la page Courrier revient à toutes les boîtes quand on la rouvre depuis la navigation. Le contrôle de mise en page du socle (00b4857) relève maintenant les cartes collées et les rangées désalignées ; parcours navigateur : 504 contrôles, 0 défaut, retour à Courrier vérifié.

## Layer status
| Chapter | Subject | Status | What changed |
|---|---|---|---|
| 39 | Comment layer | DONE | 27 lignes de bannières et de marqueurs de section retirées (19 dans l’interface, 8 dans le serveur) ; les commentaires gardés disent pourquoi (TLS, renforts, reprise, bornes), jamais ce que la ligne suivante fait ; chaque affectation de balisage de l’interface remplacée par les gabarits du socle, la règle écrite une fois en tête de `public/app.js` |
| 40 | Naming and vocabulary | DONE | vocabulaire du domaine, en français comme le socle et la 1.0 : boîte, alias, relève, renfort, empreinte, épingle ; `res`, `val`, `item`, `doPoll` → `reponse`, `envoye`, `bilan`, `valeur`, `corps`, `relever` ; restent `dotStuff` (terme de la RFC 5321) et les identifiants de champs `rService`, `tService` (le service est l’objet du domaine) |
| 41 | Formatting, layout and whitespace | DONE | aucun formateur dans le dépôt, aucun introduit ; 2 espaces, apostrophes simples, points-virgules ; `git diff --check` depuis l’arbre vide : propre ; aucun caractère invisible |
| 42 | Gratuitous abstraction | DONE | aucune interface à une seule implémentation, aucune fabrique ; l’accès aux routes tient en une fonction (`acces`), la portée des machines en une table (`PORTEES`) ; le garde des sorties repris de NEXARC en un module (`lib/reseau.js`) au lieu d’une copie par client ; la connexion TLS des deux protocoles en une (`lib/tls.js`) |
| 43 | Defensive noise | DONE | 40 `catch` dans le code de CACHET, chacun rangé ci-dessous selon ce que fait son bloc ; aucun muet : le seul sans effet (`LOGOUT` IMAP) porte sa raison ; plus aucun 500 qui recopie un message d’exception |
| 44 | Control flow and idiom | DONE | retours anticipés ; boucles indexées réservées au découpage des réponses IMAP et SMTP et à l’analyse des adresses |
| 45 | Types, signatures and data shapes | DONE | JavaScript sans TypeScript ; un contrat d’erreur : `ErreurHttp` du socle pour le client, `ImapError` et `SmtpError` (avec le code du serveur) pour les protocoles, traduits une fois ; schémas de corps déclaratifs, champ inconnu refusé |
| 46 | Dependencies, configuration, fitting the repository | DONE | aucune dépendance npm ; chaque variable de `.env.example` a un lecteur ; code mort retiré ; exports sans lecteur ramenés à leur module ; aucun import inutilisé |
| 47 | Tests | DONE | 22 cassures volontaires, chacune détectée (ci-dessous) ; un essai de la 1.0 perdu pendant la bascule (le refus 550 d’un relais) rétabli ; le parcours navigateur échoue désormais sur un élément de la sonde interprété, et non plus seulement sur une erreur de console |
| 48 | Documentation, furniture and version control | DONE | README réécrit pour la 2.0 (installation par le Hub et seule, reprise d’une 1.0, rotation des clés, idempotence) ; `.gitignore`, `.dockerignore`, `LICENSE`, `Dockerfile`, vérification et publication CI relus ; un sujet par commit, message d’une ligne, sans mention d’outil |

`catch` restants dans le code de CACHET (hors socle, relu dans son propre dépôt), par raison :

| Raison | Nombre | Où |
|---|---|---|
| montrée à l’écran ou rendue au demandeur, avec sa cause | 15 | `public/app.js` (13), `lib/api.js` (2) |
| relevée, traduite en erreur du domaine ou transmise | 10 | `lib/smtp.js`, `lib/imap.js`, `lib/base.js`, `lib/serveur.js`, `lib/cli.js`, `server.js` |
| valeur de repli explicite (donnée illisible, secret sous une autre clé, stockage du navigateur indisponible) | 7 | `lib/base.js`, `lib/rules.js`, `lib/mime.js`, `lib/webhook.js`, `public/app.js` |
| journalisée, ou portée dans l’état (boîte en erreur, dernier appel du webhook) | 7 | `lib/poller.js`, `lib/webhook.js` |
| sans effet voulu, la raison écrite dans le bloc | 1 | `lib/imap.js` (le serveur ferme parfois avant la réponse à LOGOUT) |

## Tests
Cassures volontaires (REQ-CODE-005) : chacune posée seule, la suite du service lancée en entier, le fichier rétabli (`mutations.py`, hors dépôt), sur l’arbre final.

| Cassure | Fichier | Essais en échec | Premier essai qui la voit |
|---|---|---|---|
| une clé ouvre une route de personne connectée | lib/api.js | 6 | aucune clé ne gère les boîtes, les règles, les réglages ni les clés |
| un certificat non reconnu passe sans épinglage | lib/tls.js | 3 | certificat auto-signé non épinglé : refusé, empreinte rendue, rien d'envoyé |
| IMAP : le refus de STARTTLS est ignoré | lib/imap.js | 1 | serveur sans STARTTLS : connexion refusée, aucun mot de passe en clair |
| SMTP : envoi en clair sans STARTTLS | lib/smtp.js | 1 | relais sans STARTTLS : rien ne part, pas même les identifiants |
| une expression à quantificateurs imbriqués est évaluée | lib/rules.js | 2 | une expression à retour arrière exponentiel n'est jamais évaluée |
| le nettoyeur garde les attributs d'un lien | lib/html.js | 1 | le nettoyeur HTML garde la mise en forme et retire le reste |
| changer l'hôte d'une boîte sans renfort | lib/api.js | 5 | où part le mot de passe d'une boîte : renfort exigé, métadonnées et plages réservées refusées |
| le webhook vise les métadonnées | lib/webhook.js | 1 | où part le mot de passe d'une boîte : renfort exigé, métadonnées et plages réservées refusées |
| CORS accepte « * » | lib/api.js | 1 | CORS : refusé tant que l'origine n'est pas déclarée, jamais « * » ni de cookie |
| un mot de passe de boîte gardé en clair | lib/base.js | 20 | le mot de passe est scellé dans la base, jamais en clair |
| une clé fausse ne compte pas comme un échec | lib/api.js | 1 | clés fausses : chaque échec compte pour l'adresse, bloquée après dix, à part des connexions humaines |
| une destination interdite passe en littéral | lib/reseau.js | 5 | où part le mot de passe d'une boîte : renfort exigé, métadonnées et plages réservées refusées |
| une clé d'API créée sans renfort | lib/api.js | 7 | où part le mot de passe d'une boîte : renfort exigé, métadonnées et plages réservées refusées |
| une clé d'API gardée en clair | lib/base.js | 2 | une clé d'API se voit une fois, à sa création (renfort) ; seule son empreinte est gardée |
| un membre gère les boîtes | lib/api.js | 4 | où part le mot de passe d'une boîte : renfort exigé, métadonnées et plages réservées refusées |
| objet d'un message réinjecté par innerHTML dans la lecture | public/app.js | 1 | l'interface ne lit aucune valeur comme du HTML : gabarits du socle seulement |
| nom affiché à chevrons pris pour l'adresse (analyseur de la 1.0) | lib/mime.js | 1 | un nom affiché avec chevrons ou virgule ne prend pas la place de l'adresse |
| numéros de ticket qui se suivent | lib/tickets.js | 1 | numéros de ticket et identifiants de message tirés au hasard, jamais suivis |
| état rendu sans borne sur les tickets | lib/api.js | 1 | l'état rendu à l'interface est borné : mille tickets au plus |
| 429 de la rafale sans en-têtes de sécurité | lib/serveur.js | 1 | une rafale reçoit 429, avec les en-têtes de sécurité |
| envoi rejoué sous la même clé reparti | lib/api.js | 1 | un envoi rejoué sous la même clé ne part qu'une fois |
| code SMTP perdu dans l'erreur | lib/smtp.js | 1 | un refus 550 remonte tel quel |

## Repository style profile
Formateur : aucun ; 2 espaces, apostrophes simples, points-virgules, modules ES. Vocabulaire : français du domaine (boîte, alias, relève, ticket, renfort, épingle), comme la 1.0 et le socle ; anglais seulement pour les champs de l’API de la 1.0 gardés tels quels (`accounts`, `tickets`, `imapHost`…), que les services existants lisent. Erreurs : `ErreurHttp` du socle aux limites HTTP, `ImapError` et `SmtpError` dans les protocoles, formatées une fois par le socle. Modules : `lib/api.js` (routes), `lib/base.js` (persistance et secrets), `lib/poller.js` (relève), un module par protocole et par sortie ; le socle embarqué n’est jamais modifié (empreintes). Aides du socle réutilisées au lieu d’être réécrites : schémas, limiteur, débit, coffre, journal, gabarits, client d’essai, relais SMTP d’essai.

## Detection sweep
Annexe B.5 et contrôles des chapitres 41 à 48, relancés à la génération de ce fichier (`-g '!SECURITY.md' -g '!NO-VIBE.md'`), sur tout le dépôt, socle embarqué compris :

| # | Résultat | Justification |
|---|---|---|
| B.5.1 | 0 lignes |  |
| B.5.2 | 0 lignes |  |
| B.5.3 | 0 lignes |  |
| B.5.4 | 0 lignes |  |
| B.5.5 | 0 lignes |  |
| B.5.6 | 0 lignes |  |
| B.5.7 | 1 | le renard et la flamme d’un essai du socle qui vérifie qu’une phrase de passe en emoji est acceptée |
| B.5.8 | 1 lignes : `./lib/smtp.js:50:function dotStuff(body) {` | `dotStuff` : le « dot-stuffing » de la RFC 5321, nom du protocole |
| B.5.9 | 2 lignes : `rService`, `tService` | identifiants des champs « service » des feuilles de règle et de ticket : le service est l’objet du domaine |
| B.5.10 | 0 lignes |  |
| B.5.11 | 1 lignes : `./socle/test/gamme.test.js:17:  const res = { writeHead() {}, end(b) { corps = String(b ?? ''); } };` | un faux objet réponse dans un essai du socle, relu dans son dépôt |
| B.5.12 | 72 | ceux de CACHET rangés par raison ci-dessus (40 `catch` en tout, promesses comprises) ; les autres dans le socle et les essais |
| B.5.12b | 8 | promesses de la relève, de Telegram et du démarrage : journalisées (tableau ci-dessus) |
| B.5.13 | 0 lignes |  |
| B.5.14 | 0 lignes |  |
| B.5.15 | 0 lignes |  |
| 41.1.1 | 0 lignes |  |
| 41.2.1 | 0 lignes |  |
| 45.1.1 | 0 lignes |  |
| 47.1.1 | 0 lignes |  |
| 48.3.1 | 0 lignes |  |
| 48.3.2 | 32 | attributs `placeholder` des champs de saisie de l’interface |
| 48.3.3 | 0 lignes |  |
| 48.4.1 | 0 lignes |  |

## Verification (chapter 49)
- [x] Full suite passes and matches the baseline : 86 essais du service et 77 du socle verts ; chaque essai de la 1.0 gardé ou remplacé (tableau ci-dessus)
- [x] Public API diff empty : hors des changements voulus listés ci-dessus, chacun étant un correctif
- [x] Characterisation tests deleted after use : aucun essai de caractérisation laissé ; le relevé de la surface et les cassures vivent hors dépôt
- [x] Read-aloud test passed : `lib/`, `server.js` et `public/app.js` relus ligne à ligne, module par module, pendant les deux commits de relecture et cette passe ; chaque nom et chaque commentaire se lit comme une phrase du domaine
- [x] Blind-comparison test passed : chaque module réécrit relu à côté de son équivalent écrit à la main dans NEXARC ou le socle (routes, garde des sorties, persistance, interface) : mêmes formes, même vocabulaire, aucun tic d’écriture relevé par B.5
- [x] Commit history: one concern per commit, repository style, no attribution trailers : `git log --format=%b | rg -c .` → 0, aucune mention d’outil
- [x] REQ-CODE-001 to REQ-CODE-006 all PASS (SECURITY.md)
