'use strict';
/* ════════════════════════════════════════════════════════════════════════
   PAYOR SIMUL — serveur d'accès
   L'outil reste le fichier HTML autonome : le serveur ne fait que garder la
   porte. Aucune donnée de paie ne transite par lui ni n'est enregistrée ici ;
   les dossiers restent dans le navigateur de chaque utilisateur, comme avant.
   Le serveur ne connaît que des identifiants, des empreintes de mots de passe
   et des dates de connexion.
   ════════════════════════════════════════════════════════════════════════ */

const express = require('express');
const crypto  = require('crypto');
const fs      = require('fs');
const path    = require('path');

const app  = express();
const PORT = process.env.PORT || 3000;

/* ─── emplacement des données ───
   Sur Render, un service sans disque perd ses fichiers à chaque déploiement.
   DATA_DIR doit donc pointer vers un disque persistant monté (/var/data). */
const DATA_DIR   = process.env.DATA_DIR || path.join(__dirname, 'data');
const PERSISTANT = Boolean(process.env.DATA_DIR);
const FICHIER    = path.join(DATA_DIR, 'utilisateurs.json');
fs.mkdirSync(DATA_DIR, { recursive: true });

/* ─── secret de session ───
   Sans secret fixe, un redémarrage déconnecte tout le monde : on le signale
   plutôt que de laisser le comportement surprendre. */
const SECRET = process.env.SESSION_SECRET || crypto.randomBytes(32).toString('hex');
if (!process.env.SESSION_SECRET) {
  console.warn('[payor] SESSION_SECRET absent : un secret temporaire est utilisé, ' +
               'les sessions ne survivront pas au redémarrage.');
}

const DUREE_SESSION = 12 * 3600 * 1000;   /* douze heures */
const MDP_MIN       = 10;

/* ═════════ mots de passe ═════════
   scrypt, fourni par Node : pas de dépendance à installer, et un coût de
   calcul qui rend l'essai exhaustif impraticable. */
function empreinte(mdp) {
  const sel = crypto.randomBytes(16);
  const h   = crypto.scryptSync(mdp, sel, 64, { N: 16384, r: 8, p: 1 });
  return `scrypt$${sel.toString('base64')}$${h.toString('base64')}`;
}
function verifierMdp(mdp, stocke) {
  try {
    const [algo, sel, h] = String(stocke).split('$');
    if (algo !== 'scrypt') return false;
    const attendu = Buffer.from(h, 'base64');
    const calcule = crypto.scryptSync(mdp, Buffer.from(sel, 'base64'), attendu.length,
                                      { N: 16384, r: 8, p: 1 });
    return crypto.timingSafeEqual(attendu, calcule);
  } catch { return false; }
}

/* ═════════ fichier des utilisateurs ═════════ */
let UTILISATEURS = [];

function lire() {
  try { UTILISATEURS = JSON.parse(fs.readFileSync(FICHIER, 'utf8')); }
  catch { UTILISATEURS = []; }
  if (!Array.isArray(UTILISATEURS)) UTILISATEURS = [];
}
function ecrire() {
  const tmp = FICHIER + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(UTILISATEURS, null, 2));
  fs.renameSync(tmp, FICHIER);          /* remplacement atomique */
}
const trouver = login =>
  UTILISATEURS.find(u => u.login.toLowerCase() === String(login || '').trim().toLowerCase());

/* Premier démarrage : un administrateur doit exister, sinon personne ne peut
   créer les autres comptes.
   Sans disque persistant — le plan gratuit de Render n'en propose pas — le
   fichier disparaît à chaque déploiement. La variable COMPTES permet alors de
   tenir la liste hors du disque : elle est relue à chaque démarrage, et les
   empreintes se fabriquent avec `node outils/empreinte.js "mot de passe"`. */
function amorcer() {
  lire();
  if (UTILISATEURS.length) return;

  if (process.env.COMPTES) {
    try {
      const liste = JSON.parse(process.env.COMPTES);
      if (!Array.isArray(liste) || !liste.length) throw new Error('liste vide');
      UTILISATEURS = liste.map(c => ({
        login: String(c.login).trim(),
        nom: c.nom || c.login,
        role: c.role === 'admin' ? 'admin' : 'utilisateur',
        mdp: String(c.mdp),
        version: 1, cree: c.cree || new Date().toISOString(),
        derniere: null, actif: c.actif !== false, doitChanger: Boolean(c.doitChanger)
      }));
      if (!UTILISATEURS.some(u => u.role === 'admin')) UTILISATEURS[0].role = 'admin';
      ecrire();
      console.log(`[payor] ${UTILISATEURS.length} compte(s) repris de la variable COMPTES.`);
      return;
    } catch (ex) {
      console.error('[payor] COMPTES illisible (' + ex.message + ') : on retombe sur ADMIN_LOGIN.');
    }
  }

  const login = (process.env.ADMIN_LOGIN || 'admin').trim();
  const mdp   = process.env.ADMIN_MDP || crypto.randomBytes(9).toString('base64url');
  UTILISATEURS.push({
    login, nom: process.env.ADMIN_NOM || 'Administrateur',
    role: 'admin', mdp: empreinte(mdp), version: 1,
    cree: new Date().toISOString(), derniere: null, actif: true,
    doitChanger: !process.env.ADMIN_MDP
  });
  ecrire();
  console.log('[payor] premier compte créé — identifiant : ' + login +
              (process.env.ADMIN_MDP ? '' : '\n[payor] mot de passe provisoire : ' + mdp +
               '\n[payor] changez-le dès la première connexion.'));
}
amorcer();

/* ═════════ sessions ═════════
   Cookie signé : rien n'est stocké côté serveur, et `version` permet de
   couper immédiatement les sessions d'un compte suspendu ou dont le mot de
   passe vient de changer. */
const b64 = o => Buffer.from(JSON.stringify(o)).toString('base64url');
const sign = s => crypto.createHmac('sha256', SECRET).update(s).digest('base64url');

function creerJeton(u) {
  const corps = b64({ l: u.login, v: u.version, e: Date.now() + DUREE_SESSION });
  return corps + '.' + sign(corps);
}
function lireJeton(jeton) {
  if (!jeton || typeof jeton !== 'string') return null;
  const i = jeton.lastIndexOf('.');
  if (i < 1) return null;
  const corps = jeton.slice(0, i), sig = jeton.slice(i + 1);
  const attendu = sign(corps);
  if (sig.length !== attendu.length ||
      !crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(attendu))) return null;
  let p; try { p = JSON.parse(Buffer.from(corps, 'base64url').toString('utf8')); }
  catch { return null; }
  if (!p || p.e < Date.now()) return null;
  const u = trouver(p.l);
  if (!u || !u.actif || u.version !== p.v) return null;
  return u;
}

/* lecture du cookie sans dépendance */
function cookies(req) {
  const out = {};
  (req.headers.cookie || '').split(';').forEach(c => {
    const i = c.indexOf('=');
    if (i > 0) out[c.slice(0, i).trim()] = decodeURIComponent(c.slice(i + 1).trim());
  });
  return out;
}
function poserCookie(res, jeton) {
  res.cookie('ps_session', jeton, {
    httpOnly: true, sameSite: 'lax', secure: process.env.NODE_ENV === 'production',
    maxAge: DUREE_SESSION, path: '/'
  });
}

function session(req, _res, next) { req.u = lireJeton(cookies(req).ps_session); next(); }
function exigeSession(req, res, next) {
  if (req.u) return next();
  if (req.path.startsWith('/api/')) return res.status(401).json({ erreur: 'session expirée' });
  res.redirect('/connexion');
}
function exigeAdmin(req, res, next) {
  if (req.u && req.u.role === 'admin') return next();
  res.status(403).json({ erreur: 'réservé à l’administrateur' });
}

/* ═════════ garde-fou contre l'essai de mots de passe ═════════ */
const essais = new Map();
function tropDEssais(cle) {
  const e = essais.get(cle);
  if (!e) return false;
  if (Date.now() > e.jusqua) { essais.delete(cle); return false; }
  return e.n >= 8;
}
function noterEchec(cle) {
  const e = essais.get(cle) || { n: 0, jusqua: 0 };
  e.n += 1; e.jusqua = Date.now() + 10 * 60 * 1000;
  essais.set(cle, e);
}

/* ═════════ l'outil ═════════
   Le fichier est lu une fois et complété d'un bandeau de session. Le fichier
   d'origine n'est pas modifié sur le disque. */
const CHEMIN_APP = path.join(__dirname, 'app', 'payor-simul.html');
let PAGE_APP = fs.readFileSync(CHEMIN_APP, 'utf8');

const BANDEAU = `
<div id="ps-session" style="position:fixed;top:10px;right:14px;z-index:9999;display:flex;
  align-items:center;gap:10px;font:500 12px/1 'Halyard Text',Arial,sans-serif;color:#464B4B;
  background:rgba(255,255,255,.94);border:1px solid #C8C9C7;border-radius:5px;padding:7px 11px;
  box-shadow:0 1px 2px rgba(23,28,143,.08)">
  <span id="ps-qui"></span>
  <a href="/admin" id="ps-admin" hidden style="color:#0072CE;text-decoration:none">Accès</a>
  <a href="/deconnexion" style="color:#0072CE;text-decoration:none">Se déconnecter</a>
</div>
<style>@media print{#ps-session{display:none!important}}</style>
<script>
fetch('/api/moi').then(r => r.json()).then(u => {
  document.getElementById('ps-qui').textContent = u.nom || u.login;
  if (u.role === 'admin') document.getElementById('ps-admin').hidden = false;
}).catch(() => {});
</script>`;

/* `</body>` figure aussi dans les gabarits d'export Word, à l'intérieur de
   chaînes JavaScript : seule la dernière occurrence ferme vraiment la page. */
const pageApp = () => {
  const i = PAGE_APP.lastIndexOf('</body>');
  return i < 0 ? PAGE_APP + BANDEAU
               : PAGE_APP.slice(0, i) + BANDEAU + '\n' + PAGE_APP.slice(i);
};

/* extraction de la marque, pour que la page de garde porte le même logo
   que l'outil sans dupliquer le fichier */
function marque() {
  const m = /const LOGO_DEF = '([^']+)'/.exec(PAGE_APP);
  if (!m) return null;
  const d = /^data:([^;,]+)(;base64)?,(.*)$/.exec(m[1]);
  if (!d) return null;
  return { type: d[1], corps: d[2] ? Buffer.from(d[3], 'base64') : Buffer.from(decodeURIComponent(d[3])) };
}
const MARQUE = marque();

/* ═════════ routes ═════════ */
app.disable('x-powered-by');
app.set('trust proxy', 1);              /* Render place un proxy devant le service */
app.use(express.json({ limit: '64kb' }));
app.use(session);

app.use((_req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'same-origin');
  /* L'outil est un fichier unique : styles et scripts sont en ligne, et trois
     bibliothèques de lecture de fichiers viennent de cdnjs. */
  res.setHeader('Content-Security-Policy',
    "default-src 'self'; " +
    "script-src 'self' 'unsafe-inline' https://cdnjs.cloudflare.com; " +
    "style-src 'self' 'unsafe-inline'; " +
    "img-src 'self' data: blob:; font-src 'self' data:; " +
    "connect-src 'self' https://cdnjs.cloudflare.com https://api.anthropic.com; " +
    "worker-src 'self' blob:; frame-ancestors 'none'; base-uri 'self'");
  next();
});

app.get('/sante', (_req, res) => res.json({ etat: 'ok', comptes: UTILISATEURS.length }));

app.get('/marque', (_req, res) => {
  if (!MARQUE) return res.status(404).end();
  res.setHeader('Content-Type', MARQUE.type);
  res.setHeader('Cache-Control', 'public, max-age=86400');
  res.end(MARQUE.corps);
});

app.get('/connexion', (req, res) => {
  if (req.u) return res.redirect('/');
  res.sendFile(path.join(__dirname, 'public', 'connexion.html'));
});

app.post('/api/connexion', (req, res) => {
  const login = String(req.body.login || '').trim();
  const mdp   = String(req.body.mdp || '');
  const cle   = (req.ip || '') + '|' + login.toLowerCase();

  if (tropDEssais(cle))
    return res.status(429).json({ erreur: 'Trop de tentatives. Réessayez dans dix minutes.' });

  const u = trouver(login);
  /* Le message ne distingue pas l'identifiant inconnu du mot de passe faux :
     sinon la page devient un annuaire des comptes existants. */
  if (!u || !u.actif || !verifierMdp(mdp, u.mdp)) {
    noterEchec(cle);
    return res.status(401).json({ erreur: 'Identifiant ou mot de passe incorrect.' });
  }
  essais.delete(cle);
  u.derniere = new Date().toISOString();
  ecrire();
  poserCookie(res, creerJeton(u));
  res.json({ ok: true, doitChanger: Boolean(u.doitChanger) });
});

app.get('/deconnexion', (_req, res) => {
  res.clearCookie('ps_session', { path: '/' });
  res.redirect('/connexion');
});

app.get('/api/moi', exigeSession, (req, res) =>
  res.json({ login: req.u.login, nom: req.u.nom, role: req.u.role,
             doitChanger: Boolean(req.u.doitChanger) }));

app.post('/api/mon-mot-de-passe', exigeSession, (req, res) => {
  const { actuel, nouveau } = req.body || {};
  if (!verifierMdp(String(actuel || ''), req.u.mdp))
    return res.status(400).json({ erreur: 'Mot de passe actuel incorrect.' });
  if (String(nouveau || '').length < MDP_MIN)
    return res.status(400).json({ erreur: `Le nouveau mot de passe doit faire au moins ${MDP_MIN} caractères.` });
  req.u.mdp = empreinte(String(nouveau));
  req.u.doitChanger = false;
  req.u.version += 1;                   /* les autres sessions tombent */
  ecrire();
  poserCookie(res, creerJeton(req.u));
  res.json({ ok: true });
});

/* ─── administration des comptes ─── */
const vue = u => ({ login: u.login, nom: u.nom, role: u.role, actif: u.actif,
                    cree: u.cree, derniere: u.derniere, doitChanger: Boolean(u.doitChanger) });

app.get('/admin', exigeSession, (req, res) => {
  if (req.u.role !== 'admin') return res.redirect('/');
  res.sendFile(path.join(__dirname, 'public', 'admin.html'));
});

app.get('/api/utilisateurs', exigeSession, exigeAdmin, (_req, res) =>
  res.json({ utilisateurs: UTILISATEURS.map(vue), persistant: PERSISTANT, dossier: DATA_DIR }));

app.post('/api/utilisateurs', exigeSession, exigeAdmin, (req, res) => {
  const login = String(req.body.login || '').trim();
  const nom   = String(req.body.nom || '').trim();
  const role  = req.body.role === 'admin' ? 'admin' : 'utilisateur';
  const mdp   = String(req.body.mdp || '');
  if (!/^[A-Za-z0-9._@-]{3,64}$/.test(login))
    return res.status(400).json({ erreur: 'Identifiant : 3 à 64 caractères, lettres, chiffres, point, tiret, @ ou souligné.' });
  if (trouver(login)) return res.status(409).json({ erreur: 'Cet identifiant existe déjà.' });
  if (mdp.length < MDP_MIN)
    return res.status(400).json({ erreur: `Le mot de passe doit faire au moins ${MDP_MIN} caractères.` });

  const u = { login, nom: nom || login, role, mdp: empreinte(mdp), version: 1,
              cree: new Date().toISOString(), derniere: null, actif: true, doitChanger: true };
  UTILISATEURS.push(u); ecrire();
  res.json({ ok: true, utilisateur: vue(u) });
});

app.patch('/api/utilisateurs/:login', exigeSession, exigeAdmin, (req, res) => {
  const u = trouver(req.params.login);
  if (!u) return res.status(404).json({ erreur: 'Compte introuvable.' });
  const admins = () => UTILISATEURS.filter(x => x.role === 'admin' && x.actif).length;

  if (req.body.nom !== undefined) u.nom = String(req.body.nom).trim() || u.login;

  if (req.body.actif !== undefined) {
    const actif = Boolean(req.body.actif);
    if (!actif && u.role === 'admin' && admins() <= 1)
      return res.status(400).json({ erreur: 'Il doit rester au moins un administrateur actif.' });
    u.actif = actif;
    if (!actif) u.version += 1;         /* coupe ses sessions en cours */
  }

  if (req.body.role !== undefined) {
    const role = req.body.role === 'admin' ? 'admin' : 'utilisateur';
    if (role !== 'admin' && u.role === 'admin' && admins() <= 1)
      return res.status(400).json({ erreur: 'Il doit rester au moins un administrateur actif.' });
    u.role = role;
  }

  if (req.body.mdp !== undefined) {
    if (String(req.body.mdp).length < MDP_MIN)
      return res.status(400).json({ erreur: `Le mot de passe doit faire au moins ${MDP_MIN} caractères.` });
    u.mdp = empreinte(String(req.body.mdp));
    u.doitChanger = true;
    u.version += 1;
  }

  ecrire();
  res.json({ ok: true, utilisateur: vue(u) });
});

app.delete('/api/utilisateurs/:login', exigeSession, exigeAdmin, (req, res) => {
  const u = trouver(req.params.login);
  if (!u) return res.status(404).json({ erreur: 'Compte introuvable.' });
  if (u.login.toLowerCase() === req.u.login.toLowerCase())
    return res.status(400).json({ erreur: 'On ne supprime pas son propre compte.' });
  if (u.role === 'admin' && UTILISATEURS.filter(x => x.role === 'admin' && x.actif).length <= 1)
    return res.status(400).json({ erreur: 'Il doit rester au moins un administrateur actif.' });
  UTILISATEURS = UTILISATEURS.filter(x => x !== u);
  ecrire();
  res.json({ ok: true });
});

/* ─── l'outil, derrière la porte ─── */
app.get('/', exigeSession, (_req, res) => {
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  res.send(pageApp());
});

app.use(express.static(path.join(__dirname, 'public'), { index: false }));

app.use((req, res) => {
  if (req.path.startsWith('/api/')) return res.status(404).json({ erreur: 'route inconnue' });
  res.redirect(req.u ? '/' : '/connexion');
});

app.listen(PORT, () => {
  console.log(`[payor] en écoute sur le port ${PORT}`);
  console.log(`[payor] comptes : ${UTILISATEURS.length} · dossier : ${DATA_DIR}` +
              (PERSISTANT ? '' : ' (non persistant — montez un disque et renseignez DATA_DIR)'));
});
