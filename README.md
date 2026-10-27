# PAYOR SIMUL — déploiement sur Render

L'outil reste le fichier HTML autonome que vous connaissez. Ce dépôt ajoute
seulement une porte devant : une page de garde, des comptes nommés, et une page
d'administration pour créer et retirer les accès.

**Aucune donnée de paie n'entre en base.** Les dossiers restent enregistrés dans
le navigateur de chaque utilisateur, exactement comme avant. PostgreSQL ne
contient que deux tables : les comptes et les sessions ouvertes.

---

## Ce que contient le dépôt

```
server.js                  le serveur : authentification, sessions, administration
app/payor-simul.html       l'outil, servi uniquement aux personnes connectées
public/connexion.html      la page de garde
public/admin.html          la gestion des accès
outils/empreinte.js        fabrique l'empreinte d'un mot de passe
render.yaml                la description du service et de la base
```

Deux dépendances : Express et `pg`. Le chiffrement des mots de passe (scrypt) et
les jetons de session utilisent le module `crypto` de Node, rien de plus.

---

## Déployer

Render déploie depuis un dépôt Git. Poussez d'abord ce dossier sur GitHub,
GitLab ou Bitbucket.

```bash
cd payor-render
git init
git add .
git commit -m "PAYOR SIMUL — accès protégé"
git remote add origin git@github.com:VOTRE-COMPTE/payor-simul.git
git push -u origin main
```

Sur Render : **New › Blueprint**, choisissez le dépôt. Le fichier `render.yaml`
crée la base `payor-base`, le service web, et relie `DATABASE_URL` de l'une à
l'autre. Il ne reste qu'à renseigner `ADMIN_LOGIN` et `ADMIN_MDP` dans le
tableau de bord.

À la main, si vous préférez : créez d'abord la base (**New › PostgreSQL**), puis
le service (**New › Web Service**) avec `npm install` en build, `node server.js`
en démarrage, `/sante` en *health check*, et recopiez la chaîne de connexion
**interne** de la base dans `DATABASE_URL`.

### Les variables d'environnement

| Variable | Rôle |
|---|---|
| `DATABASE_URL` | **Indispensable.** Fournie par Render si vous passez par le Blueprint. Depuis Render même, utilisez la chaîne *interne* : elle ne sort pas du réseau privé. |
| `NODE_ENV` | `production` — le cookie de session n'est alors transmis qu'en HTTPS. |
| `ADMIN_LOGIN` | L'identifiant du premier administrateur. |
| `ADMIN_MDP` | Son mot de passe de départ. Laissez vide et le serveur en tirera un au sort, visible une seule fois dans les journaux de démarrage. |
| `ADMIN_NOM` | Son nom affiché. Facultatif. |
| `ANTHROPIC_API_KEY` | La clé de l'assistant, partagée par tous les comptes dont le module est ouvert. Elle l'emporte sur toute clé saisie dans l'interface. |
| `COMPTES` | Facultatif : amorcer plusieurs comptes d'un coup à la toute première mise en service (voir plus bas). |
| `PG_POOL_MAX` | Nombre maximal de connexions à la base. Cinq par défaut, ce qui convient aux petits plans. |

### Le schéma

Les trois tables sont créées au démarrage si elles manquent — rien à exécuter à
la main. Un redéploiement ne touche à rien, et une installation antérieure se
met à niveau toute seule.

```
utilisateurs   id · login · nom · rôle · empreinte du mot de passe · actif
               · doit_changer · droits · créé le · dernière connexion
sessions       empreinte du jeton · utilisateur · créée le · vue le · expire
               · adresse · navigateur
reglages       clé · valeur · mise à jour le · par qui
```

### Le plan de la base

`render.yaml` déclare la base en plan **gratuit**. Une base gratuite chez Render
est **supprimée au bout de trente jours** : pour un usage réel, passez-la sur un
plan payant depuis le tableau de bord avant cette échéance. Si Render refuse le
nom de plan au moment du Blueprint — ils changent au fil du temps — créez la
base à la main et retirez le bloc `databases` du fichier.

Le service web, lui, peut rester en plan gratuit : plus aucun disque n'est
nécessaire puisque tout vit en base. Sachez simplement qu'une instance gratuite
s'endort après une période d'inactivité, et que la première connexion de la
journée prendra une trentaine de secondes.

---

## À l'usage

- `/` — l'outil, réservé aux personnes connectées.
- `/connexion` — la page de garde.
- `/admin` — la gestion des accès, réservée aux administrateurs.
- `/sante` — l'état du service et de la base, pour la surveillance de Render.

**Créer un accès.** Depuis `/admin`, saisissez un identifiant et tirez un mot de
passe. Il est provisoire : la personne devra le remplacer à sa première
connexion. Transmettez-le par un autre canal que celui où vous envoyez le lien.

**Retirer un accès.** *Suspendre* ferme les sessions en cours sans rien effacer ;
*Supprimer* retire le compte, et ses sessions partent avec lui. Dans les deux
cas l'effet est immédiat.

**Fermer les sessions** d'une personne la déconnecte de tous ses postes sans
toucher à son compte — pratique quand un ordinateur a été laissé ouvert
quelque part. La colonne *Sessions* indique combien sont ouvertes.

**Réinitialiser un mot de passe** produit un nouveau mot de passe provisoire,
affiché une seule fois, et ferme les sessions de la personne.

### Les modules ouverts à chaque accès

Un accès n'ouvre pas forcément tout l'outil. Sept modules se cochent à la
création d'un compte, et se modifient ensuite depuis le bouton *Modules* de sa
ligne :

| Module | Ce qu'il couvre |
|---|---|
| Traitement individuel | Parts, IR, calcul à l'envers, bulletin, retraite, licenciement, avantages |
| Traitement groupé | Les mêmes calculs sur un effectif importé, et l'édition des bulletins en lot |
| Déclaration annuelle des salaires | Contrôle des deux pages avant dépôt et rapport Word |
| Modèles de documents | Les vingt et un modèles et le publipostage |
| Assistant IA | Questions en langage libre sur les documents chargés |
| Barème et taux | Modification du barème de l'impôt, des paliers et des cotisations |
| Dossier | Import et export du dossier, effectifs, identité visuelle |

Un module fermé **reste visible dans le menu, grisé** : on voit ce que l'outil
contient, et à qui s'adresser pour y accéder. L'administrateur garde toujours
tout — il lui faut de quoi rouvrir ce qu'il viendrait de se retirer.

Les mentions de bas d'écran — charte graphique, portée des modèles, avertissement
général — ne s'affichent que pour les administrateurs.

Un changement de droits prend effet au prochain chargement de l'outil. Pour
qu'il soit immédiat, fermez les sessions de la personne.

### La clé API de l'assistant

Une seule clé pour tout le monde. Elle reste sur le serveur et **ne ressort
jamais** : l'interface n'en montre que les quatre derniers caractères.
L'assistant de l'outil passe par un relais (`POST /api/ia`) qui ajoute la clé
côté serveur — aucune clé ne transite par les navigateurs, et le relais refuse
les comptes dont le module Assistant est fermé.

Deux emplacements possibles, et c'est **la variable d'environnement qui fait
autorité** :

| Emplacement | Quand l'utiliser |
|---|---|
| `ANTHROPIC_API_KEY` | Le choix recommandé. La clé vit avec les autres secrets du service, hors de la base, et se change dans le tableau de bord Render sans toucher aux données. |
| Le champ de `/admin` | À défaut de variable. La clé est enregistrée dans la table `reglages`. |

Tant que `ANTHROPIC_API_KEY` est renseignée, le champ de l'interface est grisé
et toute saisie est refusée avec un message explicite : une clé qu'on croit
active et qui ne sert pas vaut moins qu'une saisie refusée. Si une clé traîne
encore en base, l'interface le signale et propose de la retirer.

**Personne ne peut saisir sa propre clé.** Le champ « Clé API Anthropic » de
l'onglet Assistant est retiré de la page servie — pas masqué, retiré : il
n'apparaît pas dans le code reçu par le navigateur, et le lecteur de ce champ
est neutralisé. L'assistant passe toujours par `/api/ia`, et la politique de
sécurité du contenu interdit au navigateur d'appeler Anthropic directement.

Sans clé côté serveur, l'assistant répond donc qu'aucune clé n'est enregistrée
et renvoie vers l'administrateur. Le fichier `app/payor-simul.html` conserve son
champ : ouvert seul, hors serveur, c'est le seul moyen de s'en servir.

Le dernier administrateur actif ne peut être ni suspendu, ni rétrogradé, ni
supprimé : sans lui, plus personne ne pourrait créer de compte.

### Amorcer plusieurs comptes

Utile seulement à la toute première mise en service, quand la table est vide.

```bash
node outils/empreinte.js "la phrase de passe de cette personne"
# → scrypt$...$...
```

Collez dans la variable `COMPTES`, sur une seule ligne :

```json
[
  {"login":"adiouf","nom":"A. Diouf","role":"admin","mdp":"scrypt$...$..."},
  {"login":"fsarr","nom":"Fatou SARR","role":"utilisateur","mdp":"scrypt$...$..."}
]
```

Ensuite, tout se gère depuis `/admin` : la variable n'est plus relue.

---

## Ce qui est en place côté sécurité

- Mots de passe stockés en empreinte scrypt avec sel, jamais en clair.
- Le navigateur reçoit un jeton aléatoire de 32 octets ; **la base n'en garde
  que l'empreinte SHA-256**. Une copie de la table ne livre aucune session
  utilisable.
- Cookie `httpOnly`, `SameSite=Lax`, `Secure` en production, douze heures,
  prolongé à l'usage.
- Fermer une session, suspendre un compte ou changer un mot de passe supprime
  les lignes correspondantes : la déconnexion est immédiate, sans attendre
  l'expiration du cookie.
- Huit tentatives ratées par identifiant et par adresse bloquent les connexions
  pendant dix minutes.
- Le même message répond à un identifiant inconnu et à un mot de passe faux : la
  page de garde ne sert pas d'annuaire.
- En-têtes `X-Frame-Options`, `X-Content-Type-Options`, `Referrer-Policy` et une
  politique de sécurité du contenu.
- Les sessions expirées sont purgées au démarrage puis toutes les heures.

## Ce qui ne l'est pas, et qu'il faut savoir

- **Pas de second facteur.** Un mot de passe suffit à entrer.
- **Le grisage des modules est un garde-fou d'interface, pas une barrière.**
  L'outil est un fichier unique servi en entier au navigateur : quelqu'un de
  déterminé peut atteindre le code d'un onglet fermé. Ce qui tient vraiment,
  c'est le refus côté serveur — et c'est le cas du relais de l'assistant, qui
  vérifie le droit avant d'appeler Anthropic. Pour que les autres modules
  soient réellement cloisonnés, il faudrait découper l'outil et servir chaque
  partie séparément.
- **TLS vers la base** : depuis Render, utilisez la chaîne de connexion interne,
  qui ne quitte pas le réseau privé. Pour une connexion venue de l'extérieur, le
  serveur chiffre mais ne vérifie pas la chaîne de certification ; si cela
  compte pour vous, fournissez l'autorité de Render et remplacez
  `rejectUnauthorized: false` dans `server.js`.
- **Trois bibliothèques viennent de cdnjs** — lecture des fichiers Excel, PDF et
  Word. Elles sont chargées depuis le navigateur de l'utilisateur, à la demande.
  Pour un fonctionnement entièrement hors ligne, il faudrait les héberger ici.
- **L'onglet Assistant IA** appelle `api.anthropic.com` depuis le navigateur,
  avec une clé que l'utilisateur saisit lui-même. Rien n'est mutualisé, et
  l'onglet reste inerte tant qu'aucune clé n'est renseignée.
- **Le journal se limite à la dernière connexion** par compte, plus les sessions
  ouvertes. Si vous avez besoin d'une piste d'audit complète, c'est à ajouter —
  la table `sessions` en est la bonne base de départ.

---

## En local

```bash
npm install
export DATABASE_URL="postgresql://payor@127.0.0.1:5432/payor?sslmode=disable"
ADMIN_LOGIN=admin ADMIN_MDP=motdepasselocal node server.js
# puis http://localhost:3000
```
