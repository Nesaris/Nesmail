# Cachet

Boîte d'arrivée des alertes et suivi des tickets. Relève une ou plusieurs boîtes
IMAP, transforme chaque alerte en ticket structuré (service, machine, urgence),
et répond depuis la bonne adresse.

Node 20+, **aucune dépendance npm**. Clients IMAP et SMTP écrits à la main.

---

## Le principe

Une boîte réglée en **boîte à tickets** possède un alias par service. L'alias
visé détermine le service : c'est déterministe, il n'y a rien à deviner dans le
contenu du message.

| alias | service | urgence par défaut |
|---|---|---|
| `conteneurs@exemple.fr` | conteneurs | critique |
| `supervision@exemple.fr` | supervision | haute |
| `proxy@exemple.fr` | proxy | basse |

Les mots-clés du message peuvent **faire monter** l'urgence, jamais la baisser.
`hors ligne`, `échec`, `timeout` passent en haute ; `boucle`, `oom`, `panic`,
`disque plein` passent en critique. Un « certificat renouvelé » arrivé sur un
alias réglé en basse reste en basse.

Deux alertes de même service, même machine et même objet dans la fenêtre de
dédoublonnage incrémentent le compteur du ticket ouvert au lieu d'en créer un
second.

---

## Démarrage

```bash
cp .env.example .env
echo "CACHET_SECRET=$(openssl rand -hex 32)" >> .env
docker compose up -d
docker compose logs -f cachet     # le mot de passe de première connexion s'affiche ici
```

Puis `http://127.0.0.1:8787`, et dans **Comptes → Ajouter une boîte** :

- l'adresse de la boîte de collecte, usage **Boîte à tickets**
- les serveurs IMAP et SMTP de votre fournisseur
- un alias par service, avec son urgence par défaut et son droit d'envoi
- **Tester** avant d'enregistrer : la connexion est réellement vérifiée

### Sans Docker

```bash
export CACHET_SECRET=$(openssl rand -hex 32)
node server.js
```

### Variables

| variable | rôle |
|---|---|
| `CACHET_SECRET` | **obligatoire**. Chiffre les secrets stockés et signe les sessions. Le changer rend illisibles les mots de passe déjà enregistrés. |
| `CACHET_PASSWORD` | mot de passe de première connexion. Sinon généré et affiché au démarrage. |
| `CACHET_TOTP_SECRET` | second facteur. `node totp-setup.js` génère le secret et l'URI à scanner. |
| `CACHET_BIND`, `CACHET_PORT` | adresse et port publiés sur l'hôte. Le port interne reste 8787. |
| `CACHET_DATA` | dossier des données. `/data` dans l'image. |
| `CACHET_INSECURE_COOKIE=1` | à ne mettre **que** pour un accès en HTTP sans TLS. |

---

## Exposition

Le compose n'ouvre le port que sur `127.0.0.1` : rien n'est joignable depuis le
réseau par défaut. Pour publier derrière un proxy sur une autre machine, passez
`CACHET_BIND=0.0.0.0` et filtrez le port au pare-feu.

Servez en HTTPS. Le cookie de session est `Secure` : sur du HTTP en clair, le
navigateur ne le renverra jamais et la connexion tournera en boucle. L'écran de
connexion le dit explicitement quand le cas se produit.

Si le proxy tourne dans un conteneur voisin, le plus propre est de les mettre
sur un réseau Docker commun et de viser `cachet:8787` : le port n'a alors plus
besoin d'être publié du tout.

---

## Règles de tri

**Réglages → Règles de tri.** Une règle s'applique à la relève, avant la
création du ticket.

Conditions sur l'expéditeur, le destinataire, l'objet, le corps, la boîte,
l'alias visé ou n'importe où. Opérateurs : contient, ne contient pas, est
exactement, commence par, finit par, expression régulière. Plusieurs conditions,
en mode « toutes remplies » ou « au moins une ». La comparaison ignore la casse
et les accents.

Actions : ranger dans un dossier, marquer lu ou non lu, forcer ou empêcher la
création du ticket, imposer une urgence ou un service, supprimer le message,
ou arrêter là pour que les règles suivantes ne s'appliquent pas.

**Essayer à blanc** passe la règle sur les 200 derniers messages et dit combien
elle aurait touchés, sans rien modifier. À utiliser systématiquement avant
d'activer une règle qui supprime : une suppression ne laisse qu'une ligne de
journal.

---

## Liaison avec un service externe

**Réglages → Liaison avec un service externe.** Deux clés distinctes :

- **la clé complète** (`pk_…`) ouvre toute l'API ;
- **la clé d'envoi** (`sk_…`) n'ouvre que `POST /api/send`.

Distribuez la clé d'envoi à vos services : un service compromis ne peut alors ni
lire vos tickets ni toucher aux comptes. Aucune des deux clés ne permet de lire
les clés elles-mêmes, cela exige une session.

Les deux s'envoient en en-tête `X-Cachet-Key` ou en `Authorization: Bearer`.

Les **origines autorisées** ne servent que si un front appelle Cachet depuis le
navigateur. Un service qui appelle depuis son propre serveur n'a rien à déclarer.

### Webhook sortant

Plutôt que de faire interroger Cachet en boucle, laissez Cachet appeler votre
service.

```
POST <votre url>
X-Cachet-Key: <clé>                    (nom de l'en-tête réglable)
X-Cachet-Signature: sha256=<hmac du corps>

{ "event": "ticket.created", "ticket": { … }, "at": "…" }
```

Événements : `ticket.created`, `ticket.repeated` (dédoublonnage),
`ticket.updated` et `ticket.test`.

La signature est un HMAC SHA-256 du corps brut avec le secret partagé. Côté
destinataire, recalculez-la sur le corps reçu et comparez en temps constant :
c'est ce qui distingue un vrai appel d'un tiers qui connaîtrait l'URL.

---

## Faire envoyer vos services vers Cachet

Vos services n'ont besoin que de l'URL et de la clé d'envoi :

```
POST https://cachet.exemple.fr/api/send
X-Cachet-Key: sk_...

{ "from": "no-reply@exemple.fr", "to": "supervision@exemple.fr",
  "subject": "résumé court et stable du problème",
  "text": "Machine : srv01\n…" }
```

Deux conventions qui pilotent la détection :

- une ligne `Machine : <hôte ou IP>` dans le corps devient la cible du ticket ;
- l'objet doit être **stable** pour un même incident, c'est lui qui sert au
  dédoublonnage. Horodatages et compteurs vont dans le corps, pas dans l'objet.

---

## Ce que ça fait, ce que ça ne fait pas

Fait :

- IMAP en TLS implicite (993), relève incrémentale par UID, marquage `\Seen`
- décodage MIME : multipart, base64, quoted-printable, en-têtes RFC 2047
- rendu HTML des messages, nettoyé par liste blanche : mise en forme et liens
  conservés, scripts, attributs d'événement et images distantes retirés
- SMTP en STARTTLS (587) ou TLS implicite (465), `AUTH PLAIN` et `AUTH LOGIN`
- tickets : service depuis l'alias, escalade d'urgence, dédoublonnage, historique
- règles de tri, dossiers locaux, boîte d'envoi, notification Telegram
- secrets chiffrés en AES-256-GCM au repos, sessions en cookie signé HMAC,
  TOTP optionnel, limitation des essais de connexion
- purge automatique des tickets traités au-delà de la rétention

Pas fait, volontairement :

- **STARTTLS en IMAP sur le port 143.** Seul le 993 est géré.
- **OAuth2.** Mot de passe d'application uniquement.
- **Pièces jointes.** Le corps est extrait, les fichiers sont ignorés.
- **Dossiers IMAP multiples.** Un dossier relevé par compte, `INBOX` par défaut.
- **Dossiers de rangement côté serveur.** Les dossiers sont locaux à Cachet :
  ranger un message ici ne le déplace pas chez le fournisseur. Des étiquettes
  locales se désynchroniseraient dès qu'on touche la boîte depuis le webmail.

---

## Le premier message ne remonte pas ?

À la toute première relève, Cachet ne prend que les messages **non lus**, pour ne
pas rejouer tout l'historique de la boîte et ouvrir cinquante tickets d'un coup.
Si vous avez ouvert l'alerte dans le webmail avant, elle est déjà marquée lue et
sera ignorée. Deux solutions : la remettre en non lu, ou utiliser **Relever
depuis zéro** (clic droit sur la ligne du compte).

Le clic droit est partout : sur un message pour le ranger, le marquer ou le
supprimer, sur une ligne de compte pour tester, relever ou purger, sur un
dossier ou une règle pour les supprimer.

---

## Changer le mot de passe

```bash
./passwd.sh
```

Saisie masquée et confirmée, rien ne passe par l'historique du shell.

## Tests

```bash
node test/run.js
```

57 tests contre de faux serveurs IMAP et SMTP : décodage MIME, nettoyage HTML,
dialogue IMAP, escalade et dédoublonnage, règles, refus SMTP, portée des clés,
CORS, signature du webhook, chiffrement sur disque, API complète. Le TOTP est
vérifié contre les vecteurs publiés de la RFC 6238.

## Sauvegarde

Tout est dans le volume `cachet-data` : `config.json` (comptes, alias, règles,
secrets chiffrés) et `state.json` (messages, tickets, journal). Sans
`CACHET_SECRET`, une sauvegarde de `config.json` est inexploitable — gardez le
secret ailleurs que dans la sauvegarde.

---

MIT · CodexX64
