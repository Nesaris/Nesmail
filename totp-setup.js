#!/usr/bin/env node
// Genere un secret TOTP et l'URI a scanner. Rien n'est ecrit :
// copiez la valeur dans CACHET_TOTP_SECRET.
process.env.CACHET_SECRET = process.env.CACHET_SECRET || 'x';
const { newSecret, totp } = require('./lib/auth');
const secret = newSecret();
const label = encodeURIComponent(process.argv[2] || 'admin');
console.log('\nCACHET_TOTP_SECRET=' + secret);
console.log('\notpauth://totp/Cachet:' + label + '?secret=' + secret + '&issuer=Cachet&period=30&digits=6\n');
console.log('Verifiez que votre application affiche bien : ' + totp(secret) + '\n');
