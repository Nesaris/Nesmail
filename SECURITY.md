# Security compliance — CACHET

Standard: Project Baseline Requirements & Security Manual, Edition 2.0 (258 controls)
Audited: 2026-10-23   ·   Owner: Codex64   ·   Status: NON-COMPLIANT

## Summary
| Part | Controls | Pass | Fail | N/A | Unknown |
|---|---|---|---|---|---|
| I — Baseline requirements | 68 | 54 | 12 | 2 | 0 |
| II — Security controls | 190 | 93 | 28 | 69 | 0 |
| Total | 258 | 147 | 40 | 71 | 0 |

Chaque FAIL attend une action que seul l’exploitant peut faire (section « Human actions required ») : aucun ne reste ouvert dans le code. Version auditée : 2.0.1, socle commun `00b4857` embarqué.

## Authentication posture
Deux publics. Les opérateurs passent par le socle commun, embarqué avec ses essais : quatre facteurs cumulables sur chaque compte — mot de passe (Argon2id, 64 Mio, 3 passes, parallélisme 4, plancher 19 Mio / 2 / 1, rehachage transparent, liste locale de mots de passe courants, 12 à 1024 caractères), application TOTP (RFC 6238, secret tiré côté serveur et scellé AES-256-GCM, QR code dessiné dans le navigateur, rejeu refusé), clés d’accès WebAuthn (résidentes, vérification de l’utilisateur exigée, jusqu’à vingt, nommées et révocables) et dix codes de secours de 100 bits hachés. Politique : mot de passe et TOTP facultatifs, clé requise pour les administrateurs, qui tiennent deux facteurs dont une clé (deux facteurs sans clé en mode HTTP dégradé, affiché partout). Un mot de passe seul n’ouvre qu’une session d’inscription. Sessions serveur (jeton de 256 bits, empreinte seule en base), renouvelées à chaque changement de niveau, 12 heures au plus et 60 minutes d’inactivité, listées et révocables une à une ou toutes. Renfort de cinq minutes avec le facteur le plus fort avant tout changement de facteur, de rôle ou de politique, avant de créer une boîte ou de changer où part son mot de passe, de la supprimer, de créer une clé d’API, de poser une règle qui supprime ou d’en retirer une, de changer l’adresse du webhook ou le jeton Telegram, et avant une purge. Rôles : lecture (voit tout), membre (traite le courrier et les tickets, envoie), administrateur (boîtes, règles, réglages, clés, webhook, comptes). Les machines présentent une clé d’API de 192 bits, gardée par son empreinte SHA-256 et montrée une fois : la clé complète lit et traite le courrier et les tickets et envoie, la clé d’envoi n’ouvre que `POST /api/send` ; le Hub présente son jeton de service (24 caractères au moins, comparé en temps constant), qui vaut la clé complète, et dérive pour un service voisin un jeton qui ne fait que lire. Aucune preuve de machine n’ouvre les boîtes, les règles, les réglages, les clés ni les comptes. Limiteur persistant par adresse et par compte pour les humains, preuve de travail après trois échecs, paliers de verrouillage ; échecs de clé plafonnés par adresse dans le même limiteur, à part des connexions humaines. La clé maîtresse et le poivre se tournent sans réinscription.

## Findings (audit before fixes)
Relevés en lecture seule sur la 1.0 avant toute correction (« * » : relevés pendant les corrections, la sonde d’injection du parcours navigateur et le sondage), classés par gravité ; chacun est corrigé dans cette passe par le commit indiqué, avec son essai quand un essai peut l’exprimer.

| # | Gravité | Contrôles | Constat | Commits |
|---|---|---|---|---|
| C1 | CRITICAL | REQ-AUTH-001 … -013, REQ-SESS-001 … -006, SEC-AUTH-007, SEC-SESS-004 | Un seul mot de passe pour tout le monde, affiché dans les journaux au premier démarrage ; TOTP facultatif, secret en variable d’environnement, sans rejeu refusé ; sessions signées sans état, impossibles à révoquer ; aucun compte, aucun rôle : qui tenait le mot de passe tenait tout. | d045e21, 54b0c0d, ca30d04 |
| C2 | CRITICAL | REQ-WEB-004, SEC-HDR-006 | CORS : « * » accepté, l’origine reflétée avec `Access-Control-Allow-Credentials: true` : n’importe quel site lisait l’état avec le cookie de l’opérateur. | 54b0c0d |
| C3 | CRITICAL | REQ-DATA-002, SEC-CSRF-004, REQ-WEB-005 | TLS facultatif vers les serveurs de courrier : « sans TLS », « accepter un auto-signé » qui coupait toute vérification, et un client SMTP qui envoyait les identifiants en clair quand le serveur ne proposait pas STARTTLS. | 54b0c0d |
| C4 | HIGH | REQ-AUTH-010, SEC-AUTH-003, SEC-BE-002 | Limiteur de connexion en mémoire, compté sur `X-Forwarded-For` lu chez n’importe quel client : un en-tête par essai le contournait ; aucune limite sur les clés d’API. | 54b0c0d, fe22839 |
| C5 | HIGH | REQ-CRYPT-006, REQ-CFG-002, SEC-API-004 | Clés d’API chiffrées de façon réversible sous `CACHET_SECRET` (dérivé par un simple SHA-256) et relisibles à tout moment par `GET /api/apikey` ; tirées d’office au premier démarrage. | d40d895 |
| C6 | HIGH | REQ-WEB-006, SEC-AUTHZ-002, SEC-AUTHZ-008 | La clé complète ouvrait toutes les routes : boîtes (et où part leur mot de passe), règles, réglages, webhook. | 54b0c0d, 54339d9 |
| C7 | HIGH | SEC-CSRF-004, SEC-CSRF-005, REQ-WEB-005 | Webhook et serveurs de courrier joints à n’importe quelle adresse (métadonnées de nuage, plages réservées), webhook qui suivait les redirections, clé comprise. | 3bbc79b, 54339d9 |
| C8 | HIGH | REQ-WEB-007, SEC-INJ-006, REQ-WEB-008 | Un retour à la ligne dans le dossier d’une boîte fabriquait une seconde commande IMAP ; une règle en expression régulière pouvait bloquer la relève (retour arrière exponentiel). | 54b0c0d |
| C9 | HIGH | REQ-WEB-002, SEC-XSS-001, SEC-XSS-002, SEC-XSS-004 | Aucune politique de contenu ; le HTML d’un message injecté par innerHTML derrière une seule barrière, celle du serveur ; styles et gestionnaires en ligne. | ca30d04 |
| C10 | MEDIUM | SEC-API-007, SEC-XSS-006 | Une erreur 500 rendait le message de l’exception au client. | 54b0c0d |
| C11 | MEDIUM | REQ-ANON-009 | Le client SMTP s’annonçait (EHLO) sous le nom de la machine qui l’héberge. | 54b0c0d |
| C12 | MEDIUM | REQ-DATA-006, SEC-PRIV-001 | Les messages envoyés étaient gardés sans limite. | 32c6a10 |
| C13 | MEDIUM | REQ-DATA-003 | Aucune sauvegarde. | c7fa0a2 |
| C14 | MEDIUM | SEC-PRIV-001, SEC-PRIV-003 | Aucune notice de confidentialité. | a026eda |
| C15 | MEDIUM | REQ-CI-001 … -005 | Aucune vérification automatique : ni essais, ni secrets, ni analyse, ni crible de l’image. | e9841a4, dbbd34f, 893aa74 |
| C16 | LOW | REQ-ANON-002 | L’image fixait un fuseau horaire géographique (Dockerfile, Compose, exemple d’environnement) : retiré du commit de départ lui-même, avant toute publication de ce dépôt. | 4b18f79 |
| C17 | LOW | SEC-AUTHZ-006 | Numéros de ticket qui se suivent (`TCK-0001`…), identifiant d’un message tiré de son UID IMAP. | 6b62707, 40637f6 |
| C18 | MEDIUM | SEC-XSS-001, REQ-WEB-007 | * Relevé pendant la passe : l’interface 2.0 gardait une trentaine d’affectations d’innerHTML, sans justification chacune, dont seize qui inséraient des identifiants sans les échapper (venus du serveur, jamais d’un message, mais sans garantie écrite). | cf18ecd, fcc7ffc, c5835ae |
| C19 | MEDIUM | SEC-API-008, SEC-PAY-006 | * Un envoi rejoué (nouvel essai après un délai, double clic) partait deux fois. | 53c23dd |
| C20 | LOW | SEC-API-003 | * `GET /api/state` rendait tous les tickets. | e068577 |
| C21 | LOW | SEC-BE-001 | * Régression de la 2.0 relevée pendant la passe : le refus de débit (429) partait avant les en-têtes de sécurité. | 59d5ee9 |
| C22 | LOW | REQ-WEB-006 | * Un nom affiché entre guillemets contenant des chevrons ou une virgule prenait la place de l’adresse de l’expéditeur. | 75906b7 |

Suivi du 2026-10-23 (2.0.1), sur retour d’usage : revenir d’« Envoyés » à « Courrier » gardait la vue des envoyés (titre, texte et liste) ; la carte des alias collait aux colonnes de tickets (une règle d’espacement de CACHET l’annulait) ; colonnes de tickets, liste et lecture du courrier, cartes des réglages et pages de compte du socle ne partaient pas ou ne finissaient pas à la même hauteur. Corrigé (c75e3e1, 4cdc2eb, 6273878) ; le contrôle de mise en page du socle relève désormais les cartes collées et les rangées désalignées, et le parcours navigateur vérifie le retour à « Courrier ». Aucun contrôle ne change de statut.

Suivi du 2026-10-25 (2.0.2) : mise en page dans les quatre gammes — des écarts entre cartes codés en dur (14, 16 et 22 px) qui différaient de l’écart du socle sur petit écran et en Console, un grand blanc sous le message des colonnes vides du tableau des tickets, et des chiffres à chasse fixe imposés à tout encadré `.note` qui espaçaient la ponctuation des avis du socle (page Sécurité). Socle 6f2c864 embarqué : un seul écart entre cartes (`--ecart`, 16 px, 12 px en Console et sur petit écran), notes d’en-tête de carte de même hauteur, cartes des pages Comptes et Sécurité l’une sous l’autre, et un contrôle de mise en page qui relève tout écart différent et toute colonne inégale. CACHET prend cet écart pour ses chiffres, ses colonnes, le tableau des tickets et les cartes de chaque page, pages de compte et de sécurité comprises (`public/app.css`) ; une colonne vide du tableau garde son message au milieu de sa hauteur ; les chiffres à chasse fixe se limitent aux notes d’en-tête de carte. Le parcours du navigateur quitte la page avant chaque redémarrage de gamme : sa relève périodique ne vise plus un serveur arrêté. `npm test` lance les fichiers d’essai du socle (Node 24 ne prend pas un dossier). Interface seulement : aucune route, aucun contrôle ne change de statut. Essais : 86 du service, 77 du socle ; parcours du navigateur dans les quatre gammes : SOMA 140 écrans × largeurs, Console 70, Exploitation 140, Lavande 154 (feuilles de réponse et de règle comprises), soit 504 contrôles, 0 défaut, 0 erreur de console.
## Control status
| ID | Severity | Status | Evidence | Notes |
|---|---|---|---|---|
| REQ-AUTH-001 | CRITICAL | PASS | `socle/src/comptes.js:25` ; mot de passe, TOTP, clés et codes de secours cumulables : essai `socle/test/parcours.test.js` rejoué par `npm test` (`package.json:9`) | socle embarqué, ses essais rejoués par la vérification (`.github/workflows/verification.yml`, étape « Essais du socle embarqué ») ; QR code du TOTP dessiné dans le navigateur |
| REQ-AUTH-002 | CRITICAL | PASS | `socle/src/comptes.js:28` ; `socle/src/index.js:49` ; réglable sans déploiement : `socle/src/portail.js:476` | défaut : mot de passe et TOTP facultatifs, clé requise pour les administrateurs |
| REQ-AUTH-003 | CRITICAL | PASS | `socle/src/webauthn.js:26` ; vingt clés nommées : `socle/src/comptes.js:39` | liste avec dates de création et d’usage dans la page Sécurité de CACHET (`public/app.js:139`) |
| REQ-AUTH-004 | CRITICAL | PASS | `socle/src/webauthn.js:46` ; origine `socle/src/webauthn.js:47` ; rpIdHash `socle/src/webauthn.js:103` | défi à usage unique lié à la session, UP et UV exigés, signature et compteur vérifiés |
| REQ-AUTH-005 | CRITICAL | PASS | `socle/src/comptes.js:732` ; renfort et fermeture des autres sessions : `socle/src/comptes.js:748` | la notification part à l’adresse vérifiée quand un relais existe (voir REQ-AUTH-014) |
| REQ-AUTH-006 | CRITICAL | PASS | `socle/src/comptes.js:993` ; jeton de 20 minutes, haché, unique : `socle/src/comptes.js:37` | essai `socle/test/parcours.test.js` ; depuis le Hub : « Comptes des services » (`hub.json:805`) |
| REQ-AUTH-007 | HIGH | PASS | `socle/src/comptes.js:40` ; 100 bits, haché Argon2id, usage unique : `socle/src/comptes.js:532` | alerte « secours.utilise » (courriel si relais, voir REQ-AUTH-014) ; la 1.0 n’avait ni codes de secours ni comptes |
| REQ-AUTH-008 | HIGH | PASS | `socle/src/totp.js:35` ; rejeu refusé : `socle/src/comptes.js:624` | RFC 6238, 6 chiffres, 30 s, ±1 pas, secret scellé AES-256-GCM ; le TOTP maison de la 1.0 (secret en variable d’environnement, sans rejeu refusé) a disparu avec `lib/auth.js` |
| REQ-AUTH-009 | CRITICAL | PASS | aucune voie SMS ni code par courriel : `rg -n -i 'sms\|twilio' lib socle/src` → 0 ; connexions possibles : `socle/src/comptes.js:465`, `socle/src/comptes.js:491`, `socle/src/comptes.js:513`, `socle/src/comptes.js:578` | un mot de passe seul n’ouvre qu’une session d’inscription ; une clé d’API ou le jeton du Hub n’ouvrent jamais de session humaine (`lib/api.js:153`) |
| REQ-AUTH-010 | CRITICAL | PASS | humains : `socle/src/limiteur.js:20` (SQLite, par adresse et par compte, paliers de verrou, preuve de travail après trois échecs) ; clés d’API, jeton du Hub et jetons dérivés : chaque échec compte pour l’adresse dans le même limiteur persistant, sous une clé à part (`lib/api.js:118`, `lib/api.js:133`) : dix échecs bloquent une minute, puis par paliers jusqu’à une heure | essai `test/run.js:730` (dix 401 puis 429, sessions humaines intactes) ; ces secrets de machine (192 à 256 bits) n’ont ni compte à verrouiller ni navigateur pour une preuve de travail : le verrou de l’adresse en tient lieu ; la 1.0 n’avait qu’un compteur en mémoire, lu sur `X-Forwarded-For` |
| REQ-AUTH-011 | HIGH | PASS | vérification leurre : `socle/src/argon.js:110` ; message unique | essai `socle/test/parcours.test.js` |
| REQ-AUTH-012 | HIGH | PASS | `socle/src/comptes.js:1032` : l’adresse n’existe que dans le jeton haché tant qu’elle n’est pas vérifiée ; `socle/src/comptes.js:1041` | l’adresse ne sert qu’aux alertes : ni identifiant, ni récupération, ni droit ; pas d’inscription libre (invitation seulement) |
| REQ-AUTH-013 | HIGH | PASS | `socle/src/comptes.js:831` ; facteurs manquants exigés à l’inscription : `socle/src/comptes.js:178` | le premier compte, créé par le jeton d’installation ou depuis le Hub, doit inscrire une clé d’accès avant tout accès complet (parcours navigateur, `outils/parcours-navigateur.mjs`) |
| REQ-AUTH-014 | MEDIUM | FAIL | `socle/src/notifications.js:97` ; « ce n’était pas moi » : `socle/src/comptes.js:1019` | implémenté et essayé (`socle/test/courriel.test.js`) ; ne part que si un relais SMTP est configuré (`SOCLE_SMTP_*`, `deploy/compose.hub.yml:50`) → action H2 |
| REQ-CRYPT-001 | CRITICAL | PASS | `socle/src/argon.js:15` ; 64 Mio, t=3, p=4 par défaut : `socle/src/index.js:42` | Argon2id natif de Node 24, sel de 16 octets par empreinte ; le scrypt maison de la 1.0 (N=16384) a disparu avec son mot de passe unique |
| REQ-CRYPT-002 | HIGH | PASS | `socle/src/argon.js:72` ; écrit dans la même requête : `socle/src/argon.js:129` | la 1.0 n’avait qu’un mot de passe, non repris : aucun ancien hachage à réécrire |
| REQ-CRYPT-003 | MEDIUM | N/A | bcrypt absent : `rg -n -i bcrypt lib socle/src` → 0 ; Argon2id seul |  |
| REQ-CRYPT-004 | HIGH | PASS | `socle/src/motdepasse.js:12`, `socle/src/motdepasse.js:13`, liste de fuites locale `socle/src/motdepasse.js:18` (`socle/data/mots-de-passe-courants.txt.gz`) | contrôlé côté serveur, sans règle de composition ni rotation forcée ; la 1.0 acceptait 8 caractères (`passwd.sh`, retiré) |
| REQ-CRYPT-005 | HIGH | PASS | `socle/src/outils.js:16` ; clés d’API de 192 bits : `lib/base.js:94` ; Message-ID tiré au hasard : `lib/smtp.js:61` ; clés et jeton du Hub comparés en temps constant : `lib/base.js:104`, `lib/api.js:124` ; `rg -n 'Math\.random\|uuidv1' lib public socle/src` → 0 | le Message-ID de la 1.0 et les identifiants des maquettes d’essai venaient de `Math.random` |
| REQ-CRYPT-006 | MEDIUM | PASS | clés d’API gardées par leur empreinte SHA-256, montrées une fois : `lib/base.js:50`, `lib/base.js:93` ; clés de la 1.0 reprises sous leur empreinte : `lib/base.js:175` ; jetons de réinitialisation, d’invitation et codes de secours du socle : `socle/src/comptes.js:967` | essai `test/run.js:562` (la base relue octet par octet : aucune clé en clair) ; la 1.0 gardait ses clés chiffrées et les rendait à toute session |
| REQ-SESS-001 | CRITICAL | PASS | `socle/src/http.js:105` ; __Host- en HTTPS : `socle/src/portail.js:51` | aucune session dans le stockage du navigateur (`rg -n localStorage public/app.js` → le thème seulement) ; la 1.0 posait un cookie signé sans préfixe d’hôte et sans état serveur |
| REQ-SESS-002 | CRITICAL | PASS | `socle/src/comptes.js:304` à la connexion, au renfort et à chaque changement de facteur ou de rôle | pas de jeton de rafraîchissement : sessions serveur |
| REQ-SESS-003 | HIGH | PASS | `socle/src/comptes.js:343` ; révocation : `socle/src/portail.js:326` et incident : `socle/src/portail.js:489` | appareil, adresse IP, première et dernière vue, dans la page Sécurité de CACHET |
| REQ-SESS-004 | HIGH | PASS | `socle/src/comptes.js:750` ; déconnexion serveur : `socle/src/portail.js:276` | la déconnexion de CACHET appelle le socle (`public/app.js:130`) ; la 1.0 effaçait seulement le cookie, encore valable 12 h |
| REQ-SESS-005 | HIGH | PASS | `socle/src/comptes.js:427` ; routes de CACHET sous renfort : boîte ajoutée ou supprimée, destination de son mot de passe changée (`lib/api.js:268`), clé d’API créée (`lib/api.js:736`), adresse et secrets du webhook, jeton Telegram, origines (`lib/api.js:690`), règle qui supprime et retrait d’une règle (`lib/api.js:361`), purge (`lib/api.js:503`) | essais `test/run.js:375` et `test/run.js:562` |
| REQ-SESS-006 | MEDIUM | PASS | 12 h absolues, 60 min d’inactivité : `socle/src/index.js:40` | pas de JWT |
| REQ-ANON-001 | CRITICAL | PASS | `git log --all --format='%an <%ae>' \| sort -u` et `--format='%cn <%ce>'` → une ligne chacun, le pseudonyme, sur les 44 commits de ce dépôt | commits en UTC, sous l’identité du projet ; aucune branche d’un service tiers |
| REQ-ANON-002 | CRITICAL | PASS | tout l’historique (44 commits, arbres, messages, identités) : 0 terme de la liste d’anonymat en mot entier (annexe B.1.14 ; en sous-chaîne, un seul mot du vocabulaire WebAuthn du socle) ; motifs de l’annexe B.1 : 2 lignes génériques justifiées (B.1.8) ; aucun chemin de poste (B.1.12) ; le fuseau horaire géographique que la 1.0 fixait dans l’image, le Compose et l’exemple d’environnement est retiré jusque dans le commit de départ (`Dockerfile:20`) | ce dépôt n’a jamais été publié ; un éventuel dépôt d’origine de la 1.0, hors de celui-ci, ne doit pas l’être → H12 |
| REQ-ANON-003 | CRITICAL | FAIL | contrôle CI par secret : `.github/workflows/verification.yml:103` | liste et crochet global à poser sur le poste de développement, secret à poser sur GitHub → action H4 |
| REQ-ANON-004 | CRITICAL | PASS | `git log --all --format=%B \| grep -niE 'co-authored-by\|generated (by\|with)\|assistant\|claude\|copilot\|cursor\|gpt\|🤖'` → 0 sur tout l’historique | contrôlé en CI sur chaque nouveau commit : `.github/workflows/verification.yml:92` |
| REQ-ANON-005 | HIGH | PASS | `package.json:12` ; `LICENSE:3` ; contact de sécurité : le signalement privé du dépôt (`lib/serveur.js:22`) | le README décrit le logiciel, jamais une machine ni une personne |
| REQ-ANON-006 | HIGH | PASS | images de l’historique : `public/favicon.ico`, `public/favicon.png`, `public/logo.png`, `public/mark.png` ; leurs blocs de métadonnées PNG (`tEXt`, `iTXt`, `zTXt`, `eXIf`) relus → aucun ; aucun PDF ni vidéo | polices WOFF2 du socle : métadonnées de la fonderie seulement ; captures du parcours gardées hors dépôt |
| REQ-ANON-007 | HIGH | PASS | comptes « ana », « lea », « max » ; boîtes et alias en `exemple.fr` ; adresses de la plage de documentation (`hub.json`, placeholder 192.0.2.30) ; jetons d’essai fabriqués (`test/run.js:320`) ; certificats tirés à la volée par openssl (`test/run.js:34`) | essais, outils et exemples relus ; les plages privées n’apparaissent que dans le classement des adresses, assemblées à l’exécution (`lib/reseau.js:19`) |
| REQ-ANON-008 | MEDIUM | PASS | `git log --all --format=%aI \| grep -v '+00:00$' \| wc -l` → 0 ; `git log --all --format=%cI \| grep -v '+00:00$' \| wc -l` → 0 | auteur et validateur en UTC sur tout l’historique |
| REQ-ANON-009 | MEDIUM | FAIL | pages d’erreur sans chemin ni pile : `socle/src/http.js:171` ; domaine et WHOIS hors dépôt | action H13 |
| REQ-ANON-010 | MEDIUM | PASS | identité stable et unique, dates réelles (TZ=UTC, jamais antidatées) | aucune politique de contribution externe |
| REQ-CFG-001 | CRITICAL | PASS | gitleaks sur tout l’historique et sur l’arbre → aucune fuite (annexe B.2) ; `-----BEGIN … PRIVATE` → 0 | valeurs d’essai fabriquées seulement |
| REQ-CFG-002 | CRITICAL | PASS | mots de passe des boîtes, secrets du webhook et jeton Telegram jamais rendus : `lib/api.js:102`, `lib/api.js:172` ; aucune construction : `public/` est servi tel quel | essai `test/run.js:346` ; sondage P33 |
| REQ-CFG-003 | HIGH | FAIL | VM d’essai et production distinctes (règle de l’exploitant) | clés et comptes séparés par environnement à émettre → action H6 |
| REQ-CFG-004 | HIGH | PASS | `lib/config.js:8` sur `socle/src/config.js:14` : jeton du Hub de 24 caractères au moins et jamais une valeur d’exemple (`lib/config.js:16`), envois par minute bornés (`lib/config.js:23`) ; plus de repli sur un secret par défaut : la 1.0 s’arrêtait sans CACHET_SECRET mais générait et affichait un mot de passe d’amorçage | aucun mode de débogage ni contournement par variable ; `CACHET_INSECURE_COOKIE` a disparu |
| REQ-CFG-005 | HIGH | PASS | chaque secret, son lieu et sa rotation : section « Secrets inventory » ; clé maîtresse tournée sans perte (`lib/serveur.js:37`) ; clés d’API régénérées d’un geste (`lib/api.js:736`) | essai `test/run.js:609` ; clés chez les fournisseurs : actions H5, H6 |
| REQ-CI-001 | CRITICAL | FAIL | `.github/workflows/verification.yml:62` (gitleaks sur tout l’historique) | Actions, crochet local et protection de poussée à activer → actions H3, H4 |
| REQ-CI-002 | HIGH | FAIL | CodeQL, requêtes « security-extended » : `.github/workflows/verification.yml:129` | bloquant une fois les Actions actives et le contrôle requis → action H3 |
| REQ-CI-003 | HIGH | FAIL | aucune dépendance npm (`package.json` sans dépendances) ; image de base épinglée par empreinte `Dockerfile:6` ; crible de l’image en CI `.github/workflows/verification.yml:54` ; mises à jour proposées, jamais appliquées seules (`.github/dependabot.yml:9`) | le dépôt est prêt ; l’exécution en CI, les alertes Dependabot et le contrôle requis dépendent de GitHub → action H3 |
| REQ-CI-004 | HIGH | FAIL | `.github/workflows/verification.yml:107` | échoue tant que le secret n’existe pas → action H4 |
| REQ-CI-005 | MEDIUM | FAIL | permissions minimales `.github/workflows/verification.yml:15` ; actions épinglées par commit | protection de branche → action H3 |
| REQ-CI-006 | MEDIUM | PASS | `test/run.js:543` (sans preuve → 401, lecture sur écriture → 403, membre sur route d’administration → 403, une seule route publique) ; portées des clés : `test/run.js:582`, `test/run.js:588`, `test/run.js:595` | cassures volontaires : NO-VIBE.md, « Tests » |
| REQ-WEB-001 | CRITICAL | FAIL | HSTS dès que la requête est chiffrée : `socle/src/http.js:88` | CACHET est servi en HTTP sur le réseau local tant qu’aucun relais TLS n’est posé → action H1 |
| REQ-WEB-002 | HIGH | PASS | chaque page : `lib/serveur.js:54` sur `socle/src/http.js:62` (script-src 'self' et un nonce par requête, style-src 'self', object-src 'none', base-uri 'none', frame-ancestors 'none', aucun unsafe-inline ni unsafe-eval) ; plus aucun style ni script en ligne dans l’interface, plus de police chargée ailleurs | essai `test/run.js:703` ; parcours navigateur : 504 contrôles (écrans, feuilles, menu, largeurs, gammes), 0 erreur de console (une violation de CSP en serait une) ; la 1.0 n’envoyait aucune CSP et chargeait Google Fonts |
| REQ-WEB-003 | HIGH | PASS | `socle/src/http.js:79` : nosniff, no-referrer, DENY, COOP, CORP, Permissions-Policy ; no-store sur l’API et la page (`lib/serveur.js:67`) ; ni Server ni X-Powered-By (annexe B.4) | HSTS dès HTTPS (H1) |
| REQ-WEB-004 | HIGH | PASS | CORS réglé par l’administrateur sous renfort, origine exacte seulement, jamais « * » ni de cookie : `lib/api.js:756`, `lib/api.js:697` | essai `test/run.js:615` ; sondage P24, P25 ; la 1.0 acceptait « * » avec `Access-Control-Allow-Credentials: true` |
| REQ-WEB-005 | HIGH | PASS | CSRF : `socle/src/portail.js:98` (SameSite=Strict, origine et jeton) sur chaque route de session ; JSON exigé : `socle/src/http.js:122` ; aucun GET n’écrit ; SSRF : serveurs de courrier et webhook déclarés par un administrateur sous renfort, métadonnées, lien local et plages réservées refusés en littéral (`lib/api.js:225`) comme à la résolution (`lib/reseau.js:53`, passé à chaque connexion : `lib/tls.js:42`, `lib/webhook.js:28`) ; redirection du webhook jamais suivie | essais `test/run.js:341`, `test/run.js:375`, `test/run.js:647` ; aucune redirection pilotée par paramètre |
| REQ-WEB-006 | CRITICAL | PASS | corps : schéma strict, champ inconnu refusé (`socle/src/schema.js:69`) avec un schéma par route (`lib/api.js:33`) ; identifiants du chemin au motif fixe (`lib/api.js:28`) ; paramètres de requête lus un à un, typés et bornés (`lib/api.js:186`) ; adresses, hôtes, dossiers IMAP, identifiants de message, jeton Telegram et expressions au motif fixe ; rôle vérifié dans chaque gestionnaire (`lib/api.js:141`) ; erreurs génériques (`socle/src/http.js:171`) | essais `test/run.js:363`, `test/run.js:543` ; paramètres non déclarés ignorés, jamais lus (contrat de la 1.0 avec ses clients) ; sondage exploratoire ci-dessous |
| REQ-WEB-007 | HIGH | PASS | aucune requête SQL faite de texte : deux requêtes préparées pour les documents (`lib/base.js:64`) ; aucun processus lancé (`rg -n 'child_process\|execFile\|spawn' lib` → 0) ; IMAP : aucune valeur sur plusieurs lignes n’entre dans une commande (`lib/imap.js:15`, `lib/imap.js:96`), chaînes entre guillemets échappées ; SMTP : adresses et Message-ID au motif fixe, tout en-tête non imprimable encodé (`lib/smtp.js:55`) ; corps HTML d’un message reconstruit sur liste blanche côté serveur (`lib/html.js:29`) puis dans un document inerte côté navigateur (`public/app.js:389`) ; interface : aucune API d’injection de HTML, tout balisage par les gabarits du socle, chaque valeur en nœud texte ou attribut (`public/app.js:10`, justifié en commentaire juste au-dessus) | essais `test/run.js:168`, `test/run.js:275`, `test/run.js:86`, `test/run.js:717` ; sonde d’injection dans chaque écran du parcours navigateur ; eval et Function absents |
| REQ-WEB-008 | MEDIUM | PASS | débit global par adresse `lib/serveur.js:47` ; envois plafonnés par minute (`lib/api.js:616`) ; corps bornés à 64 Kio (256 Kio pour un envoi) ; listes bornées : 500 messages, 1000 tickets, 2000 messages gardés, 50 boîtes, 200 règles, 200 dossiers, 500 accusés par appel ; relève : 50 messages de 256 Kio au plus, réponse IMAP de 32 Mio au plus (`lib/imap.js:12`) ; expressions de règle bornées, texte examiné borné (`lib/rules.js:8`) | essai `test/run.js:249` ; aucun appel à une IA |
| REQ-DATA-001 | CRITICAL | PASS | SQLite embarqué, aucun port : `lib/base.js:41` ; dossier en 0700 et base en 0600 : `lib/base.js:35` |  |
| REQ-DATA-002 | HIGH | FAIL | mots de passe des boîtes, secrets du webhook et de Telegram, secrets TOTP scellés AES-256-GCM, sous-clé par usage, liés à leur propriétaire : `lib/base.js:79` ; IMAP et SMTP toujours en TLS 1.2 au moins, certificat vérifié ou épinglé (`lib/tls.js:42`) | restent le chiffrement du disque des hôtes et HTTPS vers CACHET lui-même → actions H7, H1 ; la 1.0 acceptait IMAP en clair et « accepter un auto-signé » |
| REQ-DATA-003 | HIGH | FAIL | sauvegarde chiffrée pour une clé publique RSA : `lib/cli.js:48` ; restauration ailleurs avec la clé privée seule : `lib/cli.js:22` | planification quotidienne, copie hors hôte, trente jours de garde et restauration datée → action H8 ; clé maîtresse hors ligne → H16 |
| REQ-DATA-004 | HIGH | PASS | socle : connexions, facteurs, rôles, refus (`socle/src/portail.js:110`), verrous ; CACHET : refus de clé et de portée (`lib/api.js:134`, `lib/api.js:145`), boîtes ajoutées, modifiées, supprimées, règles, dossiers, réglages, clés créées, messages et tickets supprimés, purges, rattrapages, envois, certificats épinglés, reprise de la 1.0, sauvegardes ; jamais un secret : `socle/src/journal.js:10` | essai `test/run.js:750` |
| REQ-DATA-005 | MEDIUM | PASS | vigie : `socle/src/vigie.js:11` (connexions, refus, limites, erreurs internes), clés refusées comprises ; runbook d’une page ci-dessous | alertes hors de l’application par courriel → action H2 ; restauration exercée → H8 |
| REQ-DATA-006 | MEDIUM | PASS | `public/confidentialite.txt:28` ; rétention réglée appliquée à tout le courrier, envoyés compris (`lib/poller.js:233`), 2000 messages au plus, tickets traités purgés ; export et effacement du compte par le socle | la 1.0 gardait les messages envoyés sans limite |
| REQ-DATA-007 | MEDIUM | N/A | aucun envoi de fichier ni import depuis une adresse : corps JSON seulement (`socle/src/http.js:122`), pièces jointes des messages ignorées ; `rg -n -i 'multipart/form\|busboy\|formidable' lib socle/src` → 0 |  |
| REQ-CODE-001 | HIGH | PASS | ensemble de référence relevé avant la passe (57 essais de la 1.0 au commit de départ) ; surface publique gardée : mêmes routes de données, mêmes formes de réponse, mêmes codes, sauf les changements voulus listés dans NO-VIBE.md | voir NO-VIBE.md |
| REQ-CODE-002 | HIGH | PASS | voir NO-VIBE.md, couche des commentaires |  |
| REQ-CODE-003 | HIGH | PASS | voir NO-VIBE.md, couches structurelle et défensive |  |
| REQ-CODE-004 | HIGH | PASS | voir NO-VIBE.md, profil de style du dépôt |  |
| REQ-CODE-005 | MEDIUM | PASS | cassures volontaires, chacune détectée par au moins un essai : NO-VIBE.md, « Tests » |  |
| REQ-CODE-006 | MEDIUM | PASS | un sujet par commit, message d’une seule ligne dans le style du dépôt : `git log --format=%b \| grep -c .` → 0 ; aucune mention d’outil (REQ-ANON-004) ; en UTC | la bascule sur le socle tient en deux commits (serveur, interface) : elle ne se découpe pas sans laisser des états qui ne démarrent pas ; les suites (sorties gardées, renforts, clés par empreinte, relecture) ont chacune le leur |
| GOV-001 | HIGH | PASS | ce document : revue datée, périmètre (258 contrôles), résolution ligne par ligne, deux passes complètes | à refaire à chaque changement important |
| GOV-002 | MEDIUM | PASS | section « Inventory » ci-dessous : routes, données, tiers, secrets |  |
| GOV-003 | LOW | FAIL | `socle/src/portail.js:151` (`/.well-known/security.txt`) ; contact : `lib/serveur.js:22` | activer le signalement privé sur le dépôt → action H3 |
| GOV-004 | MEDIUM | FAIL | VM d’essai distincte de la production (règle de l’exploitant) ; données d’essai fabriquées | secrets et comptes tiers distincts à confirmer → action H6 |
| GOV-005 | HIGH | FAIL | jeton CI éphémère, lecture seule, sans identifiants persistés (`.github/workflows/verification.yml:24`) | 2FA sur GitHub, chez le fournisseur de courriel et sur Telegram → action H3 |
| SEC-SECRETS-001 | CRITICAL | PASS | gitleaks sur tout l’historique et sur l’arbre → aucune fuite (annexe B.2) ; `git grep -nIE '-----BEGIN [A-Z ]*PRIVATE\|sk_live\|ghp_[A-Za-z0-9]{30}'` → 0 | gitleaks en CI : `.github/workflows/verification.yml:69` (actif avec les Actions : H3) |
| SEC-SECRETS-002 | CRITICAL | PASS | aucune construction ni variable publique : `public/` et `socle/web` servis tels quels ; `rg -n 'sk_live\|service_role\|-----BEGIN\|CACHET_HUB_TOKEN\|SOCLE_CLE' public socle/web` → 0 | seuls la version, le nonce CSP et la gamme sont posés dans la page : `lib/serveur.js:66` |
| SEC-SECRETS-003 | CRITICAL | PASS | `.gitignore:9` ; seuls `public/` et `socle/web` sont servis, chemin normalisé et segments cachés refusés : `socle/src/http.js:205` ; `/.env` et `/.git/config` demandés à l’instance d’essai → 404 (annexe B.4) | secrets vides dans `.env.example:19` |
| SEC-SECRETS-004 | HIGH | PASS | installé par le Hub : clé maîtresse, jeton de service et jeton des comptes tirés et gardés par son coffre, posés à l’installation (`deploy/compose.hub.yml:38`) ; installé seul : secret Docker hors du volume (`docker-compose.yml:20`) lu par fichier (`socle/src/config.js:5`) | aucun secret dans la CI, l’image ni le dépôt |
| SEC-SECRETS-005 | HIGH | FAIL | un secret par usage : clé maîtresse (sous-clé par usage), jeton du Hub, jeton des comptes, clé d’API complète, clé d’envoi, clé et secret du webhook | secrets distincts par environnement (VM d’essai, production) et mots de passe d’application des boîtes restreints chez chaque fournisseur → action H6 |
| SEC-SECRETS-006 | HIGH | FAIL | procédures de rotation ci-dessous ; clé maîtresse tournée sans perte (`lib/serveur.js:37`) ; clés d’API régénérées d’un geste, l’ancienne cesse aussitôt (`test/run.js:609`) | CACHET_SECRET de la 1.0, ses clés d’API gardées en clair et les mots de passe des boîtes qu’elle a pu envoyer sans TLS sont à brûler → action H5 |
| SEC-SECRETS-007 | HIGH | PASS | clé maîtresse de 32 octets aléatoires : `socle/src/chiffre.js:24` ; clés d’API de 192 bits tirées par le serveur (`lib/base.js:94`) ; jeton du Hub de 24 caractères au moins (`lib/config.js:16`) ; valeurs d’exemple refusées : `socle/src/config.js:54` | jetons de session, d’installation et de réinitialisation tirés par le socle (voir REQ-CRYPT-005) |
| SEC-SECRETS-008 | MEDIUM | PASS | `lib/config.js:8` : une valeur invalide arrête le démarrage avec la liste des erreurs ; aucun mode de débogage ; mode HTTP dégradé affiché en permanence : `socle/web/compte.js:769` |  |
| SEC-AUTH-001 | CRITICAL | PASS | voir REQ-CRYPT-001 |  |
| SEC-AUTH-002 | MEDIUM | PASS | voir REQ-CRYPT-004 |  |
| SEC-AUTH-003 | CRITICAL | PASS | voir REQ-AUTH-010 : humains par adresse et par compte, clés d’API et jetons du Hub par adresse, dans le même limiteur persistant |  |
| SEC-AUTH-004 | MEDIUM | PASS | voir REQ-AUTH-011 |  |
| SEC-AUTH-005 | CRITICAL | PASS | voir REQ-AUTH-006 ; lien bâti sur l’adresse publique : `socle/src/portail.js:56` | sans adresse publique, l’origine attestée par le navigateur de l’administrateur, contrôlée sur la même requête |
| SEC-AUTH-006 | MEDIUM | PASS | confirmation sur la nouvelle adresse et avis à l’ancienne : `socle/src/comptes.js:1047` | essai `socle/test/courriel.test.js` |
| SEC-AUTH-007 | HIGH | PASS | TOTP et clés d’accès pour tous, second facteur imposé aux administrateurs : `socle/src/comptes.js:178` | codes de secours toujours émis |
| SEC-AUTH-008 | HIGH | N/A | aucune connexion par fournisseur externe : `rg -n -i 'oauth\|openid\|id_token\|redirect_uri' lib socle/src public` → 0 |  |
| SEC-AUTH-009 | HIGH | PASS | les liens reçus par courriel demandent un geste : `socle/web/compte.js:452` ; uniques et courts : `socle/src/comptes.js:38` | aucune connexion sans mot de passe par courriel |
| SEC-AUTH-010 | CRITICAL | PASS | chaque route non publique appelle `acces()` en tête, avant la lecture du corps : `lib/api.js:141` ; une seule route publique (`lib/api.js:191`) ; preuve de machine vérifiée avant la session : `lib/api.js:119` | essai `test/run.js:543` : la table des preuves et des rôles de chaque route est figée dans l’essai |
| SEC-AUTH-011 | HIGH | PASS | clé inconnue → 401 sans dire laquelle : `lib/api.js:135` ; erreur imprévue réduite à un numéro : `socle/src/http.js:171` | une clé présentée et fausse ne retombe jamais sur la session : `test/run.js:606` |
| SEC-SESS-001 | CRITICAL | PASS | voir REQ-SESS-001 |  |
| SEC-SESS-002 | HIGH | PASS | `rg -n 'localStorage\|sessionStorage' public socle/web` → la gamme claire ou sombre seulement (`public/app.js:156`), jamais une session ni une clé | la clé d’API créée n’est montrée qu’une fois, dans une boîte de dialogue, jamais rangée dans le navigateur |
| SEC-SESS-003 | HIGH | PASS | 256 bits : `socle/src/comptes.js:289` | renouvelé à chaque changement de niveau |
| SEC-SESS-004 | HIGH | PASS | voir REQ-SESS-003, REQ-SESS-004 et REQ-SESS-006 |  |
| SEC-SESS-005 | CRITICAL | N/A | aucun JWT : `rg -n -i 'jwt\|jsonwebtoken\|jose' lib public socle/src socle/web` → 0 |  |
| SEC-SESS-006 | MEDIUM | N/A | aucun jeton de rafraîchissement : sessions serveur (voir SEC-SESS-005) ; clés d’API sans expiration, révoquées en les régénérant |  |
| SEC-SESS-007 | MEDIUM | PASS | voir REQ-SESS-005 ; avis par courriel par le canal d’alerte | courriel : H2 |
| SEC-AUTHZ-001 | CRITICAL | PASS | boîtes, courrier et tickets appartiennent au service, partagés par ses opérateurs selon leur rôle : aucun objet n’appartient à un compte (`public/confidentialite.txt:75`) ; ce qui est propre à un compte (facteurs, sessions, adresse d’alerte, export) est filtré par le socle sur le compte de la session, jamais sur un identifiant reçu | essai `test/run.js:543` ; les portées des clés sont des droits, pas des propriétaires : `test/run.js:582` |
| SEC-AUTHZ-002 | CRITICAL | PASS | rôle humain lu en base par le socle à chaque requête (`socle/src/portail.js:120`) ; portée d’une machine fixée par la preuve présentée, jamais par la requête (`lib/api.js:99`) ; boîtes, règles, réglages, clés et webhook : administrateur, et renfort pour les gestes sensibles (`lib/api.js:243`) | essais `test/run.js:528`, `test/run.js:534`, `test/run.js:543` |
| SEC-AUTHZ-003 | HIGH | PASS | schéma strict par route, champ inconnu refusé : `socle/src/schema.js:69` ; les champs sensibles d’une boîte (hôtes, mot de passe, épinglage) ne s’écrivent que par leur route, sous renfort (`lib/api.js:225`) ; l’auteur d’un geste vient de la session ou de la clé, jamais du corps (`lib/api.js:156`) | essai `test/run.js:363` |
| SEC-AUTHZ-004 | HIGH | PASS | route /api inconnue → 404 qui répète ce qui a été demandé, méthode inconnue → 405 avec Allow : `lib/api.js:782` ; identifiants du chemin au motif fixe : `lib/api.js:28` | essais `test/run.js:686`, `test/run.js:543` (une seule route publique) ; aucune route de débogage ni de semis |
| SEC-AUTHZ-005 | CRITICAL | N/A | aucune notion de locataire : un seul service, ses boîtes et ses opérateurs ; `rg -n -i 'tenant\|organisation\|workspace' lib` → 0 |  |
| SEC-AUTHZ-006 | LOW | PASS | numéros de ticket tirés au hasard : `lib/tickets.js:81` ; messages : `lib/poller.js:15` ; boîtes en UUID, règles tirées (`lib/api.js:367`) | essai `test/run.js:412` ; la 1.0 numérotait ses tickets à la suite (`TCK-0001`, `TCK-0002`…) et dérivait l’identifiant d’un message de son UID IMAP : ceux déjà émis sont gardés |
| SEC-AUTHZ-007 | HIGH | PASS | invariants tenus par le serveur : envoi depuis une boîte réglée ou l’un de ses alias autorisés seulement (`lib/api.js:640`), cinquante destinataires au plus, adresses au motif (`lib/api.js:644`), envois plafonnés par minute (`lib/api.js:616`) ; statut et urgence pris dans leurs listes ; une règle qui supprime ne naît que sous renfort | essais `test/run.js:513`, `test/run.js:516` ; aucun prix, crédit ni solde |
| SEC-AUTHZ-008 | MEDIUM | PASS | chaque droit est relu côté serveur à chaque geste (`lib/api.js:141`) : l’interface masque ce qu’un rôle ne peut pas faire (`data-admin`, `data-membre`), le serveur le refuse quand même | essai `test/run.js:534` (403 sur chaque route appelée directement) |
| SEC-INJ-001 | CRITICAL | PASS | deux requêtes préparées, valeurs liées : `lib/base.js:64`, `lib/base.js:69` | annexe B.3 : aucune interpolation de valeur dans un texte SQL, ni dans CACHET ni dans le socle |
| SEC-INJ-002 | HIGH | N/A | aucun ORM : node:sqlite, requêtes préparées seulement |  |
| SEC-INJ-003 | HIGH | N/A | aucune base documentaire : SQLite seulement ; les documents JSON sont lus et écrits entiers, jamais interrogés par opérateur |  |
| SEC-INJ-004 | CRITICAL | PASS | aucun processus lancé : `rg -n 'child_process\|execFile\|spawn\|exec\(' lib socle/src server.js` → 0 | les protocoles parlés (IMAP, SMTP) reçoivent leurs valeurs sur une ligne, contrôlées : voir REQ-WEB-007 |
| SEC-INJ-005 | HIGH | PASS | `socle/src/http.js:205` : chemin normalisé, sorti de la racine refusé ; aucun nom de fichier fourni par une requête n’est ouvert | seule écriture : la base, dont le nom est fixé par le serveur ; les fichiers de la 1.0 ont des noms fixes |
| SEC-INJ-006 | HIGH | PASS | aucun moteur de gabarits côté serveur : messages construits champ par champ, en-têtes encodés (`lib/smtp.js:54`) ; corps du webhook et de Telegram en JSON ; `rg -n 'new Function\|node:vm\|eval\(' lib socle/src` → 0 | les expressions des règles sont des expressions régulières bornées, jamais du code : `lib/rules.js:13` |
| SEC-INJ-007 | HIGH | N/A | aucun analyseur XML : `rg -n -i 'xml2js\|sax\|libxml\|fast-xml\|xmldom' lib socle/src` → 0 ; le HTML des messages est nettoyé par liste blanche, sans entité externe ni DTD |  |
| SEC-INJ-008 | HIGH | PASS | JSON seulement ; clés de prototype refusées : `socle/src/schema.js:6` ; règles et réglages fusionnés champ par champ depuis un corps déjà validé, jamais par une fusion récursive | reprise de la 1.0 : ses deux fichiers JSON, lus une fois depuis le volume et réécrits champ par champ (`lib/base.js:138`) |
| SEC-XSS-001 | CRITICAL | PASS | aucune API d’injection de HTML dans l’interface : tout balisage par les gabarits du socle, chaque valeur en nœud texte ou attribut (`public/app.js:10`) ; `rg -n 'innerHTML\|outerHTML\|insertAdjacentHTML\|document.write' public` → 0 ; le socle n’en a qu’une, sur ses chaînes littérales (`socle/web/gabarit.js:115`) | essai `test/run.js:717` ; parcours navigateur : `<img src=x onerror=…>` dans l’objet, l’expéditeur, le corps, un dossier, une règle et un service, contrôlé sur chaque écran, chaque gamme, chaque largeur → 0 élément interprété |
| SEC-XSS-002 | HIGH | PASS | corps HTML des messages : liste blanche côté serveur (balises de mise en forme, liens http(s), mailto et tel seulement, images retirées) : `lib/html.js:29` ; puis relu dans un document inerte et reconstruit côté navigateur : `public/app.js:389` | essais `test/run.js:72`, `test/run.js:82`, `test/run.js:86` ; parcours navigateur (script, image et onclick absents du rendu) |
| SEC-XSS-003 | HIGH | PASS | `rg -n 'eval\(\|new Function\|setTimeout\(["\x27]\|location.href *=' public socle/web` → 0 | la navigation interne choisit une page connue par son nom, jamais une adresse reçue |
| SEC-XSS-004 | HIGH | PASS | voir REQ-WEB-002 |  |
| SEC-XSS-005 | MEDIUM | PASS | seul échange : le Worker de preuve de travail du socle, de même origine (`socle/web/compte.js:236`) ; `rg -n "addEventListener\('message'\|postMessage" public` → 0 | aucune iframe ni fenêtre tierce |
| SEC-XSS-006 | MEDIUM | PASS | aucune carte de source publiée ; aucun journal de débogage dans `public/` ; erreurs imprévues réduites à un numéro (`socle/src/http.js:171`) ; secrets jamais rendus par l’API (`lib/api.js:101`) | l’erreur d’un serveur SMTP est rendue à l’opérateur qui envoie : c’est elle qui dit quoi corriger, elle ne vient pas de CACHET |
| SEC-XSS-007 | MEDIUM | N/A | aucune redirection pilotée par paramètre : `rg -n 'Location\|redirect' lib` → aucune réponse 30x ; `curl -sI '/?next=https://evil.example'` → aucun Location (annexe B.4) |  |
| SEC-XSS-008 | MEDIUM | PASS | aucun script, style ni police tiers : tout est servi par CACHET et le socle (CSP `script-src 'self'`) ; polices du socle embarquées |  |
| SEC-HDR-001 | HIGH | FAIL | voir REQ-WEB-001 | action H1 |
| SEC-HDR-002 | HIGH | PASS | voir REQ-WEB-002 |  |
| SEC-HDR-003 | MEDIUM | PASS | voir REQ-WEB-003 |  |
| SEC-HDR-004 | LOW | PASS | `curl -sI /` : ni Server ni X-Powered-By (annexe B.4) |  |
| SEC-HDR-005 | MEDIUM | PASS | no-store sur l’API (`socle/src/http.js:150`) et sur la page (`lib/serveur.js:67`) ; seuls les fichiers versionnés de l’interface et du socle sont mis en cache (`lib/serveur.js:60`) | le relais qui impose sa durée de cache ne sert jamais une interface périmée : la version est dans l’adresse des fichiers |
| SEC-HDR-006 | CRITICAL | PASS | voir REQ-WEB-004 |  |
| SEC-HDR-007 | HIGH | PASS | voir REQ-SESS-001 |  |
| SEC-CSRF-001 | HIGH | PASS | SameSite=Strict, origine et jeton : `socle/src/portail.js:98`, appelé par chaque écriture de session | essai `test/run.js:341` ; clés d’API et jeton du Hub en en-tête, que le navigateur n’envoie jamais seul ; CORS sans cookie (`lib/api.js:756`) |
| SEC-CSRF-002 | MEDIUM | PASS | `socle/src/http.js:122` | 415 sur tout autre type |
| SEC-CSRF-003 | MEDIUM | PASS | voir REQ-WEB-005 : relever, accuser réception, purger, rattraper et envoyer sont des POST | annexe B.4 : un GET sur une route d’écriture répond 405 |
| SEC-CSRF-004 | CRITICAL | PASS | serveurs IMAP, SMTP et webhook déclarés par un administrateur sous renfort et journalisés : c’est la liste des destinations admises (`lib/api.js:225`) ; métadonnées de nuage, lien local et plages réservées refusés en littéral comme à la résolution, adresse contrôlée au moment même de la connexion (`lib/reseau.js:53`) ; webhook en http(s) seulement, sans identifiants dans l’adresse, sans redirection suivie, réponse jamais lue, 8 secondes au plus (`lib/webhook.js:15`) ; IMAP et SMTP en TLS vérifié ou épinglé, délais et tampons bornés (`lib/imap.js:12`) ; Telegram : hôte fixe, redirection refusée (`lib/notify.js:20`) | essais `test/run.js:375`, `test/run.js:647` ; les serveurs de courrier vivent souvent sur le réseau interne (Proton Bridge, serveur maison) : bouclage et plages privées restent permis à l’administrateur qui les déclare |
| SEC-CSRF-005 | HIGH | PASS | webhook sortant vers une adresse réglée par l’administrateur : protections de SEC-CSRF-004, signé HMAC-SHA256 (`lib/webhook.js:11`), corps limité au ticket ; aucun webhook reçu | essai `test/run.js:626` |
| SEC-CSRF-006 | MEDIUM | N/A | aucune redirection pilotée par paramètre : voir SEC-XSS-007 |  |
| SEC-API-001 | HIGH | PASS | voir REQ-WEB-006 |  |
| SEC-API-002 | HIGH | PASS | voir REQ-WEB-008 ; envois plafonnés par minute (`lib/api.js:616`) ; clés fausses plafonnées par adresse (voir REQ-AUTH-010) | essais `test/run.js:730`, `test/run.js:784` |
| SEC-API-003 | MEDIUM | PASS | messages : 100 par défaut, 500 au plus (`lib/api.js:423`) ; tickets : 200 par défaut, 1000 au plus ; état de l’interface : mille tickets et deux mille messages au plus (`lib/api.js:178`) ; journal : 200 lignes ; essai à blanc : 200 messages examinés, 30 rendus ; accusés : 500 par appel | essai `test/run.js:666` (`limit=100000` ramené à 1000) ; la 1.0 rendait tous les tickets |
| SEC-API-004 | HIGH | PASS | réponses construites champ par champ : mots de passe des boîtes jamais rendus (`lib/api.js:101`), secrets du webhook et de Telegram réduits à « posé » (`lib/api.js:172`), clés d’API réduites à « existe » (`lib/api.js:732`) ; résumé du Hub réduit à des comptes (`lib/api.js:203`) | essai `test/run.js:562` ; sondage exploratoire ci-dessous |
| SEC-API-005 | MEDIUM | PASS | 405 avec Allow : `lib/api.js:782` ; la liste des routes (`GET /api`) demande une preuve (`lib/api.js:192`) ; aucune page de débogage | essais `test/run.js:686`, `test/run.js:698` |
| SEC-API-006 | HIGH | N/A | aucun GraphQL : `rg -n -i 'graphql\|apollo' lib public socle` → 0 |  |
| SEC-API-007 | MEDIUM | PASS | un seul formateur d’erreurs : `socle/src/http.js:159` ; chaque route valide tout le corps avant de toucher à l’état, puis écrit son document en une instruction SQLite (`lib/base.js:69`) ; un envoi échoué retire sa clé d’idempotence et ne garde aucune copie | l’erreur d’un serveur de courrier est rendue telle qu’il l’a dite : elle vient de lui, pas de CACHET (voir SEC-XSS-006) |
| SEC-API-008 | MEDIUM | PASS | aucune opération monétaire (`rg -n -i 'stripe\|paypal\|checkout\|invoice\|payout\|refund' lib public socle/src socle/web` → 0 : aucun paiement) ; l’effet irréversible de CACHET, l’envoi d’un courriel, accepte une clé d’idempotence retenue avant l’envoi, vingt-quatre heures, par appelant (`lib/api.js:623`) ; l’interface en tire une par message écrit (`public/app.js:949`) | essai `test/run.js:500` ; aucun webhook reçu |
| SEC-API-009 | HIGH | PASS | aucun cadriciel RPC : chaque route vérifie elle-même sa preuve, son rôle et son schéma (`lib/api.js:141`) ; une route rangée sous le préfixe d’un client garde les mêmes droits (`lib/api.js:775`) | essais `test/run.js:543`, `test/run.js:692` |
| SEC-API-010 | MEDIUM | PASS | `socle/src/http.js:128` ; 64 Kio par défaut, 256 Kio pour un envoi (`lib/api.js:617`) |  |
| SEC-DB-001 | CRITICAL | PASS | voir REQ-DATA-001 |  |
| SEC-DB-002 | HIGH | N/A | SQLite embarqué, sans rôle ni identifiant ni port : `lib/base.js:41` |  |
| SEC-DB-003 | HIGH | FAIL | aucun trafic réseau vers la base ; secrets des boîtes, du webhook, de Telegram et des facteurs scellés | chiffrement du disque de l’hôte : action H7 |
| SEC-DB-004 | MEDIUM | PASS | secrets scellés AES-256-GCM, sous-clé par usage, liés à leur propriétaire : `lib/base.js:79` sur `socle/src/chiffre.js:60` ; clés d’API gardées par leur empreinte (`lib/base.js:50`) ; clé maîtresse jamais dans le volume : coffre du Hub, ou secret Docker installé seul | essai `test/run.js:390` (lecture brute de la base) |
| SEC-DB-005 | CRITICAL | PASS | voir SEC-INJ-001 |  |
| SEC-DB-006 | HIGH | FAIL | voir REQ-DATA-003 | actions H8, H16 |
| SEC-DB-007 | MEDIUM | PASS | essais sur données fabriquées (boîtes et alias en `exemple.fr`, serveurs IMAP et SMTP simulés) ; aucun compte par défaut : jeton d’installation exigé (`socle/src/comptes.js:249`) |  |
| SEC-DB-008 | CRITICAL | N/A | le navigateur ne parle jamais à la base : SQLite côté serveur seulement |  |
| SEC-DB-009 | LOW | PASS | un seul processus, une connexion, attente bornée et journal WAL : `lib/base.js:42` | listes et documents bornés (voir SEC-API-003) ; l’état est écrit au plus toutes les deux secondes |
| SEC-DB-010 | LOW | PASS | voir REQ-DATA-004 : boîtes, règles, réglages, clés, webhook, envois, suppressions, purges, rattrapages et certificats épinglés au journal chaîné |  |
| SEC-FILE-001 | HIGH | N/A | aucun envoi de fichier : corps JSON seulement (`socle/src/http.js:122`) ; pièces jointes des messages jamais extraites ni gardées ; `rg -n -i 'multipart/form-data\|busboy\|formidable\|multer' lib socle/src` → 0 |  |
| SEC-FILE-002 | MEDIUM | N/A | aucun envoi de fichier : corps JSON seulement (`socle/src/http.js:122`) ; pièces jointes des messages jamais extraites ni gardées ; `rg -n -i 'multipart/form-data\|busboy\|formidable\|multer' lib socle/src` → 0 ; corps bornés (voir SEC-API-010) |  |
| SEC-FILE-003 | HIGH | N/A | aucun fichier d’utilisateur écrit ; seule écriture : la base, nommée par le serveur |  |
| SEC-FILE-004 | HIGH | N/A | aucun fichier d’utilisateur servi : seuls `public/` et `socle/web` |  |
| SEC-FILE-005 | CRITICAL | N/A | aucun fichier d’utilisateur stocké : aucun envoi de fichier : corps JSON seulement (`socle/src/http.js:122`) ; pièces jointes des messages jamais extraites ni gardées ; `rg -n -i 'multipart/form-data\|busboy\|formidable\|multer' lib socle/src` → 0 |  |
| SEC-FILE-006 | MEDIUM | N/A | aucun fichier partagé entre utilisateurs |  |
| SEC-FILE-007 | LOW | N/A | aucune image acceptée ; les images des messages HTML sont retirées, jamais chargées (`lib/html.js:29`) |  |
| SEC-FILE-008 | HIGH | N/A | aucun import depuis une adresse : CACHET ne télécharge rien ; ses connexions sortantes (IMAP, SMTP, webhook, Telegram) suivent SEC-CSRF-004 |  |
| SEC-PAY-001 | CRITICAL | N/A | `rg -n -i 'stripe\|paypal\|checkout\|invoice\|payout\|refund' lib public socle/src socle/web` → 0 : aucun paiement |  |
| SEC-PAY-002 | CRITICAL | N/A | `rg -n -i 'stripe\|paypal\|checkout\|invoice\|payout\|refund' lib public socle/src socle/web` → 0 : aucun paiement |  |
| SEC-PAY-003 | HIGH | N/A | `rg -n -i 'stripe\|paypal\|checkout\|invoice\|payout\|refund' lib public socle/src socle/web` → 0 : aucun paiement |  |
| SEC-PAY-004 | HIGH | N/A | `rg -n -i 'stripe\|paypal\|checkout\|invoice\|payout\|refund' lib public socle/src socle/web` → 0 : aucun paiement |  |
| SEC-PAY-005 | HIGH | N/A | `rg -n -i 'stripe\|paypal\|checkout\|invoice\|payout\|refund' lib public socle/src socle/web` → 0 : aucun paiement |  |
| SEC-PAY-006 | HIGH | PASS | envoi de CACHET : personne connectée (membre) ou clé d’envoi, jamais anonyme ; expéditeur toujours une boîte réglée ou l’un de ses alias autorisés, jamais choisi librement (`lib/api.js:640`) ; cinquante destinataires au plus ; plafond par minute, toutes clés et toutes adresses confondues (`lib/api.js:616`) ; aucun en-tête ni commande SMTP fabriqué par un retour à la ligne (`lib/smtp.js:54`) ; alertes du socle : 30 par heure et par compte (`socle/src/notifications.js:98`), vérification d’adresse 5 par heure (`socle/src/portail.js:38`) | essais `test/run.js:275`, `test/run.js:516` ; le plafond commun est plus strict qu’un plafond par compte ou par adresse : aucun compte ni aucune adresse ne dépasse 30 envois par minute |
| SEC-PAY-007 | MEDIUM | FAIL | CACHET envoie par le serveur SMTP de chaque boîte ; le domaine d’expédition est celui de l’exploitant | SPF, DKIM et DMARC (au moins quarantine) à publier pour chaque domaine d’expédition : action H2 |
| SEC-PAY-008 | MEDIUM | PASS | aucun secret dans un courriel : liens du socle uniques, hachés et courts (`socle/src/comptes.js:38`), lien de révocation qui ne peut que fermer des sessions (`socle/src/notifications.js:27`) ; les courriels de CACHET sont écrits par l’opérateur, rien n’y est ajouté |  |
| SEC-NEXT-001 | CRITICAL | N/A | Node sans cadriciel : `package.json:5`, aucune dépendance ; `rg -n -i 'next/\|nextjs\|use server\|vercel' lib public socle/src socle/web` → 0 |  |
| SEC-NEXT-002 | CRITICAL | N/A | Node sans cadriciel : `package.json:5`, aucune dépendance ; `rg -n -i 'next/\|nextjs\|use server\|vercel' lib public socle/src socle/web` → 0 |  |
| SEC-NEXT-003 | HIGH | N/A | Node sans cadriciel : `package.json:5`, aucune dépendance ; `rg -n -i 'next/\|nextjs\|use server\|vercel' lib public socle/src socle/web` → 0 |  |
| SEC-NEXT-004 | CRITICAL | N/A | Node sans cadriciel : `package.json:5`, aucune dépendance ; `rg -n -i 'next/\|nextjs\|use server\|vercel' lib public socle/src socle/web` → 0 |  |
| SEC-NEXT-005 | HIGH | N/A | Node sans cadriciel : `package.json:5`, aucune dépendance ; `rg -n -i 'next/\|nextjs\|use server\|vercel' lib public socle/src socle/web` → 0 |  |
| SEC-NEXT-006 | HIGH | N/A | Node sans cadriciel : `package.json:5`, aucune dépendance ; `rg -n -i 'next/\|nextjs\|use server\|vercel' lib public socle/src socle/web` → 0 |  |
| SEC-NEXT-007 | HIGH | N/A | Node sans cadriciel : `package.json:5`, aucune dépendance ; `rg -n -i 'next/\|nextjs\|use server\|vercel' lib public socle/src socle/web` → 0 |  |
| SEC-NEXT-008 | MEDIUM | N/A | Node sans cadriciel : `package.json:5`, aucune dépendance ; `rg -n -i 'next/\|nextjs\|use server\|vercel' lib public socle/src socle/web` → 0 |  |
| SEC-NEXT-009 | MEDIUM | N/A | Node sans cadriciel : `package.json:5`, aucune dépendance ; `rg -n -i 'next/\|nextjs\|use server\|vercel' lib public socle/src socle/web` → 0 |  |
| SEC-BAAS-001 | CRITICAL | N/A | `rg -n -i 'supabase\|firebase\|firestore\|postgrest' lib public socle` → 0 ; base SQLite embarquée côté serveur : `lib/base.js:41` |  |
| SEC-BAAS-002 | CRITICAL | N/A | `rg -n -i 'supabase\|firebase\|firestore\|postgrest' lib public socle` → 0 ; base SQLite embarquée côté serveur : `lib/base.js:41` |  |
| SEC-BAAS-003 | CRITICAL | N/A | `rg -n -i 'supabase\|firebase\|firestore\|postgrest' lib public socle` → 0 ; base SQLite embarquée côté serveur : `lib/base.js:41` |  |
| SEC-BAAS-004 | HIGH | N/A | `rg -n -i 'supabase\|firebase\|firestore\|postgrest' lib public socle` → 0 ; base SQLite embarquée côté serveur : `lib/base.js:41` |  |
| SEC-BAAS-005 | CRITICAL | N/A | `rg -n -i 'supabase\|firebase\|firestore\|postgrest' lib public socle` → 0 ; base SQLite embarquée côté serveur : `lib/base.js:41` |  |
| SEC-BAAS-006 | HIGH | N/A | `rg -n -i 'supabase\|firebase\|firestore\|postgrest' lib public socle` → 0 ; base SQLite embarquée côté serveur : `lib/base.js:41` |  |
| SEC-BAAS-007 | MEDIUM | N/A | `rg -n -i 'supabase\|firebase\|firestore\|postgrest' lib public socle` → 0 ; base SQLite embarquée côté serveur : `lib/base.js:41` |  |
| SEC-BAAS-008 | CRITICAL | N/A | `rg -n -i 'supabase\|firebase\|firestore\|postgrest' lib public socle` → 0 ; base SQLite embarquée côté serveur : `lib/base.js:41` |  |
| SEC-BAAS-009 | CRITICAL | N/A | `rg -n -i 'supabase\|firebase\|firestore\|postgrest' lib public socle` → 0 ; base SQLite embarquée côté serveur : `lib/base.js:41` |  |
| SEC-BAAS-010 | HIGH | N/A | `rg -n -i 'supabase\|firebase\|firestore\|postgrest' lib public socle` → 0 ; base SQLite embarquée côté serveur : `lib/base.js:41` |  |
| SEC-BAAS-011 | HIGH | N/A | `rg -n -i 'supabase\|firebase\|firestore\|postgrest' lib public socle` → 0 ; base SQLite embarquée côté serveur : `lib/base.js:41` |  |
| SEC-BE-001 | MEDIUM | PASS | en-têtes posés avant toute route, refus de débit et erreurs compris : `lib/serveur.js:54` | essai `test/run.js:784` ; annexe B.4 ; la 2.0 posait d’abord le refus de débit, sans en-têtes |
| SEC-BE-002 | MEDIUM | PASS | corps bornés (voir SEC-API-010) ; 404 pour l’inconnu (`lib/api.js:781`) ; relais de confiance explicites, adresse du client lue sur eux seuls : `socle/src/http.js:14` ; délais du serveur : `lib/serveur.js:75` | formateur d’erreurs unique : `lib/serveur.js:72` ; la 1.0 lisait `X-Forwarded-For` de n’importe qui |
| SEC-BE-003 | HIGH | PASS | voir SEC-INJ-004 et SEC-INJ-008 ; aucun import dynamique |  |
| SEC-BE-004 | HIGH | PASS | aucune dépendance npm : `package.json` sans `dependencies` ni `devDependencies`, rien à verrouiller | Argon2id, SQLite et TLS viennent du moteur Node, épinglé par empreinte dans l’image |
| SEC-BE-005 | CRITICAL | N/A | aucun Django : serveur Node seulement (`rg --files -g '*.py'` → 0) |  |
| SEC-BE-006 | HIGH | N/A | aucun Flask ni FastAPI : serveur Node seulement (`rg --files -g '*.py'` → 0) |  |
| SEC-BE-007 | HIGH | N/A | aucun code Python : `rg --files -g '*.py'` → 0 |  |
| SEC-BE-008 | HIGH | N/A | aucun PHP : `rg --files -g '*.php'` → 0 |  |
| SEC-BE-009 | MEDIUM | PASS | utilisateur 10001 sans shell : `Dockerfile:19` ; base slim épinglée par empreinte (`Dockerfile:6`) ; données en 0700, base et journaux WAL en 0600 (`lib/base.js:39`) |  |
| SEC-BE-010 | MEDIUM | PASS | `socle/src/http.js:159` ; sonde publique réduite à « vivant » : `lib/api.js:191` | essai `test/run.js:328` |
| SEC-WP-001 | CRITICAL | N/A | application Node écrite ici : `rg -n -i 'wordpress\|wp-admin\|bubble\|webflow\|airtable' lib public socle` → 0 |  |
| SEC-WP-002 | HIGH | N/A | application Node écrite ici : `rg -n -i 'wordpress\|wp-admin\|bubble\|webflow\|airtable' lib public socle` → 0 |  |
| SEC-WP-003 | HIGH | N/A | application Node écrite ici : `rg -n -i 'wordpress\|wp-admin\|bubble\|webflow\|airtable' lib public socle` → 0 |  |
| SEC-WP-004 | MEDIUM | N/A | application Node écrite ici : `rg -n -i 'wordpress\|wp-admin\|bubble\|webflow\|airtable' lib public socle` → 0 |  |
| SEC-WP-005 | MEDIUM | N/A | application Node écrite ici : `rg -n -i 'wordpress\|wp-admin\|bubble\|webflow\|airtable' lib public socle` → 0 |  |
| SEC-WP-006 | CRITICAL | N/A | application Node écrite ici : `rg -n -i 'wordpress\|wp-admin\|bubble\|webflow\|airtable' lib public socle` → 0 |  |
| SEC-WP-007 | HIGH | N/A | application Node écrite ici : `rg -n -i 'wordpress\|wp-admin\|bubble\|webflow\|airtable' lib public socle` → 0 |  |
| SEC-WP-008 | MEDIUM | N/A | application Node écrite ici : `rg -n -i 'wordpress\|wp-admin\|bubble\|webflow\|airtable' lib public socle` → 0 |  |
| SEC-INFRA-001 | HIGH | FAIL | voir REQ-WEB-001 | action H1 |
| SEC-INFRA-002 | MEDIUM | FAIL | aucun domaine dans le dépôt | DNS, CAA et verrou du registraire du domaine éventuel : action H13 |
| SEC-INFRA-003 | HIGH | FAIL | hôtes de l’exploitant | pare-feu, SSH par clé, mises à jour : action H9 |
| SEC-INFRA-004 | MEDIUM | FAIL | `Dockerfile:6` ; `Dockerfile:19` ; `deploy/compose.hub.yml:14` ; `deploy/compose.hub.yml:17` ; `deploy/compose.hub.yml:18` | l’image n’a pas pu être construite ici (registre Docker injoignable) : construction et crible (Grype en CI, Trivy au déploiement) à exécuter → actions H3, H14 |
| SEC-INFRA-005 | CRITICAL | N/A | aucun stockage objet : `rg -n -i 's3\|aws-sdk\|gcs\|azure\|bucket' lib socle/src` → 0 |  |
| SEC-INFRA-006 | HIGH | N/A | aucun nuage : service auto-hébergé, aucune clé IAM |  |
| SEC-INFRA-007 | HIGH | FAIL | permissions minimales (`.github/workflows/verification.yml:15`), actions épinglées par commit, aucun secret pour les demandes de fusion ; publication dans une tâche à part, droits `packages: write` à elle seule (`.github/workflows/publish.yml:28`) | protection de branche et revue requise : action H3 |
| SEC-INFRA-008 | MEDIUM | FAIL | image publiée après le crible, avec provenance et SBOM : `.github/workflows/publish.yml:89` ; socle embarqué vérifié par ses empreintes (`.github/workflows/verification.yml:35`) | la publication tourne sur les Actions : action H3 |
| SEC-INFRA-009 | MEDIUM | N/A | aucune infrastructure décrite en code : `find . -name '*.tf' -o -name 'Pulumi.yaml'` → 0 fichier |  |
| SEC-DEP-001 | HIGH | PASS | aucune dépendance npm ; image de base par empreinte (`Dockerfile:6`) ; actions par commit |  |
| SEC-DEP-002 | HIGH | FAIL | aucune dépendance npm ; image passée au crible à chaque poussée et chaque lundi (`.github/workflows/verification.yml:54`) | alertes Dependabot et contrôle requis : action H3 |
| SEC-DEP-003 | MEDIUM | PASS | aucune dépendance npm : rien à choisir ni à abandonner |  |
| SEC-DEP-004 | MEDIUM | PASS | image de base par empreinte, actions par commit (`.github/workflows/verification.yml:22`) ; mises à jour proposées en demandes de fusion, jamais fusionnées seules (`.github/dependabot.yml:9`) | revue requise avant fusion : protection de branche, action H3 |
| SEC-DEP-005 | MEDIUM | PASS | aucune installation de paquet npm : ni `npm install` ni script de cycle de vie, dans le dépôt comme dans l’image (`Dockerfile:14` sans installation) |  |
| SEC-DEP-006 | LOW | FAIL | `.github/workflows/publish.yml:90` | produit par la publication (H3) |
| SEC-DEP-007 | MEDIUM | PASS | voir SEC-XSS-008 |  |
| SEC-DEP-008 | LOW | FAIL | crible de l’image chaque lundi (`.github/workflows/verification.yml:13`) | abonnement aux avis GitHub : action H3 |
| SEC-LLM-001 | CRITICAL | N/A | CACHET n’appelle aucun modèle et n’en expose aucun : `rg -n -i 'openai\|anthropic\|ollama\|mistral\|completions\|embeddings\|/v1/chat' lib public socle/src` → 0 ; les actions offertes à l’assistant du Hub sont celles du manifeste, envoi d’un courriel en validation humaine (`hub.json:611`) |  |
| SEC-LLM-002 | CRITICAL | N/A | CACHET n’appelle aucun modèle et n’en expose aucun : `rg -n -i 'openai\|anthropic\|ollama\|mistral\|completions\|embeddings\|/v1/chat' lib public socle/src` → 0 ; les actions offertes à l’assistant du Hub sont celles du manifeste, envoi d’un courriel en validation humaine (`hub.json:611`) |  |
| SEC-LLM-003 | HIGH | N/A | CACHET n’appelle aucun modèle et n’en expose aucun : `rg -n -i 'openai\|anthropic\|ollama\|mistral\|completions\|embeddings\|/v1/chat' lib public socle/src` → 0 ; les actions offertes à l’assistant du Hub sont celles du manifeste, envoi d’un courriel en validation humaine (`hub.json:611`) |  |
| SEC-LLM-004 | HIGH | N/A | CACHET n’appelle aucun modèle et n’en expose aucun : `rg -n -i 'openai\|anthropic\|ollama\|mistral\|completions\|embeddings\|/v1/chat' lib public socle/src` → 0 ; les actions offertes à l’assistant du Hub sont celles du manifeste, envoi d’un courriel en validation humaine (`hub.json:611`) |  |
| SEC-LLM-005 | CRITICAL | N/A | CACHET n’appelle aucun modèle et n’en expose aucun : `rg -n -i 'openai\|anthropic\|ollama\|mistral\|completions\|embeddings\|/v1/chat' lib public socle/src` → 0 ; les actions offertes à l’assistant du Hub sont celles du manifeste, envoi d’un courriel en validation humaine (`hub.json:611`) |  |
| SEC-LLM-006 | HIGH | N/A | CACHET n’appelle aucun modèle et n’en expose aucun : `rg -n -i 'openai\|anthropic\|ollama\|mistral\|completions\|embeddings\|/v1/chat' lib public socle/src` → 0 ; les actions offertes à l’assistant du Hub sont celles du manifeste, envoi d’un courriel en validation humaine (`hub.json:611`) |  |
| SEC-LLM-007 | MEDIUM | N/A | CACHET n’appelle aucun modèle et n’en expose aucun : `rg -n -i 'openai\|anthropic\|ollama\|mistral\|completions\|embeddings\|/v1/chat' lib public socle/src` → 0 ; les actions offertes à l’assistant du Hub sont celles du manifeste, envoi d’un courriel en validation humaine (`hub.json:611`) |  |
| SEC-LLM-008 | LOW | N/A | CACHET n’appelle aucun modèle et n’en expose aucun : `rg -n -i 'openai\|anthropic\|ollama\|mistral\|completions\|embeddings\|/v1/chat' lib public socle/src` → 0 ; les actions offertes à l’assistant du Hub sont celles du manifeste, envoi d’un courriel en validation humaine (`hub.json:611`) |  |
| SEC-LOG-001 | MEDIUM | PASS | voir REQ-DATA-004 ; chaque ligne : date, acteur, adresse, action, objet, résultat (`socle/src/journal.js:10`) ; identifiant de requête : `socle/src/requete.js:12` | magasin persistant : le journal chaîné en base ; hors hôte : action H11 |
| SEC-LOG-002 | HIGH | PASS | `socle/src/journal.js:10` ; CACHET n’y met jamais un mot de passe, une clé ni un jeton : le nombre de destinataires d’un envoi, l’empreinte publique d’un certificat, le nom des champs de réglages modifiés (`lib/api.js:723`) | `rg -n "journal\.(ecrire\|rare)" lib` relu ligne à ligne : aucune valeur secrète |
| SEC-LOG-003 | MEDIUM | FAIL | sortie standard conservée par Docker, hors de portée du service : `deploy/compose.hub.yml:23` | collecteur central hors hôte : action H11 |
| SEC-LOG-004 | MEDIUM | FAIL | règles du socle : rafales d’échecs de connexion, clés refusées comprises, refus d’accès, verrous et limites, erreurs internes, connexion d’un administrateur (`socle/src/vigie.js:11`) ; boîtes en échec signalées au Hub (sonde `boxes-failing`, `hub.json:746`) | hors de l’application, l’alerte du socle ne part que par courriel : action H2 |
| SEC-LOG-005 | LOW | FAIL | santé du conteneur : `Dockerfile:23` ; sondes du Hub (`hub.json:700`) | surveillance externe : action H10 |
| SEC-LOG-006 | MEDIUM | PASS | runbook ci-dessous |  |
| SEC-LOG-007 | HIGH | PASS | sessions : fermeture globale (`socle/src/portail.js:489`) ; clés d’API : régénérées d’un geste, l’ancienne cesse (`lib/api.js:736`) ; jeton du Hub : régénéré par le Hub et redéployé ; clé maîtresse tournée sans ressaisie (`lib/serveur.js:37`) | chaque procédure écrite dans le runbook ci-dessous ; exercice de la clé maîtresse et de la fermeture des sessions par les essais du socle (`socle/test/`) |
| SEC-PRIV-001 | MEDIUM | PASS | `public/confidentialite.txt:7` avec durées ; purge à la rétention, envoyés compris : `lib/poller.js:233` |  |
| SEC-PRIV-002 | MEDIUM | PASS | un cookie de session et un cookie de cérémonie, documentés ; aucun traceur (`public/confidentialite.txt:64`) |  |
| SEC-PRIV-003 | MEDIUM | PASS | `public/confidentialite.txt:53` nomme chaque destinataire ; lien depuis la page Sécurité (`public/app.js:139`) |  |
| SEC-PRIV-004 | MEDIUM | PASS | export du compte : `socle/src/portail.js:344` ; effacement en libre-service sous renfort : `socle/src/comptes.js:932` ; courrier d’une personne qui écrit aux boîtes : supprimé à la demande (`lib/api.js:469`), purgé à la rétention | essai `test/run.js:453` ; la politique de suppression (sauvegardes : expiration à trente jours) est écrite dans `public/confidentialite.txt` |
| SEC-PRIV-005 | HIGH | FAIL | voir REQ-DATA-002 | action H7 |
| SEC-PRIV-006 | LOW | FAIL | aucun sous-traitant dans le code ; les fournisseurs de courriel des boîtes, Telegram et le relais SMTP sont choisis par l’exploitant | accords de traitement ou fournisseurs européens : action H15 |
| SEC-PRIV-007 | MEDIUM | PASS | runbook : notification sous 72 heures ; `public/confidentialite.txt:84` |  |
| SEC-PRIV-008 | LOW | PASS | `public/confidentialite.txt:88` | aucune catégorie particulière de données |
| SEC-TEST-001 | MEDIUM | FAIL | `.github/workflows/verification.yml:129` | Actions : H3 |
| SEC-TEST-002 | HIGH | FAIL | voir REQ-CI-001 | actions H3, H4 |
| SEC-TEST-003 | HIGH | FAIL | image : `.github/workflows/verification.yml:54` ; aucune dépendance npm à auditer | actions H3, H14 |
| SEC-TEST-004 | MEDIUM | FAIL | aucun passage DAST encore | ZAP en mode « baseline » contre la VM d’essai : action H14 |
| SEC-TEST-005 | LOW | FAIL | voir REQ-WEB-001 | notation après HTTPS : action H1 |
| SEC-TEST-006 | HIGH | PASS | voir REQ-CI-006 |  |
| SEC-TEST-007 | LOW | PASS | sondage exploratoire du 2026-10-23 : section « Exploratory probing » ci-dessous (41 cas : clés inventées et trop faibles, routes d’administration par clé, champs et paramètres inconnus, hôtes piégés, injections IMAP et SMTP, webhook vers des adresses internes, CORS, corps géants, rôles) | chaque trouvaille est devenue un essai de non-régression |
| SEC-TEST-008 | LOW | N/A | ni argent, ni santé, ni large public : service auto-hébergé pour quelques opérateurs invités ; `rg -n -i 'stripe\|paypal\|checkout\|invoice\|payout\|refund' lib public socle/src socle/web` → 0 : aucun paiement |  |

## Not applicable
| ID | Why, with proof |
|---|---|
| REQ-CRYPT-003 | bcrypt absent : `rg -n -i bcrypt lib socle/src` → 0 ; Argon2id seul |
| REQ-DATA-007 | aucun envoi de fichier ni import depuis une adresse : corps JSON seulement (`socle/src/http.js:122`), pièces jointes des messages ignorées ; `rg -n -i 'multipart/form\|busboy\|formidable' lib socle/src` → 0 |
| SEC-AUTH-008 | aucune connexion par fournisseur externe : `rg -n -i 'oauth\|openid\|id_token\|redirect_uri' lib socle/src public` → 0 |
| SEC-SESS-005 | aucun JWT : `rg -n -i 'jwt\|jsonwebtoken\|jose' lib public socle/src socle/web` → 0 |
| SEC-SESS-006 | aucun jeton de rafraîchissement : sessions serveur (voir SEC-SESS-005) ; clés d’API sans expiration, révoquées en les régénérant |
| SEC-AUTHZ-005 | aucune notion de locataire : un seul service, ses boîtes et ses opérateurs ; `rg -n -i 'tenant\|organisation\|workspace' lib` → 0 |
| SEC-INJ-002 | aucun ORM : node:sqlite, requêtes préparées seulement |
| SEC-INJ-003 | aucune base documentaire : SQLite seulement ; les documents JSON sont lus et écrits entiers, jamais interrogés par opérateur |
| SEC-INJ-007 | aucun analyseur XML : `rg -n -i 'xml2js\|sax\|libxml\|fast-xml\|xmldom' lib socle/src` → 0 ; le HTML des messages est nettoyé par liste blanche, sans entité externe ni DTD |
| SEC-XSS-007 | aucune redirection pilotée par paramètre : `rg -n 'Location\|redirect' lib` → aucune réponse 30x ; `curl -sI '/?next=https://evil.example'` → aucun Location (annexe B.4) |
| SEC-CSRF-006 | aucune redirection pilotée par paramètre : voir SEC-XSS-007 |
| SEC-API-006 | aucun GraphQL : `rg -n -i 'graphql\|apollo' lib public socle` → 0 |
| SEC-DB-002 | SQLite embarqué, sans rôle ni identifiant ni port : `lib/base.js:41` |
| SEC-DB-008 | le navigateur ne parle jamais à la base : SQLite côté serveur seulement |
| SEC-FILE-001 | aucun envoi de fichier : corps JSON seulement (`socle/src/http.js:122`) ; pièces jointes des messages jamais extraites ni gardées ; `rg -n -i 'multipart/form-data\|busboy\|formidable\|multer' lib socle/src` → 0 |
| SEC-FILE-002 | aucun envoi de fichier : corps JSON seulement (`socle/src/http.js:122`) ; pièces jointes des messages jamais extraites ni gardées ; `rg -n -i 'multipart/form-data\|busboy\|formidable\|multer' lib socle/src` → 0 ; corps bornés (voir SEC-API-010) |
| SEC-FILE-003 | aucun fichier d’utilisateur écrit ; seule écriture : la base, nommée par le serveur |
| SEC-FILE-004 | aucun fichier d’utilisateur servi : seuls `public/` et `socle/web` |
| SEC-FILE-005 | aucun fichier d’utilisateur stocké : aucun envoi de fichier : corps JSON seulement (`socle/src/http.js:122`) ; pièces jointes des messages jamais extraites ni gardées ; `rg -n -i 'multipart/form-data\|busboy\|formidable\|multer' lib socle/src` → 0 |
| SEC-FILE-006 | aucun fichier partagé entre utilisateurs |
| SEC-FILE-007 | aucune image acceptée ; les images des messages HTML sont retirées, jamais chargées (`lib/html.js:29`) |
| SEC-FILE-008 | aucun import depuis une adresse : CACHET ne télécharge rien ; ses connexions sortantes (IMAP, SMTP, webhook, Telegram) suivent SEC-CSRF-004 |
| SEC-PAY-001 | `rg -n -i 'stripe\|paypal\|checkout\|invoice\|payout\|refund' lib public socle/src socle/web` → 0 : aucun paiement |
| SEC-PAY-002 | `rg -n -i 'stripe\|paypal\|checkout\|invoice\|payout\|refund' lib public socle/src socle/web` → 0 : aucun paiement |
| SEC-PAY-003 | `rg -n -i 'stripe\|paypal\|checkout\|invoice\|payout\|refund' lib public socle/src socle/web` → 0 : aucun paiement |
| SEC-PAY-004 | `rg -n -i 'stripe\|paypal\|checkout\|invoice\|payout\|refund' lib public socle/src socle/web` → 0 : aucun paiement |
| SEC-PAY-005 | `rg -n -i 'stripe\|paypal\|checkout\|invoice\|payout\|refund' lib public socle/src socle/web` → 0 : aucun paiement |
| SEC-NEXT-001 | Node sans cadriciel : `package.json:5`, aucune dépendance ; `rg -n -i 'next/\|nextjs\|use server\|vercel' lib public socle/src socle/web` → 0 |
| SEC-NEXT-002 | Node sans cadriciel : `package.json:5`, aucune dépendance ; `rg -n -i 'next/\|nextjs\|use server\|vercel' lib public socle/src socle/web` → 0 |
| SEC-NEXT-003 | Node sans cadriciel : `package.json:5`, aucune dépendance ; `rg -n -i 'next/\|nextjs\|use server\|vercel' lib public socle/src socle/web` → 0 |
| SEC-NEXT-004 | Node sans cadriciel : `package.json:5`, aucune dépendance ; `rg -n -i 'next/\|nextjs\|use server\|vercel' lib public socle/src socle/web` → 0 |
| SEC-NEXT-005 | Node sans cadriciel : `package.json:5`, aucune dépendance ; `rg -n -i 'next/\|nextjs\|use server\|vercel' lib public socle/src socle/web` → 0 |
| SEC-NEXT-006 | Node sans cadriciel : `package.json:5`, aucune dépendance ; `rg -n -i 'next/\|nextjs\|use server\|vercel' lib public socle/src socle/web` → 0 |
| SEC-NEXT-007 | Node sans cadriciel : `package.json:5`, aucune dépendance ; `rg -n -i 'next/\|nextjs\|use server\|vercel' lib public socle/src socle/web` → 0 |
| SEC-NEXT-008 | Node sans cadriciel : `package.json:5`, aucune dépendance ; `rg -n -i 'next/\|nextjs\|use server\|vercel' lib public socle/src socle/web` → 0 |
| SEC-NEXT-009 | Node sans cadriciel : `package.json:5`, aucune dépendance ; `rg -n -i 'next/\|nextjs\|use server\|vercel' lib public socle/src socle/web` → 0 |
| SEC-BAAS-001 | `rg -n -i 'supabase\|firebase\|firestore\|postgrest' lib public socle` → 0 ; base SQLite embarquée côté serveur : `lib/base.js:41` |
| SEC-BAAS-002 | `rg -n -i 'supabase\|firebase\|firestore\|postgrest' lib public socle` → 0 ; base SQLite embarquée côté serveur : `lib/base.js:41` |
| SEC-BAAS-003 | `rg -n -i 'supabase\|firebase\|firestore\|postgrest' lib public socle` → 0 ; base SQLite embarquée côté serveur : `lib/base.js:41` |
| SEC-BAAS-004 | `rg -n -i 'supabase\|firebase\|firestore\|postgrest' lib public socle` → 0 ; base SQLite embarquée côté serveur : `lib/base.js:41` |
| SEC-BAAS-005 | `rg -n -i 'supabase\|firebase\|firestore\|postgrest' lib public socle` → 0 ; base SQLite embarquée côté serveur : `lib/base.js:41` |
| SEC-BAAS-006 | `rg -n -i 'supabase\|firebase\|firestore\|postgrest' lib public socle` → 0 ; base SQLite embarquée côté serveur : `lib/base.js:41` |
| SEC-BAAS-007 | `rg -n -i 'supabase\|firebase\|firestore\|postgrest' lib public socle` → 0 ; base SQLite embarquée côté serveur : `lib/base.js:41` |
| SEC-BAAS-008 | `rg -n -i 'supabase\|firebase\|firestore\|postgrest' lib public socle` → 0 ; base SQLite embarquée côté serveur : `lib/base.js:41` |
| SEC-BAAS-009 | `rg -n -i 'supabase\|firebase\|firestore\|postgrest' lib public socle` → 0 ; base SQLite embarquée côté serveur : `lib/base.js:41` |
| SEC-BAAS-010 | `rg -n -i 'supabase\|firebase\|firestore\|postgrest' lib public socle` → 0 ; base SQLite embarquée côté serveur : `lib/base.js:41` |
| SEC-BAAS-011 | `rg -n -i 'supabase\|firebase\|firestore\|postgrest' lib public socle` → 0 ; base SQLite embarquée côté serveur : `lib/base.js:41` |
| SEC-BE-005 | aucun Django : serveur Node seulement (`rg --files -g '*.py'` → 0) |
| SEC-BE-006 | aucun Flask ni FastAPI : serveur Node seulement (`rg --files -g '*.py'` → 0) |
| SEC-BE-007 | aucun code Python : `rg --files -g '*.py'` → 0 |
| SEC-BE-008 | aucun PHP : `rg --files -g '*.php'` → 0 |
| SEC-WP-001 | application Node écrite ici : `rg -n -i 'wordpress\|wp-admin\|bubble\|webflow\|airtable' lib public socle` → 0 |
| SEC-WP-002 | application Node écrite ici : `rg -n -i 'wordpress\|wp-admin\|bubble\|webflow\|airtable' lib public socle` → 0 |
| SEC-WP-003 | application Node écrite ici : `rg -n -i 'wordpress\|wp-admin\|bubble\|webflow\|airtable' lib public socle` → 0 |
| SEC-WP-004 | application Node écrite ici : `rg -n -i 'wordpress\|wp-admin\|bubble\|webflow\|airtable' lib public socle` → 0 |
| SEC-WP-005 | application Node écrite ici : `rg -n -i 'wordpress\|wp-admin\|bubble\|webflow\|airtable' lib public socle` → 0 |
| SEC-WP-006 | application Node écrite ici : `rg -n -i 'wordpress\|wp-admin\|bubble\|webflow\|airtable' lib public socle` → 0 |
| SEC-WP-007 | application Node écrite ici : `rg -n -i 'wordpress\|wp-admin\|bubble\|webflow\|airtable' lib public socle` → 0 |
| SEC-WP-008 | application Node écrite ici : `rg -n -i 'wordpress\|wp-admin\|bubble\|webflow\|airtable' lib public socle` → 0 |
| SEC-INFRA-005 | aucun stockage objet : `rg -n -i 's3\|aws-sdk\|gcs\|azure\|bucket' lib socle/src` → 0 |
| SEC-INFRA-006 | aucun nuage : service auto-hébergé, aucune clé IAM |
| SEC-INFRA-009 | aucune infrastructure décrite en code : `find . -name '*.tf' -o -name 'Pulumi.yaml'` → 0 fichier |
| SEC-LLM-001 | CACHET n’appelle aucun modèle et n’en expose aucun : `rg -n -i 'openai\|anthropic\|ollama\|mistral\|completions\|embeddings\|/v1/chat' lib public socle/src` → 0 ; les actions offertes à l’assistant du Hub sont celles du manifeste, envoi d’un courriel en validation humaine (`hub.json:611`) |
| SEC-LLM-002 | CACHET n’appelle aucun modèle et n’en expose aucun : `rg -n -i 'openai\|anthropic\|ollama\|mistral\|completions\|embeddings\|/v1/chat' lib public socle/src` → 0 ; les actions offertes à l’assistant du Hub sont celles du manifeste, envoi d’un courriel en validation humaine (`hub.json:611`) |
| SEC-LLM-003 | CACHET n’appelle aucun modèle et n’en expose aucun : `rg -n -i 'openai\|anthropic\|ollama\|mistral\|completions\|embeddings\|/v1/chat' lib public socle/src` → 0 ; les actions offertes à l’assistant du Hub sont celles du manifeste, envoi d’un courriel en validation humaine (`hub.json:611`) |
| SEC-LLM-004 | CACHET n’appelle aucun modèle et n’en expose aucun : `rg -n -i 'openai\|anthropic\|ollama\|mistral\|completions\|embeddings\|/v1/chat' lib public socle/src` → 0 ; les actions offertes à l’assistant du Hub sont celles du manifeste, envoi d’un courriel en validation humaine (`hub.json:611`) |
| SEC-LLM-005 | CACHET n’appelle aucun modèle et n’en expose aucun : `rg -n -i 'openai\|anthropic\|ollama\|mistral\|completions\|embeddings\|/v1/chat' lib public socle/src` → 0 ; les actions offertes à l’assistant du Hub sont celles du manifeste, envoi d’un courriel en validation humaine (`hub.json:611`) |
| SEC-LLM-006 | CACHET n’appelle aucun modèle et n’en expose aucun : `rg -n -i 'openai\|anthropic\|ollama\|mistral\|completions\|embeddings\|/v1/chat' lib public socle/src` → 0 ; les actions offertes à l’assistant du Hub sont celles du manifeste, envoi d’un courriel en validation humaine (`hub.json:611`) |
| SEC-LLM-007 | CACHET n’appelle aucun modèle et n’en expose aucun : `rg -n -i 'openai\|anthropic\|ollama\|mistral\|completions\|embeddings\|/v1/chat' lib public socle/src` → 0 ; les actions offertes à l’assistant du Hub sont celles du manifeste, envoi d’un courriel en validation humaine (`hub.json:611`) |
| SEC-LLM-008 | CACHET n’appelle aucun modèle et n’en expose aucun : `rg -n -i 'openai\|anthropic\|ollama\|mistral\|completions\|embeddings\|/v1/chat' lib public socle/src` → 0 ; les actions offertes à l’assistant du Hub sont celles du manifeste, envoi d’un courriel en validation humaine (`hub.json:611`) |
| SEC-TEST-008 | ni argent, ni santé, ni large public : service auto-hébergé pour quelques opérateurs invités ; `rg -n -i 'stripe\|paypal\|checkout\|invoice\|payout\|refund' lib public socle/src socle/web` → 0 : aucun paiement |

## Anonymity (REQ-ANON-001 to -010)
Arbre de travail : 11 occurrences de la liste d’anonymat, toutes une sous-chaîne d’un mot du vocabulaire WebAuthn dans trois fichiers du socle embarqué (aucun terme identifiant ; en mot entier : 0). Historique local complet (44 commits, une branche, aucune étiquette, aucune remise, aucun objet inaccessible après nettoyage) : 11 occurrences en sous-chaîne, toutes ce même mot du socle, 0 en mot entier. Le fuseau horaire géographique que la 1.0 fixait dans son image, son Compose et son exemple d’environnement a été retiré du commit de départ lui-même : ce dépôt n’a jamais été publié, son historique a été réécrit pour qu’aucun commit ne le porte. Messages, auteurs et validateurs : 0 occurrence ; une seule identité, toutes les dates en UTC, aucune mention d’outil. Binaires de l’historique : quatre images PNG/ICO de la 1.0, sans bloc de métadonnées. Hors de ce dépôt : la 1.0 telle qu’elle tourne et son éventuel dépôt d’origine (privé ou local, non fourni) n’ont pas pu être balayés → H12, détail dans le rapport d’anonymat hors dépôt. Le balayage est fait sur motifs et sur une liste finie : il ne prouve pas l’absence de ce que la liste ne nomme pas.

## Human actions required
Ce qu’aucun agent ne peut faire à la place de l’exploitant. Cette liste bloque la mise en production tant qu’elle n’est pas vide.

| # | Action | Contrôles | Étapes |
|---|---|---|---|
| H1 | Servir CACHET en HTTPS | REQ-WEB-001, SEC-HDR-001, SEC-INFRA-001, SEC-TEST-005 | Dans le Hub : Relay (ou certificat de l’autorité locale) devant CACHET ; déclarer l’adresse du relais dans « Relais de confiance » (SOCLE_PROXYS) ; « Accès sans HTTPS » à Non ; « Adresse publique » en https:// ; vérifier `curl -sI https://<cachet>/ \| grep -i strict-transport-security` ; noter le résultat de testssl.sh. Installé seul : relais TLS devant le port publié, mêmes variables dans `.env`. Les services qui appellent CACHET (Aselia) passent alors en https://. |
| H2 | Relais SMTP des alertes et domaines d’expédition | REQ-AUTH-014, SEC-PAY-007, SEC-LOG-004 | Réglages avancés de CACHET dans le Hub (ou `SOCLE_SMTP_*`) : relais, port, chiffrement, identifiants, expéditeur, adresse publique ; chaque administrateur ajoute puis confirme son adresse dans Sécurité → Alertes par courriel. Pour chaque domaine depuis lequel CACHET envoie (boîtes et alias) : SPF, DKIM et DMARC au moins en quarantine, vérifiés par `dig TXT _dmarc.<domaine>` et un testeur de courrier. |
| H3 | GitHub | REQ-CI-001 … -005, GOV-003, GOV-005, SEC-INFRA-007/008, SEC-TEST-001 … -003, SEC-DEP-002/006/008 | Activer les Actions ; Settings → Branches : protéger `main` (pas de poussée forcée, contrôles requis : essais, image, secrets, identite, anonymat, analyse) ; Code security : Dependabot alerts, secret scanning et push protection, private vulnerability reporting ; Packages : rendre public le paquet `cachet` après la première publication (sinon le Hub construit l’image lui-même) ; 2FA sur le compte GitHub et chez chaque fournisseur (courriel des boîtes, Telegram). |
| H4 | Liste d’anonymat | REQ-ANON-003, REQ-CI-004, REQ-CI-001 | Sur le poste : gitleaks installé ; `~/.config/git/denylist.txt`, un terme par ligne ; un crochet global `pre-commit` qui refuse un commit dont le diff contient un terme de la liste, puis `git config --global core.hooksPath ~/.config/git/hooks`. Sur GitHub : secret de dépôt `LISTE_ANONYMAT` avec les mêmes termes. Vérifier : un commit d’essai portant un terme est refusé par le crochet, puis par la vérification. Le contrôle compare en sous-chaîne : un terme court contenu dans un mot courant du socle bloquerait la vérification (voir le rapport d’anonymat). |
| H5 | Brûler les secrets de la 1.0 | SEC-SECRETS-006 | Après la reprise vérifiée : supprimer `config.json.v1-reprise-*` et `state.json.v1-reprise-*` du volume, vider « CACHET_SECRET de la 1.0 » et redéployer ; régénérer les deux clés d’API (Réglages → Liaison) et les reposer dans Aselia ; changer chez chaque fournisseur le mot de passe d’application des boîtes qui étaient réglées « sans TLS » ou « accepter un auto-signé », puis le ressaisir dans CACHET ; régénérer le jeton Telegram auprès de BotFather s’il était posé ; changer le secret du webhook côté Aselia et côté CACHET. |
| H6 | Secrets par environnement | REQ-CFG-003, SEC-SECRETS-005, GOV-004 | Une clé maîtresse, un jeton du Hub, des clés d’API et des mots de passe d’application de boîtes pour la VM d’essai, d’autres pour la production ; aucune boîte de production relevée par la VM d’essai. |
| H7 | Chiffrement des disques | REQ-DATA-002, SEC-DB-003, SEC-PRIV-005 | LUKS (ou chiffrement du stockage de l’hyperviseur) sur l’hôte qui porte le volume de CACHET. |
| H8 | Sauvegardes et exercices | REQ-DATA-003, SEC-DB-006, REQ-DATA-005 | Paire RSA 3072 bits créée hors de la machine de CACHET (`openssl genpkey -algorithm RSA -pkeyopt rsa_keygen_bits:3072 -out sauvegarde.pem && openssl pkey -in sauvegarde.pem -pubout -out sauvegarde.pub`) ; cron quotidien `docker exec -i <cachet> node lib/cli.js sauvegarde < sauvegarde.pub > cachet-$(date -u +%F).sauv` ; copie hors hôte, trente jours ; restauration réelle sur la VM d’essai avec `node lib/cli.js restaurer`, datée ici ; dérouler une fois le runbook ci-dessous. |
| H9 | Hôtes | SEC-INFRA-003 | Pare-feu (seuls les ports publiés), SSH par clé sans root, mises à jour de sécurité automatiques, fail2ban. |
| H10 | Disponibilité vue de l’extérieur | SEC-LOG-005 | Une sonde externe sur `/api/health` et une alerte d’expiration du certificat, ou décision écrite : service de réseau local seulement, sondes du Hub suffisantes. |
| H11 | Journaux centralisés | SEC-LOG-003 | Transférer les journaux du conteneur (dont les lignes `"journal":"cachet"`) vers un collecteur hors de l’hôte : pilote de journalisation Docker ou agent. |
| H12 | Dépôt d’origine de la 1.0 | REQ-ANON-002 | Aucun dépôt public `CodexX64/cachet` n’existe ; ce dépôt-ci part d’un commit de départ propre, sans l’historique de la 1.0. Si la 1.0 vit dans un autre dépôt (privé, local, ou sous un autre nom), ne jamais le publier ni le pousser par-dessus : il porte au moins le fuseau horaire géographique de l’image ; publier ce dépôt-ci, créé neuf. Détail dans le rapport d’anonymat hors dépôt. |
| H13 | Domaine | REQ-ANON-009, SEC-INFRA-002 | Si CACHET reçoit un nom public : protection WHOIS, verrou du registraire, 2FA, enregistrement CAA, suppression des enregistrements orphelins. |
| H14 | Construction et crible au déploiement | SEC-INFRA-004, SEC-TEST-003, SEC-TEST-004 | L’image n’a pas pu être construite pendant cette passe (registre Docker injoignable depuis l’environnement de travail) : sur la VM, `trivy image` sur l’image que le Hub a construite (`docker images \| grep cachet`) sans CRITICAL ni HIGH corrigeable ; `zap-baseline.py -t http://<vm>:<port>` ; résultats notés ici. |
| H15 | Sous-traitants hors UE | SEC-PRIV-006 | Fournisseurs de courriel des boîtes (Gmail, Outlook, iCloud…), Telegram et relais SMTP : accepter leur accord de traitement, ou choisir des fournisseurs européens ou auto-hébergés. |
| H16 | Clé maîtresse hors ligne | REQ-DATA-003, SEC-DB-006 | Garder une copie hors ligne de SOCLE_CLE (coffre du Hub, ou `secrets/socle_cle` installé seul), à part des sauvegardes de la base : sans elle, une sauvegarde restaurée ne rouvre ni les mots de passe des boîtes ni les secrets TOTP. |

Orthographe du pseudonyme : le manuel nomme l’identité « Codex64 » ; les commits, la licence et le compte GitHub portent la forme du compte, identique dans tout l’historique. Changer maintenant créerait une seconde identité dans le journal git ; à trancher par l’exploitant.

## Secrets inventory
| Secret | Where it lives | Scope | Rotation procedure | Last rotated |
|---|---|---|---|---|
| SOCLE_CLE (tirée par le Hub, ou par l’exploitant installé seul) | coffre du Hub → variable du conteneur ; installé seul : secret Docker `secrets/socle_cle`, hors du volume | scelle les mots de passe des boîtes, la clé et le secret du webhook, le jeton Telegram, les secrets TOTP | README, « Tourner la clé maîtresse » : rescellement automatique au démarrage, journal `coffre.tourne` | création à l’installation |
| CACHET_HUB_TOKEN (HUB_TOKEN du Hub) | coffre du Hub → variable | courrier, tickets et envoi, comme la clé complète ; jamais les boîtes, règles, réglages, clés ni comptes | régénérer dans le Hub, redéployer CACHET (l’ancien cesse au démarrage) ; les jetons dérivés `cer_…` changent avec lui | création à l’installation |
| SOCLE_JETON_ADMIN_HUB (HUB_ADMIN_TOKEN) | coffre du Hub → variable | gestion des comptes depuis « Comptes des services » | régénérer dans le Hub, redéployer | création à l’installation |
| Clé d’API complète `pk_…` et clé d’envoi `sk_…` (tirées par CACHET) | empreinte SHA-256 dans la base ; la valeur chez le service qui l’utilise (Aselia) | complète : courrier, tickets, envoi ; envoi : `POST /api/send` seulement | Réglages → Liaison → Régénérer (administrateur, renfort) : la nouvelle se voit une fois, l’ancienne cesse aussitôt | à la création ; les clés de la 1.0 sont reprises par leur empreinte (H5) |
| Mots de passe d’application des boîtes (émis par chaque fournisseur) | base, scellés sous SOCLE_CLE, liés à leur boîte | relève IMAP et envoi SMTP de la boîte | changer chez le fournisseur, ressaisir dans Boîtes (administrateur, renfort) | à la pose (H5 pour ceux de la 1.0) |
| Clé et secret du webhook (choisis par l’administrateur) | base, scellés sous SOCLE_CLE | authentifier et signer les appels vers le service externe | changer côté service et dans Réglages → Webhook (renfort) | à la pose |
| Jeton Telegram (émis par BotFather) | base, scellé sous SOCLE_CLE | messages du bot vers la discussion réglée | `/revoke` auprès de BotFather, ressaisir dans Réglages (renfort) | à la pose |
| SOCLE_JETON_INSTALLATION (tiré par le socle) | journaux du conteneur au premier démarrage | création du premier compte, puis inutile | aucun : invalide dès qu’un compte existe | — |
| SOCLE_SMTP_MOTDEPASSE (émis par le fournisseur du relais) | coffre du Hub → variable ; installé seul : `.env` | relais des alertes de sécurité | changer chez le fournisseur, coller dans le Hub, redéployer | à la mise en service (H2) |
| Clé privée des sauvegardes (tirée par l’exploitant) | hors de la machine de CACHET, jamais dans le conteneur | relit les sauvegardes | nouvelle paire ; garder l’ancienne privée tant que ses sauvegardes sont conservées | à créer (H8) |
| CACHET_SECRET_V1 (l’ancien CACHET_SECRET) | coffre du Hub → variable, le temps de la reprise | rouvre une fois les secrets de la 1.0 | aucun : à vider après la reprise (H5) | — |
| SOCLE_POIVRE (s’il en est posé un) | non posé par défaut | poivre HMAC des mots de passe | le nouveau dans `SOCLE_POIVRE`, l’ancien dans `SOCLE_POIVRE_ANCIEN` : chaque mot de passe passe au nouveau à la connexion suivante | — |

## Incident runbook
Détecter : alertes « vigie » dans la page Sécurité des administrateurs (et par courriel, H2) ; refus : `docker logs <cachet> | grep '"resultat":"refus"'` ; clés refusées : `docker logs <cachet> | grep connexion.cle` ; boîtes en échec : sonde `boxes-failing` du Hub.

```bash
# 1. Fermer toutes les sessions sauf la sienne (renfort demandé)
#    Page Comptes → « Fermer toutes les sessions », ou :
curl -X POST -H 'Content-Type: application/json' -H "X-CSRF: $CSRF" -b "$COOKIE" https://<cachet>/api/compte/admin/sessions/fermer-tout -d '{}'
# 2. Couper les machines : Réglages → Liaison → régénérer la clé complète et la clé d'envoi (les anciennes cessent aussitôt)
# 3. Couper le Hub : régénérer son jeton de service (HUB_TOKEN) → Redéployer
# 4. Couper les sorties : Réglages → Webhook désactivé ; Telegram désactivé ; boîtes suspectes « désactivées »
# 5. Tourner les secrets touchés : voir « Secrets inventory » (mots de passe des boîtes chez chaque fournisseur d'abord)
# 6. Forcer un nouveau mot de passe : Page Comptes → compte → « Réinitialiser » (le second facteur reste exigé)
# 7. Restaurer, depuis le poste qui garde la clé privée, puis remettre la base dans le volume
node lib/cli.js restaurer sauvegarde.pem cachet.db < cachet-AAAA-MM-JJ.sauv
docker stop <cachet> && docker run --rm -v <volume>:/data -v "$PWD":/b busybox sh -c 'cp /b/cachet.db /data/cachet.db && rm -f /data/cachet.db-wal /data/cachet.db-shm && chown 10001:10001 /data/cachet.db && chmod 600 /data/cachet.db' && docker start <cachet>
#    Base sauvegardée avant une rotation : poser la clé d'alors dans SOCLE_CLE_ANCIENNE avant de démarrer
# 8. Vérifier la chaîne du journal : Page Comptes → Journal de sécurité (« chaîne intacte »)
```
Qui : l’exploitant de l’instance tient chaque étape ; supports pour révoquer : console du Hub (jeton de service), fournisseurs de courriel des boîtes (mots de passe d’application), BotFather (jeton Telegram), support.github.com pour le dépôt. Communiquer : prévenir les comptes concernés ; si des données personnelles ont pu être lues (courrier relevé, comptes), notifier l’autorité de contrôle sous 72 heures à compter de la découverte (heure de découverte, nature, comptes touchés, mesures prises), et les personnes si le risque est élevé. Revue après incident : cause, chronologie, contrôle qui a manqué, correctif et essai de non-régression.

## Inventory
Routes publiques : `GET /api/health` (`{ok:true}` seulement), `GET /.well-known/security.txt`, `GET /api/compte/etat`, cérémonies de connexion et d’installation du socle (`/api/compte/connexion*`, `/api/compte/installation`, `/api/compte/jeton*`, `/api/compte/courriel/verifier`, `/api/compte/pas-moi/lien`, `/api/compte/deconnexion`), fichiers de `public/` et `socle/web/` (tout segment commençant par un point → 404). Preuve de machine (clé complète, clé d’envoi, jeton du Hub, jeton dérivé) : routes de lecture et de traitement du courrier et des tickets, `POST /api/send`, chacune avec sa portée. Session : 39 routes sous `/api/` (deux alias `/api/ping` et `/api/status` comptés une fois), chacune avec son rôle déclaré et vérifié dans le gestionnaire (table figée dans l’essai « balayage »), plus les routes de comptes du socle.

Données : `cachet.db` (comptes, sessions, jetons hachés, journal chaîné du socle ; boîtes, alias, dossiers, règles, réglages, secrets scellés, empreintes des clés ; courrier relevé et envoyé, tickets, journal des relèves — sensibilité : personnelle et opérationnelle), volume `/data` en 0700, base en 0600.

Tiers (choisis par l’exploitant) : les serveurs IMAP et SMTP des boîtes (TLS vérifié ou épinglé), le service du webhook s’il est activé, Telegram s’il est activé, le relais SMTP des alertes s’il est configuré. Aucune mesure d’audience ni service en ligne imposé.

## Appendix B sweep
Relancé à chaque génération de ce fichier (bash, LC_ALL=C.UTF-8), le 2026-10-23, sur l’arbre et tout l’historique de 2.0.1 ; B.2.6 et B.4 contre une instance locale démarrée pour l’occasion. Un résultat différent de celui qui a été relu arrête la génération. B.5 est dans NO-VIBE.md.

| # | Commande | Résultat | Justification |
|---|---|---|---|
| B.1.1 | `git log --all --format='%an <%ae>' \| sort -u` | `CodexX64 <CodexX64@users.noreply.github.com>` | le pseudonyme seul |
| B.1.2 | `git log --all --format='%cn <%ce>' \| sort -u` | `CodexX64 <CodexX64@users.noreply.github.com>` | idem pour le validateur |
| B.1.3 | `git log --all --format='%B' \| rg -in 'co-authored-by\|generated (by\|with)\|assistant\|as an ai' \| wc -l` | `0` |  |
| B.1.4 | `find . \( -name .ai -o -name .cursor -o -name .aider -o -name .continue -o -name .windsurfrules \) -print \| wc -l` | `0` |  |
| B.1.5 | `find . -regextype posix-extended -regex '.*/(CLAUDE\|AGENTS?\|PROMPTS?\|GEMINI)\.md' -print \| wc -l` | `0` |  |
| B.1.6 | `git log --all --name-only --format= \| sort -u \| rg -i '(^\|/)(CLAUDE\|AGENTS?\|PROMPTS?\|GEMINI)\.md$\|copilot-instructions\|\.cursor\|\.aider' \| wc -l` | `0` | aucun fichier de consignes d’outil dans tout l’historique |
| B.1.7 | `rg -n 'copilot-instructions' . -g '!SECURITY.md' -g '!NO-VIBE.md' \| wc -l` | `0` |  |
| B.1.8 | git grep -nIiE (motif « personal infrastructure, paths and networks » de l’annexe B.1) hors des deux fichiers de conformité | `2` | le nom de fichier `.env.local` du .gitignore, et la plage privée générique `172.16.0.0/12` proposée par défaut dans le manifeste pour les relais de confiance du réseau Docker du Hub (`hub.json`) : aucune adresse d’un réseau réel |
| B.1.9 | git log --all -p (hors des deux fichiers de conformité) filtré par le motif « infrastructure personnelle » de l’annexe B.1, compté | `4` | le mot « cadenas » (pictogramme de la page Sécurité du socle), qui contient le motif ; aucun terme d’infrastructure |
| B.1.10 | `git log --all --format='%aI' \| rg -v '\+00:00' \| wc -l` | `0` | tout l’historique en UTC |
| B.1.11 | `git log --all --format='%cI' \| rg -v '\+00:00' \| wc -l` | `0` | idem pour le validateur |
| B.1.12 | git grep de tout l’historique (`$(git rev-list --all)`) avec le motif des chemins de poste et d’espaces de travail d’outils (gardé hors dépôt) | `0` | aucun chemin d’un poste ni d’un espace de travail d’outil dans aucun arbre |
| B.1.13 | `git log --all --name-only --format= \| sort -u \| rg -i '\.(png\|jpe?g\|pdf\|mp4\|gif\|webp\|ico)$'` | `public/favicon.ico public/favicon.png public/logo.png public/mark.png` | les quatre images de la 1.0 ; exiftool -a -G1 n’y lit ni auteur, ni créateur, ni position, ni hôte (B.1.13b) |
| B.1.13b | `exiftool -a -G1 public/*.png public/*.ico \| rg -ci 'author\|creator\|gps\|host\|artist\|copyright\|software'` | `0` | faute d’exiftool, les blocs de métadonnées PNG (tEXt, iTXt, zTXt, eXIf) sont relus directement : aucun |
| B.1.14 | git log --all -p filtré par la liste d’anonymat (hors dépôt), en mot entier, compté | `0` | en sous-chaîne, seul un mot du vocabulaire WebAuthn du socle y répond (voir « Anonymity ») |
| B.1.15 | messages, auteurs et validateurs de tout l’historique filtrés par la liste d’anonymat, comptés | `0` |  |
| B.2.1 | `gitleaks git --no-banner --redact . 2>&1 \| tail -1` | `no leaks found` | tout l’historique |
| B.2.2 | `gitleaks dir --no-banner --redact . 2>&1 \| tail -1` | `no leaks found` | arbre de travail |
| B.2.3 | `git grep -nIiE '(api[_-]?key\|secret\|token\|password\|bearer)\s*[=:]\s*["'][^"']{8,}' (hors des deux fichiers de conformité) \| wc -l` | `6` | mots de passe, jetons et secrets fabriqués pour les essais du service et du socle (boîtes simulées, relais d’essai, vecteur publié de la RFC 6238) ; aucune vraie clé : B.2.1 et B.2.2 |
| B.2.4 | `git grep -nI -e '-----BEGIN (RSA\|EC\|OPENSSH\|PGP) PRIVATE' (hors des deux fichiers de conformité) \| wc -l` | `0` | les certificats d’essai sont tirés à la volée par openssl, jamais écrits dans le dépôt |
| B.2.5 | `rg -ni 'sk_live\|service_role\|xox[baprs]-\|-----BEGIN' public socle/web \| wc -l` | `0` | aucune étape de construction : le navigateur reçoit `public/` et `socle/web` tels quels |
| B.3.1 | `rg -n 'dangerouslySetInnerHTML\|innerHTML *=\|outerHTML *=\|document\.write' . -g '!SECURITY.md' -g '!NO-VIBE.md'` | `./socle/web/gabarit.js:111 ./socle/web/gabarit.js:115` | le gabarit du socle seul : balisage écrit dans le code, valeurs posées en nœuds texte ou attributs (SEC-XSS-001) ; plus aucune dans l’interface de CACHET |
| B.3.2 | `rg -n 'eval\(\|new Function\(\|execSync\|child_process\|os\.system\|subprocess.*shell=True' . -g '!SECURITY.md' -g '!NO-VIBE.md'` | `1 ./socle/essai/smtp.js 1 ./socle/test/crypto.test.js` | essais et outils du socle seulement (certificats d’essai tirés par openssl, binaire fixe, arguments en tableau, sans shell) ; aucune occurrence dans `lib/`, `public/`, `socle/src`, `socle/web` |
| B.3.3 | `rg -n '[^.]\bexec\(' . -g '!SECURITY.md' -g '!NO-VIBE.md' \| wc -l` | `0` |  |
| B.3.4 | `rg -n 'f"SELECT\|"SELECT .*" *\+\|\$\{.*\} *FROM\|\.raw\(\|query\(.*\+ *req\.' . -g '!SECURITY.md' -g '!NO-VIBE.md' \| wc -l` | `0` |  |
| B.3.5 | `rg -n 'Math\.random\|uuidv1\|new Random\(\)' . -g '!SECURITY.md' -g '!NO-VIBE.md'` | `0 ligne` | les valeurs tirées viennent de `crypto.randomBytes` et `crypto.getRandomValues` |
| B.3.6 | `rg -n 'verify *= *False\|rejectUnauthorized: *false\|InsecureSkipVerify' . -g '!SECURITY.md' -g '!NO-VIBE.md'` | `./lib/tls.js:42` | une ligne, justifiée dans le tableau « B.3 — TLS sans vérification par autorité » ci-dessous |
| B.3.7 | `rg -n 'jwt\.decode\(\|algorithms: *\[.*none\|verify: *false' . -g '!SECURITY.md' -g '!NO-VIBE.md' \| wc -l` | `0` |  |
| B.2.6 | `curl -s -o /dev/null -w '%{http_code}' http://localhost:18157/.env` | `404` | instance locale ; tout segment caché répond 404 |
| B.4.1 | `curl -sI http://localhost:18157/ \| rg -i 'content-security\|x-content-type\|referrer-policy\|permissions-policy\|x-frame\|cross-origin' \| wc -l` | `7` | CSP à nonce sans joker, nosniff, no-referrer, DENY, COOP et CORP same-origin, Permissions-Policy ; HSTS dès que la requête est chiffrée (H1) |
| B.4.2 | `curl -sI http://localhost:18157/ \| rg -i '^(server\|x-powered-by\|x-aspnet\|x-generator)' \| wc -l` | `0` |  |
| B.4.3 | `curl -sI -H 'Origin: https://evil.example' http://localhost:18157/api/state \| rg -i access-control \| wc -l` | `0` | aucune origine déclarée : aucun CORS |
| B.4.4 | `curl -sI 'http://localhost:18157/login?next=https://evil.example' \| rg -i '^location' \| wc -l` | `0` | aucune redirection : 404 |
| B.4.5 | `curl -s -o /dev/null -w '%{http_code}' http://localhost:18157/.git/config` | `404` |  |
| B.4.6 | `curl -s -o /dev/null -w '%{http_code}' -X GET http://localhost:18157/api/poll` | `405` | relever est un POST ; un GET ne change rien |
| B.4.7 | `for i in $(seq 1 30); do curl -s -o /dev/null -w '%{http_code} ' -X POST http://localhost:18157/api/compte/connexion -H 'Content-Type: application/json' -H 'Origin: http://localhost:18157' -d '{"identifiant":"quelquun","motDePasse":"mauvais mot de passe"}'; done \| tr ' ' '\n' \| sort \| uniq -c` | `3 401 27 428` | trois échecs, puis preuve de travail exigée (428) ; 429 et verrouillage au-delà |
| B.4.8 | quarante `GET /api/state` avec une clé d’API inventée, codes comptés (la commande exacte cite une clé fabriquée : elle reste dans le générateur, hors dépôt) | `10 401 30 429` | une clé inventée : 401, puis 429 une fois le plafond d’échecs de l’adresse atteint |

### B.3 — TLS sans vérification par autorité, ligne à ligne
Chaque ligne rendue par la commande B.3.6, avec sa justification ; une ligne sans justification arrête la génération.

| Ligne | Ce qu’elle est | Pourquoi elle est admise |
|---|---|---|
| `lib/tls.js:42` | la connexion TLS vers un serveur IMAP ou SMTP | la vérification n’est pas coupée, elle est faite à la main juste après la poignée de main, avant le moindre octet applicatif : certificat reconnu par les autorités et valable pour le nom (`s.authorized`), ou empreinte SHA-256 identique à celle épinglée par l’administrateur ; sinon la socket est détruite et l’empreinte vue est rendue pour être vérifiée (`lib/tls.js:33`) ; la seule confiance au premier usage est la reprise d’une boîte « accepter un auto-signé » de la 1.0, qui retient la première empreinte vue. Essais `test/run.js:116`, `test/run.js:121`, `test/run.js:135`, `test/run.js:127` |

## Exploratory probing (SEC-TEST-007)
Sondage exploratoire du 2026-10-23 sur une instance neuve (vrais comptes administrateur, membre et lecture, boîte relevée sur un serveur IMAP d’essai, relais SMTP d’essai, clés d’API tirées) : 41 cas d’abus tentés, chacun avec la réponse obtenue et celle qu’exige la règle ; un seul écart arrête la génération. Chaque trouvaille est devenue un essai (constats marqués « * »).

| # | Cas d’abus | Tenté | Obtenu | Attendu |
|---|---|---|---|---|
| P1 | anonyme sur l’état | `GET /api/state` | 401 | 401 |
| P2 | anonyme sur la santé | `GET /api/health` : corps | {"ok":true} | {"ok":true} |
| P3 | lecture seule qui ouvre un ticket | `POST /api/tickets` (lecture) | 403 | 403 |
| P4 | lecture seule qui envoie | `POST /api/send` (lecture) | 403 | 403 |
| P5 | membre qui ajoute une boîte | `POST /api/accounts` (membre) | 403 | 403 |
| P6 | membre qui crée une clé d’API | `POST /api/apikey/rotate` (membre) | 403 | 403 |
| P7 | membre qui pose un webhook | `PATCH /api/settings` webhook (membre) | 403 | 403 |
| P8 | clé complète sur les boîtes | `DELETE /api/accounts/<id>` (pk) | 403 | 403 |
| P9 | clé complète sur les clés | `GET /api/apikey` (pk) | 403 | 403 |
| P10 | clé d’envoi qui lit le courrier | `GET /api/messages` (sk) | 401 | 401 |
| P11 | jeton du Hub sur les comptes | `GET /api/compte/admin/comptes` (Hub) | 401 | 401 |
| P12 | jeton dérivé inventé | `GET /api/summary` (cer_x_000…) | 401 | 401 |
| P13 | champ privilégié glissé dans un corps | `PATCH /api/accounts/<id>` {imapPass} | 400 | 400 |
| P14 | rôle glissé dans un ticket | `POST /api/tickets` {subject, role: "admin"} | 400 | 400 |
| P15 | corps de 2 Mio | `POST /api/tickets`, 2 Mio | 413 | 413 |
| P16 | corps en formulaire | `POST /api/tickets` en x-www-form-urlencoded | 415 | 415 |
| P17 | écriture de session sans jeton anti-CSRF | `POST /api/folders` sans X-CSRF | 403 | 403 |
| P18 | écriture depuis une autre origine | `POST /api/folders` Origin: https://evil.example | 403 | 403 |
| P19 | hôte IMAP vers les métadonnées | `PATCH /api/accounts/<id>` imapHost 169.254.169.254 | 400 | 400 |
| P20 | commande IMAP glissée dans le dossier | `PATCH /api/accounts/<id>` folder `INBOX"\r\nA1 DELETE "INBOX` | 400 | 400 |
| P21 | destinataire SMTP piégé | `POST /api/send` to `a@b.fr>\r\nRCPT TO:<vol@x.fr` | 400 | 400 |
| P22 | en-tête glissé dans In-Reply-To | `POST /api/send` inReplyTo `<a@b>\r\nBcc: x@y.fr` | 400 | 400 |
| P23 | règle à retour arrière exponentiel | `POST /api/rules` regex `(a+)+$` | 400 | 400 |
| P24 | CORS joker | `PATCH /api/settings` origins ["*"] | 400 | 400 |
| P25 | pré-vol d’une origine non déclarée | `OPTIONS /api/state` Origin: https://evil.example | 403 | 403 |
| P26 | webhook en file:// | `PATCH /api/settings` webhook file:///etc/passwd | 400 | 400 |
| P27 | identifiant de ticket inventé | `GET /api/tickets/TCK-9999` (lecture) | 404 | 404 |
| P28 | identifiant piégé dans le chemin | `GET /api/tickets/%2e%2e%2fapikey` (lecture) | 404 | 404 |
| P29 | préfixe client qui contourne les droits | `GET /api/x/apikey` (pk) | 403 | 403 |
| P30 | fichier caché demandé | `GET /.env` | 404 | 404 |
| P31 | dépôt git demandé | `GET /.git/config` | 404 | 404 |
| P32 | script du message rendu | corps HTML du message relevé : `<script`, `<img`, `onclick` | absent | absent |
| P33 | mot de passe de boîte dans une réponse | `GET /api/state` (admin) : mot de passe en clair ou scellé | absent | absent |
| P34 | message d’un identifiant inventé supprimé | `DELETE /api/messages/inconnu:1` (membre) | 404 | 404 |
| P35 | accusé de 501 identifiants | `POST /api/ack` 501 ids (pk) | 400 | 400 |
| P36 | suppression de boîte sans renfort | `DELETE /api/accounts/<id>` renfort retiré | 403 | 403 |
| P37 | ticket d’un autre statut forcé | `PATCH /api/tickets/<id>` status « supprime » | 400 | 400 |
| P38 | dossier inconnu pour un message | `PATCH /api/messages/<id>` folder inexistant | 400 | 400 |
| P39 | quarante clés inventées | 40 × `GET /api/state` avec une clé inventée, codes comptés | 10×401 30×429 | 10×401 30×429 |
| P40 | numéro de ticket qui se suit | identifiants rendus : `TCK-0001`… ou un identifiant de message `<boîte>:<uid>` | false | false |
| P41 | envoi rejoué sous la même clé | `POST /api/send` deux fois, même `Idempotency-Key`, puis clé de 5 signes | 1 parti / rejoué / 400 | 1 parti / rejoué / 400 |
