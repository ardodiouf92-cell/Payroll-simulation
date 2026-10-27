'use strict';
/* ════════════════════════════════════════════════════════════════════════
   PAYOR SIMUL — serveur d'accès, adossé à PostgreSQL
   L'outil reste le fichier HTML autonome : le serveur ne fait que garder la
   porte. Aucune donnée de paie ne transite par lui ni n'est enregistrée en
   base ; les dossiers restent dans le navigateur de chaque utilisateur.
   La base ne contient que des comptes — identifiant, empreinte du mot de
   passe — et des sessions ouvertes.
   ════════════════════════════════════════════════════════════════════════ */

const express = require('express');
const crypto  = require('crypto');
const fs      = require('fs');
const path    = require('path');
const { Pool } = require('pg');

const app  = express();
const PORT = process.env.PORT || 3000;

const DUREE_SESSION = 12 * 3600 * 1000;   /* douze heures */
const MDP_MIN       = 10;

/* ═════════ modules ═════════
   Un accès ouvre ou ferme des modules entiers, pas des onglets isolés : au
   grain de l'onglet, la liste deviendrait illisible et les combinaisons
   incohérentes — le bulletin groupé sans le traitement groupé, par exemple. */
const MODULES = [
  { cle:'individuel', nom:'Traitement individuel',
    desc:'Parts, IR, calcul à l\u2019envers, bulletin, retraite, licenciement, avantages' },
  { cle:'groupe',     nom:'Traitement groupé',
    desc:'Les mêmes calculs sur un effectif importé, et l\u2019édition des bulletins en lot' },
  { cle:'das',        nom:'Déclaration annuelle des salaires',
    desc:'Contrôle des deux pages avant dépôt et rapport Word' },
  { cle:'documents',  nom:'Modèles de documents',
    desc:'Les vingt et un modèles et le publipostage' },
  { cle:'assistant',  nom:'Assistant IA',
    desc:'Questions en langage libre sur les documents chargés' },
  { cle:'params',     nom:'Barème et taux',
    desc:'Modification du barème de l\u2019impôt, des paliers et des cotisations' },
  { cle:'dossier',    nom:'Dossier',
    desc:'Import et export du dossier, effectifs, identité visuelle' }
];
const CLES_MODULES = MODULES.map(m => m.cle);
const normDroits = d => {
  if (!Array.isArray(d)) return [...CLES_MODULES];
  const g = d.filter(x => CLES_MODULES.includes(x));
  return [...new Set(g)];
};

/* ═════════ connexion à la base ═════════ */
const URL_BASE = process.env.DATABASE_URL;
if (!URL_BASE) {
  console.error('[payor] DATABASE_URL absent. Sur Render, reliez la base au service ; ' +
                'en local, exportez la variable avant de démarrer.');
  process.exit(1);
}
/* Render chiffre les connexions venues de l'extérieur et fournit sa propre
   autorité ; en local, une base sans TLS est la norme. */
const local = /@(localhost|127\.0\.0\.1|\[::1\])[:/]/.test(URL_BASE) ||
              /sslmode=disable/.test(URL_BASE);
const pool = new Pool({
  connectionString: URL_BASE,
  ssl: local ? false : { rejectUnauthorized: false },
  max: Number(process.env.PG_POOL_MAX || 5),
  idleTimeoutMillis: 30000
});
pool.on('error', e => console.error('[payor] connexion perdue :', e.message));

const q = (texte, params) => pool.query(texte, params);

/* ═════════ schéma ═════════
   Créé au démarrage s'il manque : un déploiement neuf n'exige aucune
   manipulation préalable, et un redéploiement ne touche à rien. */
async function migrer() {
  await q(`
    CREATE TABLE IF NOT EXISTS utilisateurs (
      id           bigserial PRIMARY KEY,
      login        text        NOT NULL,
      login_norm   text        NOT NULL UNIQUE,
      nom          text        NOT NULL,
      role         text        NOT NULL DEFAULT 'utilisateur',
      mdp          text        NOT NULL,
      actif        boolean     NOT NULL DEFAULT true,
      doit_changer boolean     NOT NULL DEFAULT true,
      cree         timestamptz NOT NULL DEFAULT now(),
      derniere     timestamptz
    )`);
  /* Ajoutée après coup : une installation existante se met à jour toute seule,
     et les comptes déjà créés gardent l'accès à tout. */
  /* Pas de paramètre possible dans une instruction DDL : la valeur est écrite
     dans le texte, ce que rien n'interdit ici — ces clés sont nos constantes. */
  await q(`ALTER TABLE utilisateurs ADD COLUMN IF NOT EXISTS droits jsonb
             NOT NULL DEFAULT '${JSON.stringify(CLES_MODULES)}'::jsonb`);
  await q(`
    CREATE TABLE IF NOT EXISTS reglages (
      cle    text        PRIMARY KEY,
      valeur text,
      maj    timestamptz NOT NULL DEFAULT now(),
      par    text
    )`);
  await q(`
    CREATE TABLE IF NOT EXISTS sessions (
      jeton       text        PRIMARY KEY,
      utilisateur bigint      NOT NULL REFERENCES utilisateurs(id) ON DELETE CASCADE,
      cree        timestamptz NOT NULL DEFAULT now(),
      vu          timestamptz NOT NULL DEFAULT now(),
      expire      timestamptz NOT NULL,
      ip          text,
      agent       text
    )`);
  await q(`CREATE INDEX IF NOT EXISTS sessions_utilisateur ON sessions(utilisateur)`);
  await q(`CREATE INDEX IF NOT EXISTS sessions_expire      ON sessions(expire)`);
}

/* La base peut n'être pas encore prête au premier démarrage du service. */
async function attendreBase(essais = 10) {
  for (let i = 1; i <= essais; i++) {
    try { await q('SELECT 1'); return; }
    catch (e) {
      if (i === essais) throw e;
      console.log(`[payor] base indisponible (${e.code || e.message}), nouvel essai ${i}/${essais}…`);
      await new Promise(r => setTimeout(r, 2000 * i));
    }
  }
}

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

/* ═════════ comptes ═════════ */
const norm = l => String(l || '').trim().toLowerCase();

const parLogin = async login =>
  (await q('SELECT * FROM utilisateurs WHERE login_norm = $1', [norm(login)])).rows[0] || null;

async function creerCompte({ login, nom, role, mdp, droits, doitChanger = true }) {
  const r = await q(
    `INSERT INTO utilisateurs (login, login_norm, nom, role, mdp, doit_changer, droits)
     VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb) RETURNING *`,
    [String(login).trim(), norm(login), nom || String(login).trim(),
     role === 'admin' ? 'admin' : 'utilisateur', empreinte(mdp), doitChanger,
     JSON.stringify(normDroits(droits))]);
  return r.rows[0];
}

/* L'administrateur garde tout : il lui faut au minimum de quoi rouvrir les
   droits qu'il viendrait de se retirer. */
const droitsDe = u => u.role === 'admin' ? [...CLES_MODULES] : normDroits(u.droits);
const peut = (u, m) => droitsDe(u).includes(m);

const nbAdmins = async () =>
  Number((await q(`SELECT count(*)::int AS n FROM utilisateurs WHERE role='admin' AND actif`)).rows[0].n);

/* Premier démarrage : un administrateur doit exister, sinon personne ne peut
   créer les autres comptes. COMPTES permet d'amorcer plusieurs accès d'un
   coup ; les empreintes se fabriquent avec `node outils/empreinte.js`. */
async function amorcer() {
  const n = Number((await q('SELECT count(*)::int AS n FROM utilisateurs')).rows[0].n);
  if (n) return;

  if (process.env.COMPTES) {
    try {
      const liste = JSON.parse(process.env.COMPTES);
      if (!Array.isArray(liste) || !liste.length) throw new Error('liste vide');
      for (const c of liste) {
        await q(`INSERT INTO utilisateurs (login, login_norm, nom, role, mdp, actif, doit_changer)
                 VALUES ($1,$2,$3,$4,$5,$6,$7) ON CONFLICT (login_norm) DO NOTHING`,
          [String(c.login).trim(), norm(c.login), c.nom || c.login,
           c.role === 'admin' ? 'admin' : 'utilisateur', String(c.mdp),
           c.actif !== false, Boolean(c.doitChanger)]);
      }
      if (!(await nbAdmins()))
        await q(`UPDATE utilisateurs SET role='admin' WHERE id = (SELECT min(id) FROM utilisateurs)`);
      console.log(`[payor] ${liste.length} compte(s) repris de la variable COMPTES.`);
      return;
    } catch (ex) {
      console.error('[payor] COMPTES illisible (' + ex.message + ') : on retombe sur ADMIN_LOGIN.');
    }
  }

  const login = (process.env.ADMIN_LOGIN || 'admin').trim();
  const mdp   = process.env.ADMIN_MDP || crypto.randomBytes(9).toString('base64url');
  await creerCompte({ login, nom: process.env.ADMIN_NOM || 'Administrateur',
                      role: 'admin', mdp, doitChanger: !process.env.ADMIN_MDP });
  console.log('[payor] premier compte créé — identifiant : ' + login +
              (process.env.ADMIN_MDP ? '' : '\n[payor] mot de passe provisoire : ' + mdp +
               '\n[payor] changez-le dès la première connexion.'));
}

/* ═════════ réglages ═════════
   La clé API vit en base et ne ressort jamais : l'interface n'en voit que les
   quatre derniers caractères, de quoi reconnaître laquelle est en place sans
   pouvoir la recopier. */
async function lireReglage(cle) {
  const r = await q('SELECT valeur FROM reglages WHERE cle = $1', [cle]);
  return r.rows[0] ? r.rows[0].valeur : null;
}
async function ecrireReglage(cle, valeur, par) {
  await q(`INSERT INTO reglages (cle, valeur, maj, par) VALUES ($1,$2,now(),$3)
           ON CONFLICT (cle) DO UPDATE SET valeur = $2, maj = now(), par = $3`,
          [cle, valeur, par]);
}
const CLE_IA = 'cle_api_anthropic';

/* ANTHROPIC_API_KEY l'emporte sur toute clé enregistrée en base : quand on
   décide de tenir le secret dans les variables d'environnement, une valeur
   oubliée en base ne doit pas continuer à servir en silence.
   La clé est relue à chaque appel mais gardée quelques secondes : l'assistant
   enchaîne les requêtes, et rien ne justifie d'interroger la base à chacune. */
const CLE_ENV = () => (process.env.ANTHROPIC_API_KEY || '').trim() || null;
let cacheCle = { valeur: undefined, jusqua: 0 };
async function cleIA() {
  const env = CLE_ENV();
  if (env) return env;
  if (Date.now() < cacheCle.jusqua) return cacheCle.valeur;
  const v = await lireReglage(CLE_IA);
  cacheCle = { valeur: v, jusqua: Date.now() + 15000 };
  return v;
}
const oublierCle = () => { cacheCle = { valeur: undefined, jusqua: 0 }; };

/* ═════════ sessions ═════════
   Le navigateur reçoit un jeton aléatoire ; la base n'en garde que l'empreinte.
   Une copie de la table ne livre donc aucune session utilisable, et fermer une
   session revient à supprimer une ligne — l'effet est immédiat, sans attendre
   l'expiration du cookie. */
const sha = t => crypto.createHash('sha256').update(t).digest('hex');

async function ouvrirSession(utilisateur, req) {
  const jeton = crypto.randomBytes(32).toString('base64url');
  await q(`INSERT INTO sessions (jeton, utilisateur, expire, ip, agent)
           VALUES ($1,$2,$3,$4,$5)`,
    [sha(jeton), utilisateur.id, new Date(Date.now() + DUREE_SESSION),
     (req.ip || '').slice(0, 64), String(req.headers['user-agent'] || '').slice(0, 300)]);
  return jeton;
}

async function lireSession(jeton) {
  if (!jeton || typeof jeton !== 'string' || jeton.length > 128) return null;
  const r = await q(
    `SELECT u.*, s.jeton AS sjeton, s.expire
       FROM sessions s JOIN utilisateurs u ON u.id = s.utilisateur
      WHERE s.jeton = $1 AND s.expire > now() AND u.actif`, [sha(jeton)]);
  const u = r.rows[0];
  if (!u) return null;
  /* Prolongation glissante : on n'écrit que lorsqu'il reste moins de la moitié
     du temps, pour ne pas toucher la base à chaque requête. */
  if (new Date(u.expire).getTime() - Date.now() < DUREE_SESSION / 2) {
    await q(`UPDATE sessions SET expire = $2, vu = now() WHERE jeton = $1`,
      [u.sjeton, new Date(Date.now() + DUREE_SESSION)]);
  }
  return u;
}

const fermerSession  = jeton => q('DELETE FROM sessions WHERE jeton = $1', [sha(jeton)]);
const fermerToutes   = id    => q('DELETE FROM sessions WHERE utilisateur = $1', [id]);
const purgerSessions = ()    => q('DELETE FROM sessions WHERE expire < now()');

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

async function session(req, _res, next) {
  req.jeton = cookies(req).ps_session || null;
  try { req.u = req.jeton ? await lireSession(req.jeton) : null; }
  catch (e) { console.error('[payor] lecture de session :', e.message); req.u = null; }
  next();
}
function exigeSession(req, res, next) {
  if (req.u) return next();
  if (req.path.startsWith('/api/')) return res.status(401).json({ erreur: 'session expirée' });
  res.redirect('/connexion');
}
function exigeAdmin(req, res, next) {
  if (req.u && req.u.role === 'admin') return next();
  res.status(403).json({ erreur: 'réservé à l’administrateur' });
}
/* Une erreur de base ne doit pas faire tomber le service en silence. */
const route = fn => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

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
const PAGE_APP   = fs.readFileSync(CHEMIN_APP, 'utf8');

const BANDEAU = `
<style>
/* Posé dans le flux de l'en-tête plutôt qu'en surimpression : fixé en haut à
   droite, il recouvrait les dernières entrées du menu. */
#ps-session{display:flex;align-items:center;gap:11px;align-self:center;
  font:500 12px/1.3 'Halyard Text',Arial,sans-serif;color:#464B4B;white-space:nowrap;
  padding-left:18px;border-left:1px solid #E6E6E3;margin-left:4px}
#ps-session a{color:#0072CE;text-decoration:none}
#ps-session a:hover{color:#171C8F;text-decoration:underline}
#ps-qui{font-weight:700;color:#171C8F}
#ps-session.ps-flottant{position:fixed;top:10px;right:14px;z-index:9999;
  background:rgba(255,255,255,.94);border:1px solid #C8C9C7;border-radius:5px;
  padding:7px 11px;margin:0}
@media(max-width:900px){#ps-session{border-left:0;padding-left:0;margin-left:auto}}
/* Un module fermé reste visible : on doit savoir que l'outil le contient. */
.ps-ferme{opacity:.42!important;cursor:not-allowed!important}
.nav-drop button.ps-ferme::after{content:'accès fermé';margin-left:auto;font-size:10px;
  font-weight:400;color:#97999B;white-space:nowrap}
@media print{#ps-session{display:none!important}}
</style>
<div id="ps-session">
  <span id="ps-qui"></span>
  <a href="/admin" id="ps-admin" hidden>Accès</a>
  <a href="/deconnexion">Se déconnecter</a>
</div>
<script>
(function(){
  /* Chaque onglet relève d'un module ; les droits se règlent par module. */
  var MOD = {
    parts:'individuel', ir:'individuel', inverse:'individuel', bulletin:'individuel',
    retraite:'individuel', licenciement:'individuel', avantages:'individuel',
    g_parts:'groupe', g_ir:'groupe', g_inverse:'groupe', g_bulletin:'groupe',
    g_retraite:'groupe', g_licenciement:'groupe', g_avantages:'groupe', bulletins:'groupe',
    das:'das', modeles:'documents', publi:'documents',
    assistant:'assistant', params:'params', dossier:'dossier'
  };
  var SANS_TAB = { lnkModeles:'documents', lnkAssist:'assistant' };

  /* L'en-tête est une rangée souple : le bandeau y prend sa place à droite du
     menu, et retombe en surimpression si la structure venait à changer. */
  var barre = document.getElementById('ps-session');
  var entete = document.querySelector('.masthead');
  if (entete && barre) entete.appendChild(barre);
  else if (barre) barre.classList.add('ps-flottant');

  fetch('/api/moi').then(function(r){ return r.json(); }).then(function(u){
    document.getElementById('ps-qui').textContent = u.nom || u.login;
    if (u.role === 'admin') document.getElementById('ps-admin').hidden = false;

    /* La clé vit sur le serveur : l'assistant passe par le relais, et aucune
       clé ne transite par le navigateur. */
    /* L'assistant passe toujours par le relais : sans clé côté serveur, c'est
       lui qui répond, avec un message clair, plutôt qu'un appel direct à
       Anthropic qui échouerait sans explication. */
    window.PS_CONFIG = Object.assign({}, window.PS_CONFIG, { proxy: '/api/ia' });

    /* Les notes de bas d'écran — charte, portée des modèles, avertissement
       général — s'adressent à qui administre l'outil, pas à qui s'en sert. */
    if (u.role !== 'admin')
      document.querySelectorAll('.disclaimer').forEach(function(el){ el.hidden = true; });

    var droits = u.droits || [];
    var ouvert = function(tab){ var m = MOD[tab]; return !m || droits.indexOf(m) >= 0; };
    if (droits.length >= Object.keys(MOD).length) return;   /* rien à fermer */

    var fermer = function(el, nom){
      el.classList.add('ps-ferme');
      el.disabled = true;
      el.setAttribute('aria-disabled', 'true');
      el.title = 'Ce module n’est pas ouvert à votre accès. Adressez-vous à l’administrateur.';
    };

    document.querySelectorAll('.nav-drop button[data-tab]').forEach(function(b){
      if (!ouvert(b.dataset.tab)) fermer(b);
    });
    Object.keys(SANS_TAB).forEach(function(id){
      var b = document.getElementById(id);
      if (b && droits.indexOf(SANS_TAB[id]) < 0) fermer(b);
    });
    /* Un menu dont toutes les entrées sont fermées se grise aussi. */
    document.querySelectorAll('.navitem').forEach(function(it){
      var drop = it.querySelector('.nav-drop'); if (!drop) return;
      var libres = [].slice.call(drop.querySelectorAll('button[data-tab]'))
                     .filter(function(b){ return !b.disabled; });
      if (!libres.length) fermer(it.querySelector('.nav-top'));
    });

    /* Le grisage n'est qu'un garde-fou d'interface ; il évite les clics, pas
       les détours. Ce qui compte vraiment — le relais de l'assistant — est
       refusé côté serveur. */
    var allerOrig = window.aller;
    if (typeof allerOrig === 'function') {
      window.aller = function(tab){
        if (!ouvert(tab)) return;
        return allerOrig.apply(this, arguments);
      };
    }
    /* Si l'onglet affiché au démarrage est fermé, on ouvre le premier permis. */
    var liste = (typeof PANELS !== 'undefined' && PANELS) ? PANELS : [];
    var visible = liste.filter(function(t){
      var p = document.getElementById('panel-' + t); return p && !p.hidden; })[0];
    if (visible && !ouvert(visible)) {
      var premier = liste.filter(ouvert)[0];
      if (premier) window.aller(premier);
    }
  }).catch(function(){});
})();
<\/script>`;

/* Le champ de saisie de clé est retiré de la page servie — pas masqué, retiré.
   Sur un déploiement partagé, la clé relève de l'administrateur : personne ne
   doit pouvoir y coller la sienne, ni même voir qu'on le pourrait. Le fichier
   d'origine garde son champ : hors serveur, c'est le seul moyen de s'en servir. */
function sansChampCle(html) {
  const CHAMP = `        <div class="field stack"><label for="iaKey">Clé API Anthropic <span style="color:var(--ink-faint)">— facultative</span></label>
          <input id="iaKey" type="password" placeholder="sk-ant-… (hors Claude uniquement)" spellcheck="false"></div>
        <p class="hint">Dans Claude, laissez ce champ vide : l'appel passe par la session en cours.
          Sur un serveur ou en fichier local, renseignez une clé ou branchez votre propre proxy.</p>`;
  const NOTE = `        <p class="hint">La clé de l'assistant est détenue par le serveur et partagée par
          tous les accès : rien n'est à saisir ici. Si l'assistant ne répond pas, adressez-vous à
          l'administrateur de l'outil.</p>`;
  let out = html;
  if (out.includes(CHAMP)) out = out.replace(CHAMP, NOTE);
  else console.warn('[payor] champ de clé introuvable : le gabarit a changé, vérifiez la page servie.');
  /* Le lecteur du champ disparaît avec lui, sinon l'appel planterait. */
  out = out.replace("const key = $('iaKey').value.trim();", "const key = '';   /* saisie retirée côté serveur */");
  return out;
}

/* `</body>` figure aussi dans les gabarits d'export Word, à l'intérieur de
   chaînes JavaScript : seule la dernière occurrence ferme vraiment la page. */
const PAGE_SERVIE = (() => {
  const base = sansChampCle(PAGE_APP);
  const i = base.lastIndexOf('</body>');
  return i < 0 ? base + BANDEAU
               : base.slice(0, i) + BANDEAU + '\n' + base.slice(i);
})();

/* extraction de la marque, pour que la page de garde porte le même logo
   que l'outil sans dupliquer le fichier */
const MARQUE = (() => {
  const m = /const LOGO_DEF = '([^']+)'/.exec(PAGE_APP);
  if (!m) return null;
  const d = /^data:([^;,]+)(;base64)?,(.*)$/.exec(m[1]);
  if (!d) return null;
  return { type: d[1],
           corps: d[2] ? Buffer.from(d[3], 'base64') : Buffer.from(decodeURIComponent(d[3])) };
})();

/* ═════════ routes ═════════ */
app.disable('x-powered-by');
app.set('trust proxy', 1);              /* Render place un proxy devant le service */
app.use(express.json({ limit: '64kb' }));
app.use(route(session));

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
    /* Le navigateur n'appelle plus Anthropic : tout passe par /api/ia. */
    "connect-src 'self' https://cdnjs.cloudflare.com; " +
    "worker-src 'self' blob:; frame-ancestors 'none'; base-uri 'self'");
  next();
});

app.get('/sante', route(async (_req, res) => {
  try {
    const r = await q('SELECT count(*)::int AS n FROM utilisateurs');
    res.json({ etat: 'ok', base: 'connectée', comptes: r.rows[0].n });
  } catch (e) {
    res.status(503).json({ etat: 'dégradé', base: e.code || e.message });
  }
}));

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

app.post('/api/connexion', route(async (req, res) => {
  const login = String(req.body.login || '').trim();
  const mdp   = String(req.body.mdp || '');
  const cle   = (req.ip || '') + '|' + norm(login);

  if (tropDEssais(cle))
    return res.status(429).json({ erreur: 'Trop de tentatives. Réessayez dans dix minutes.' });

  const u = await parLogin(login);
  /* Le message ne distingue pas l'identifiant inconnu du mot de passe faux :
     sinon la page devient un annuaire des comptes existants. */
  if (!u || !u.actif || !verifierMdp(mdp, u.mdp)) {
    noterEchec(cle);
    return res.status(401).json({ erreur: 'Identifiant ou mot de passe incorrect.' });
  }
  essais.delete(cle);
  await q('UPDATE utilisateurs SET derniere = now() WHERE id = $1', [u.id]);
  poserCookie(res, await ouvrirSession(u, req));
  res.json({ ok: true, doitChanger: u.doit_changer });
}));

app.get('/deconnexion', route(async (req, res) => {
  if (req.jeton) await fermerSession(req.jeton);
  res.clearCookie('ps_session', { path: '/' });
  res.redirect('/connexion');
}));

app.get('/api/moi', exigeSession, route(async (req, res) =>
  res.json({ login: req.u.login, nom: req.u.nom, role: req.u.role,
             doitChanger: req.u.doit_changer, droits: droitsDe(req.u),
             modules: MODULES, ia: Boolean(await cleIA()) })));

app.post('/api/mon-mot-de-passe', exigeSession, route(async (req, res) => {
  const { actuel, nouveau } = req.body || {};
  if (!verifierMdp(String(actuel || ''), req.u.mdp))
    return res.status(400).json({ erreur: 'Mot de passe actuel incorrect.' });
  if (String(nouveau || '').length < MDP_MIN)
    return res.status(400).json({ erreur: `Le nouveau mot de passe doit faire au moins ${MDP_MIN} caractères.` });

  await q('UPDATE utilisateurs SET mdp = $2, doit_changer = false WHERE id = $1',
    [req.u.id, empreinte(String(nouveau))]);
  await fermerToutes(req.u.id);         /* les autres sessions tombent */
  poserCookie(res, await ouvrirSession(req.u, req));
  res.json({ ok: true });
}));

/* ─── administration des comptes ─── */
const SELECT_VUE = `
  SELECT u.id, u.login, u.nom, u.role, u.actif, u.doit_changer, u.cree, u.derniere, u.droits,
         (SELECT count(*)::int FROM sessions s
           WHERE s.utilisateur = u.id AND s.expire > now()) AS sessions
    FROM utilisateurs u`;

const vue = r => ({ login: r.login, nom: r.nom, role: r.role, actif: r.actif,
                    cree: r.cree, derniere: r.derniere, droits: droitsDe(r),
                    doitChanger: r.doit_changer, sessions: r.sessions });

app.get('/admin', exigeSession, (req, res) => {
  if (req.u.role !== 'admin') return res.redirect('/');
  res.sendFile(path.join(__dirname, 'public', 'admin.html'));
});

app.get('/api/utilisateurs', exigeSession, exigeAdmin, route(async (_req, res) => {
  const r = await q(SELECT_VUE + ' ORDER BY u.role DESC, u.login_norm');
  const cle = await cleIA();
  res.json({ utilisateurs: r.rows.map(vue), base: 'postgres', modules: MODULES,
             ia: { definie: Boolean(cle), apercu: cle ? '…' + cle.slice(-4) : null,
                   parVariable: Boolean(CLE_ENV()),
                   enBase: Boolean(await lireReglage(CLE_IA)) } });
}));

app.post('/api/utilisateurs', exigeSession, exigeAdmin, route(async (req, res) => {
  const login = String(req.body.login || '').trim();
  const mdp   = String(req.body.mdp || '');
  if (!/^[A-Za-z0-9._@-]{3,64}$/.test(login))
    return res.status(400).json({ erreur: 'Identifiant : 3 à 64 caractères, lettres, chiffres, point, tiret, @ ou souligné.' });
  if (mdp.length < MDP_MIN)
    return res.status(400).json({ erreur: `Le mot de passe doit faire au moins ${MDP_MIN} caractères.` });
  if (await parLogin(login))
    return res.status(409).json({ erreur: 'Cet identifiant existe déjà.' });

  try {
    const u = await creerCompte({ login, nom: String(req.body.nom || '').trim(),
                                  role: req.body.role, mdp, droits: req.body.droits });
    res.json({ ok: true, utilisateur: vue({ ...u, sessions: 0 }) });
  } catch (e) {
    if (e.code === '23505') return res.status(409).json({ erreur: 'Cet identifiant existe déjà.' });
    throw e;
  }
}));

app.patch('/api/utilisateurs/:login', exigeSession, exigeAdmin, route(async (req, res) => {
  const u = await parLogin(req.params.login);
  if (!u) return res.status(404).json({ erreur: 'Compte introuvable.' });

  const champs = [], vals = [];
  const pose = (col, val, cast) => {
    champs.push(`${col} = $${champs.length + 2}${cast || ''}`); vals.push(val); };
  let couper = false;

  if (req.body.nom !== undefined) pose('nom', String(req.body.nom).trim() || u.login);

  if (req.body.actif !== undefined) {
    const actif = Boolean(req.body.actif);
    if (!actif && u.role === 'admin' && u.actif && (await nbAdmins()) <= 1)
      return res.status(400).json({ erreur: 'Il doit rester au moins un administrateur actif.' });
    pose('actif', actif);
    if (!actif) couper = true;
  }

  if (req.body.role !== undefined) {
    const role = req.body.role === 'admin' ? 'admin' : 'utilisateur';
    if (role !== 'admin' && u.role === 'admin' && (await nbAdmins()) <= 1)
      return res.status(400).json({ erreur: 'Il doit rester au moins un administrateur actif.' });
    pose('role', role);
  }

  if (req.body.mdp !== undefined) {
    if (String(req.body.mdp).length < MDP_MIN)
      return res.status(400).json({ erreur: `Le mot de passe doit faire au moins ${MDP_MIN} caractères.` });
    pose('mdp', empreinte(String(req.body.mdp)));
    pose('doit_changer', true);
    couper = true;
  }

  if (req.body.droits !== undefined)
    pose('droits', JSON.stringify(normDroits(req.body.droits)), '::jsonb');

  if (req.body.fermerSessions) couper = true;

  if (champs.length)
    await q(`UPDATE utilisateurs SET ${champs.join(', ')} WHERE id = $1`, [u.id, ...vals]);
  if (couper) await fermerToutes(u.id);

  const r = await q(SELECT_VUE + ' WHERE u.id = $1', [u.id]);
  res.json({ ok: true, utilisateur: vue(r.rows[0]) });
}));

app.delete('/api/utilisateurs/:login', exigeSession, exigeAdmin, route(async (req, res) => {
  const u = await parLogin(req.params.login);
  if (!u) return res.status(404).json({ erreur: 'Compte introuvable.' });
  if (u.id === req.u.id)
    return res.status(400).json({ erreur: 'On ne supprime pas son propre compte.' });
  if (u.role === 'admin' && u.actif && (await nbAdmins()) <= 1)
    return res.status(400).json({ erreur: 'Il doit rester au moins un administrateur actif.' });
  await q('DELETE FROM utilisateurs WHERE id = $1', [u.id]);   /* les sessions suivent */
  res.json({ ok: true });
}));

/* ─── clé API partagée ─── */
app.put('/api/cle-ia', exigeSession, exigeAdmin, route(async (req, res) => {
  /* Refuser plutôt qu'enregistrer une valeur que la variable d'environnement
     masquerait : une clé qu'on croit active et qui ne sert pas est pire
     qu'une saisie refusée. */
  if (CLE_ENV())
    return res.status(409).json({ erreur: 'La clé est fournie par la variable d\u2019environnement ' +
      'ANTHROPIC_API_KEY, qui l\u2019emporte sur toute saisie. Modifiez-la dans Render, ou retirez ' +
      'la variable pour reprendre la main ici.' });
  const cle = String(req.body.cle || '').trim();
  if (!cle) return res.status(400).json({ erreur: 'Clé vide.' });
  if (!/^sk-[A-Za-z0-9_\-]{20,}$/.test(cle))
    return res.status(400).json({ erreur: 'Cette chaîne ne ressemble pas à une clé Anthropic (sk-…).' });
  await ecrireReglage(CLE_IA, cle, req.u.login);
  oublierCle();
  res.json({ ok: true, apercu: '…' + cle.slice(-4) });
}));

app.delete('/api/cle-ia', exigeSession, exigeAdmin, route(async (_req, res) => {
  await q('DELETE FROM reglages WHERE cle = $1', [CLE_IA]);
  oublierCle();
  res.json({ ok: true, parVariable: Boolean(CLE_ENV()) });
}));

/* Relais vers Anthropic. La clé ne quitte jamais le serveur, et le droit
   « assistant » se vérifie ici : à la différence du grisage des onglets, qui
   n'est qu'un garde-fou d'interface, ce refus-là tient vraiment. */
app.post('/api/ia', exigeSession, route(async (req, res) => {
  if (!peut(req.u, 'assistant'))
    return res.status(403).json({ error: { message: 'L\u2019assistant n\u2019est pas ouvert à ce compte.' } });
  const cle = await cleIA();
  if (!cle)
    return res.status(401).json({ error: { message: 'Aucune clé API n\u2019est enregistrée. ' +
      'Un administrateur doit en saisir une dans la gestion des accès.' } });
  try {
    const r = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-api-key': cle,
                 'anthropic-version': '2023-06-01' },
      body: JSON.stringify(req.body || {})
    });
    const texte = await r.text();
    res.status(r.status).type(r.headers.get('content-type') || 'application/json').send(texte);
  } catch (ex) {
    console.error('[payor] relais IA :', ex.message);
    res.status(502).json({ error: { message: 'Le service de réponse est injoignable depuis le serveur.' } });
  }
}));

/* ─── l'outil, derrière la porte ─── */
app.get('/', exigeSession, (_req, res) => {
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  res.send(PAGE_SERVIE);
});

app.use(express.static(path.join(__dirname, 'public'), { index: false }));

app.use((req, res) => {
  if (req.path.startsWith('/api/')) return res.status(404).json({ erreur: 'route inconnue' });
  res.redirect(req.u ? '/' : '/connexion');
});

app.use((err, req, res, _next) => {
  console.error('[payor]', req.method, req.path, '→', err.message);
  if (req.path.startsWith('/api/'))
    return res.status(500).json({ erreur: 'Le service a rencontré une erreur.' });
  res.status(500).send('Le service a rencontré une erreur.');
});

/* ═════════ démarrage ═════════ */
(async () => {
  await attendreBase();
  await migrer();
  await amorcer();
  await purgerSessions();
  setInterval(() => purgerSessions().catch(() => {}), 3600 * 1000).unref();

  const n = (await q('SELECT count(*)::int AS n FROM utilisateurs')).rows[0].n;
  app.listen(PORT, () => {
    console.log(`[payor] en écoute sur le port ${PORT}`);
    console.log(`[payor] base PostgreSQL connectée · ${n} compte(s)`);
  });
})().catch(e => {
  console.error('[payor] démarrage impossible :', e.message);
  process.exit(1);
});
