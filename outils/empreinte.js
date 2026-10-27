#!/usr/bin/env node
'use strict';
/* Fabrique l'empreinte d'un mot de passe, à coller dans la variable COMPTES
   quand les comptes ne peuvent pas vivre sur un disque persistant.

   Usage :  node outils/empreinte.js "mon mot de passe"                      */

const crypto = require('crypto');

const mdp = process.argv.slice(2).join(' ');
if (!mdp) {
  console.error('Usage : node outils/empreinte.js "mot de passe"');
  process.exit(1);
}
if (mdp.length < 10) console.error('Attention : moins de dix caractères.');

const sel = crypto.randomBytes(16);
const h = crypto.scryptSync(mdp, sel, 64, { N: 16384, r: 8, p: 1 });
console.log(`scrypt$${sel.toString('base64')}$${h.toString('base64')}`);
