// Point d'entrée : docker exec, npm start, ou node server.js. Le processus
// lancé supervise le service et le relance quand l'assistant de configuration
// a posé de nouveaux réglages.
import { superviser } from './socle/src/index.js';

if (!superviser()) {
  const { demarrer } = await import('./lib/serveur.js');
  demarrer().then(({ arreter }) => {
    for (const s of ['SIGTERM', 'SIGINT']) process.on(s, () => arreter().then(() => process.exit(0)));
  }).catch(e => { console.error(e.message); process.exit(1); });
}
