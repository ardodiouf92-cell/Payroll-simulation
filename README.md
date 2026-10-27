# PAYOR SIMUL — déploiement sur Render

L'outil reste le fichier HTML autonome que vous connaissez. Ce dépôt ajoute
seulement une porte devant : une page de garde, des comptes nommés, et une page
d'administration pour créer et retirer les accès.

**Aucune donnée de paie ne transite par le serveur.** Les dossiers restent
enregistrés dans le navigateur de chaque utilisateur, exactement comme avant. Le
serveur ne connaît que des identifiants, des empreintes de mots de passe et des
dates de connexion.

---

## Ce que contient le dépôt

```
server.js                  le serveur : authentification, sessions, administration
app/payor-simul.html       l'outil, servi uniquement aux personnes connectées
public/connexion.html      la page de garde
public/admin.html          la gestion des accès
outils/empreinte.js        fabrique l'empreinte d'un mot de passe
render.yaml                la description du service, pour un déploiement en un clic
```

Une seule dépendance : Express. Le chiffrement des mots de passe (scrypt) et la
signature des sessions utilisent le module `crypto` de Node, rien de plus.

---

## Déployer

Render déploie depuis un dépôt Git. Il faut donc d'abord pousser ce dossier sur
GitHub, GitLab ou Bitbucket.

```bash
cd payor-simul
git init
git add .
git commit -m "PAYOR SIMUL — accès protégé"
git remote add origin git@github.com:VOTRE-COMPTE/payor-simul.git
git push -u origin main
```

Sur Render, deux chemins.

**Par le fichier `render.yaml`** — *New* › *Blueprint*, choisissez le dépôt.
Render lit le fichier et crée le service avec son disque et ses variables.

**À la main** — *New* › *Web Service*, choisissez le dépôt, puis :

| Réglage | Valeur |
|---|---|
| Runtime | Node |
| Build command | `npm install` |
| Start command | `node server.js` |
| Health check path | `/sante` |

### Les variables d'environnement

| Variable | Rôle |
|---|---|
| `SESSION_SECRET` | **Indispensable.** Une longue chaîne aléatoire. Sans elle, un redémarrage déconnecte tout le monde. |
| `NODE_ENV` | `production` — le cookie de session n'est alors transmis qu'en HTTPS. |
| `DATA_DIR` | Le chemin du disque persistant, par exemple `/var/data`. |
| `ADMIN_LOGIN` | L'identifiant du premier administrateur. |
| `ADMIN_MDP` | Son mot de passe de départ. Laissez vide et Render en tirera un au sort, visible une seule fois dans les journaux de démarrage. |
| `ADMIN_NOM` | Son nom affiché. Facultatif. |

Pour fabriquer un `SESSION_SECRET` :

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

---

## La question du disque

C'est le seul point à trancher avant de déployer.

**Avec un disque persistant** — montez-en un sur `/var/data` et renseignez
`DATA_DIR`. Les comptes créés depuis la page d'administration survivent aux
déploiements. C'est le fonctionnement normal, et celui que décrit `render.yaml`.
Un disque exige au minimum le plan **Starter**, payant.

**Sans disque — plan gratuit** — le système de fichiers est remis à neuf à chaque
déploiement : un compte créé depuis l'interface disparaîtrait au redéploiement
suivant. Tenez alors la liste dans une variable d'environnement `COMPTES`, relue
à chaque démarrage :

```bash
node outils/empreinte.js "la phrase de passe de cette personne"
# → scrypt$...$...
```

```json
[
  {"login":"adiouf","nom":"A. Diouf","role":"admin","mdp":"scrypt$...$..."},
  {"login":"fsarr","nom":"Fatou SARR","role":"utilisateur","mdp":"scrypt$...$..."}
]
```

Collez ce tableau, sur une seule ligne, dans la variable `COMPTES`. Ajouter ou
retirer quelqu'un revient alors à modifier cette variable. La page
d'administration reste consultable, mais elle affiche un avertissement : ses
modifications ne tiendront pas.

Sachez aussi qu'une instance gratuite s'endort après une période d'inactivité :
la première connexion de la journée prendra une trentaine de secondes.

---

## À l'usage

- `/` — l'outil, réservé aux personnes connectées.
- `/connexion` — la page de garde.
- `/admin` — la gestion des accès, réservée aux administrateurs.
- `/sante` — l'état du service, pour la surveillance de Render.

**Créer un accès.** Depuis `/admin`, saisissez un identifiant et tirez un mot de
passe. Il est provisoire : la personne devra le remplacer à sa première
connexion. Transmettez-le par un autre canal que celui où vous envoyez le lien.

**Retirer un accès.** *Suspendre* coupe immédiatement les sessions en cours sans
rien effacer ; *Supprimer* retire le compte. Dans les deux cas l'effet est
instantané, sans attendre l'expiration du cookie.

**Réinitialiser un mot de passe** produit un nouveau mot de passe provisoire,
affiché une seule fois, et coupe les sessions de la personne.

Le dernier administrateur actif ne peut être ni suspendu, ni rétrogradé, ni
supprimé : sans lui, plus personne ne pourrait créer de compte.

---

## Ce qui est en place côté sécurité

- Mots de passe stockés en empreinte scrypt avec sel, jamais en clair.
- Session dans un cookie signé HMAC-SHA256, `httpOnly`, `SameSite=Lax`,
  `Secure` en production, valable douze heures.
- Huit tentatives ratées par identifiant et par adresse bloquent les connexions
  pendant dix minutes.
- Le même message répond à un identifiant inconnu et à un mot de passe faux : la
  page de garde ne sert pas d'annuaire.
- En-têtes `X-Frame-Options`, `X-Content-Type-Options`, `Referrer-Policy` et une
  politique de sécurité du contenu.

## Ce qui ne l'est pas, et qu'il faut savoir

- **Pas de second facteur.** Un mot de passe suffit à entrer.
- **Trois bibliothèques viennent de cdnjs** — lecture des fichiers Excel, PDF et
  Word. Elles sont chargées depuis le navigateur de l'utilisateur, à la demande.
  Pour un fonctionnement entièrement hors ligne, il faudrait les héberger ici.
- **L'onglet Assistant IA** appelle `api.anthropic.com` depuis le navigateur,
  avec une clé que l'utilisateur saisit lui-même. Rien n'est mutualisé, et
  l'onglet reste inerte tant qu'aucune clé n'est renseignée.
- **Le journal des connexions se limite à la dernière date** par compte. Si vous
  avez besoin d'une piste d'audit, c'est à ajouter.

---

## En local

```bash
npm install
SESSION_SECRET=essai ADMIN_LOGIN=admin ADMIN_MDP=motdepasselocal node server.js
# puis http://localhost:3000
```
