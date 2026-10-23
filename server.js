// Point d'entrée : docker exec, npm start, ou node server.js.
import { demarrer } from './lib/serveur.js';

demarrer().then(({ arreter }) => {
  for (const s of ['SIGTERM', 'SIGINT']) process.on(s, () => arreter().then(() => process.exit(0)));
}).catch(e => { console.error(e.message); process.exit(1); });
