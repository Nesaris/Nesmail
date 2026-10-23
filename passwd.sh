#!/usr/bin/env bash
# Change le mot de passe de Cachet. Saisie masquee, rien ne passe par la ligne
# de commande ni par l'historique du shell.
set -euo pipefail
cd "$(dirname "$0")"

docker compose ps --format '{{.State}}' cachet 2>/dev/null | grep -q running \
  || { echo "  Le conteneur cachet ne tourne pas."; exit 1; }

read -rsp "Nouveau mot de passe : " p1; echo
read -rsp "Confirmer            : " p2; echo
[ "$p1" = "$p2" ] || { echo "  Les deux saisies different, rien n'a ete change."; exit 1; }
[ ${#p1} -ge 8 ]  || { echo "  Trop court : 8 caracteres minimum."; exit 1; }

docker exec -i cachet sh -c 'cat > /tmp/cachet-passwd.js' <<'NODE'
const fs = require('fs'), auth = require('/app/lib/auth');
let saisie = '';
process.stdin.on('data', d => saisie += d);
process.stdin.on('end', () => {
  const mdp = saisie.replace(/\r?\n$/, '');
  if (mdp.length < 8) { console.error('Trop court.'); process.exit(1); }
  const f = '/data/config.json';
  const c = JSON.parse(fs.readFileSync(f, 'utf8'));
  c.admin.password = auth.hashPassword(mdp);
  fs.writeFileSync(f + '.tmp', JSON.stringify(c, null, 2), { mode: 0o600 });
  fs.renameSync(f + '.tmp', f);
  console.log('  Mot de passe enregistre.');
});
NODE

printf '%s' "$p1" | docker exec -i cachet node /tmp/cachet-passwd.js
unset p1 p2

# Redemarrage necessaire : le serveur garde la config en memoire et reecrirait
# l'ancien hachage a la premiere modification de compte.
docker compose restart cachet >/dev/null
docker exec cachet rm -f /tmp/cachet-passwd.js
echo "  Cachet redemarre. Connectez-vous avec le nouveau mot de passe."
