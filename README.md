# ✝ TransAudio — Traduction de Prêche en Direct

TransAudio est une application web performante et légère conçue pour traduire en temps réel les prédications dans les églises. 

L'application capture le signal audio de la prédication (depuis la table de mixage connectée au PC de la régie multimédia), l'envoie à l'API **Gemini 3.5 Live Translate** pour le traduire instantanément en plusieurs langues, puis diffuse le flux audio traduit aux fidèles sur leurs smartphones via le Wi-Fi de l'église.

---

## 🏗️ Architecture et Optimisation des Coûts

Pour éviter des coûts d'API astronomiques (qui surviendraient si chaque téléphone appelait l'API individuellement), TransAudio utilise une architecture centralisée :

```
[🎤 Table de mixage] 
        │ (Audio analogique)
        ▼
[💻 Régie Multimédia / Navigateur Admin] 
        │ (Audio 16kHz PCM via WebSocket)
        ▼
[🖥️ Serveur Central Node.js] ◄─── (Traduction Temps Réel) ───► [🤖 API Gemini Live]
        │ (Audio traduit → flux MP3 48 kbit/s par langue + sous-titres)
        ▼ (Diffusion Multiplexée)
[📱 Smartphones des Fidèles]
```

* **Serveur Central unique** : Seul le serveur Node.js maintient la connexion WebSocket avec l'API Gemini (une connexion par langue cible, par exemple l'Anglais).
* **Diffusion multiplexée (Broadcasting)** : Le serveur reçoit le flux traduit, l'encode en un flux **MP3 continu** (une « radio » par langue, ~6 Ko/s par téléphone) et le redistribue à tous les fidèles. Les sous-titres passent par une WebSocket. **Le coût API reste le même, qu'il y ait 10 ou 500 personnes qui écoutent.**
* **Écran verrouillé** : le téléphone lit le flux avec un simple lecteur audio : le son continue écran verrouillé (iPhone et Android), avec les commandes sur l'écran de verrouillage.
* **Sessions longues** : les connexions Gemini sont limitées dans le temps par Google ; le serveur les renouvelle automatiquement (reprise de session) sans perdre l'audio.

---

## ✨ Fonctionnalités

* **Traduction en direct de haute qualité** : Utilise le modèle officiel de traduction de Google (`models/gemini-3.5-live-translate-preview`).
* **Optimisation budgétaire** : une seule connexion Gemini par langue active, quel que soit le nombre d'auditeurs (facturation Google au volume d'audio traité).
* **Sous-titres en direct** sur le téléphone des fidèles, et transcription (original + traduction) sur la console de régie.
* **Lanceurs en un clic** : Scripts de démarrage automatique inclus pour Windows (`start.bat`) et macOS/Linux (`start.sh`).
* **Interface Admin Régie** : Style console de diffusion sombre avec sélection dynamique des entrées audio et VU-mètre réactif en temps réel.
* **Interface Fidèle Mobile-First** : Thème sombre et doré, épuré, avec sélection simplifiée de la langue et reconnexion automatique en cas de coupure du Wi-Fi.

---

## ⚙️ Configuration

1. À la racine du projet, copiez le fichier de configuration d'exemple :
   ```bash
   cp .env.example .env
   ```
2. Ouvrez le fichier `.env` nouvellement créé et configurez vos variables :
   * `GEMINI_API_KEY` : Votre clé API obtenue sur [Google AI Studio](https://aistudio.google.com/apikey).
   * `PORT` : Le port de votre serveur (par défaut `3000`).
   * `TARGET_LANGUAGES` : Les langues proposées **au démarrage du serveur**, séparées par des virgules (ex: `en,es,pt`). Ensuite, la régie choisit les langues depuis la console (cases à cocher, 6 max) : le changement s'applique tout de suite sur les téléphones, même pendant la traduction. La console mémorise son dernier choix et le rétablit si le serveur redémarre.
   * `CHURCH_NAME` : Le nom de votre église qui s'affichera sur l'écran des fidèles.
   * `ADMIN_PASSWORD` : Mot de passe de la console de régie (indispensable si le serveur est accessible par d'autres personnes).
   * `PUBLIC_URL` : (optionnel) adresse publique si le serveur est hébergé en ligne.
   * `LOCAL_IP` : (optionnel) force l'adresse IP affichée si la détection automatique se trompe.

---

## 🚀 Démarrage Rapide

### Sur Windows
Double-cliquez simplement sur le fichier **`start.bat`** à la racine du projet.
*Le script vérifie si Node.js est présent. S'il est manquant, il l'installe automatiquement via `winget`, installe les dépendances requises (`npm install`) au premier démarrage, puis lance le serveur.*

### Sur macOS ou Linux
Double-cliquez sur le fichier **`start.sh`** ou exécutez-le dans un terminal :
  ```bash
  ./start.sh
  ```
*Le script gère automatiquement l'installation de Node.js (via Homebrew sur Mac ou le gestionnaire de paquets natif sur Linux), configure les dépendances et démarre le serveur.*

---

## 📖 Guide d'Utilisation

Une fois le serveur démarré, la console affiche les adresses de connexion :

```
╔══════════════════════════════════════════════════════════╗
║         ✝  TransAudio — Traduction en Direct  ✝        ║
╠══════════════════════════════════════════════════════════╣
║  Admin  : http://localhost:3000/admin/                  ║
║  Public : http://192.168.1.50:3000                      ║
╚══════════════════════════════════════════════════════════╝
```

### 1. Configuration de la Régie (Admin)
1. Ouvrez l'adresse **Admin** (`http://localhost:3000/admin/`) sur le PC de la régie.
2. Dans le menu déroulant, sélectionnez l'entrée audio correspondant à votre **table de mixage** (ou carte son).
3. Cochez la ou les langues que vous souhaitez activer pour ce service.
4. Cliquez sur **Démarrer la Traduction**. Le VU-mètre commencera à s'animer pour indiquer la capture du son.

### 2. Écoute pour les Fidèles (Public)
Le QR code affiché dans la console de régie (carte « Informations de Connexion ») pointe vers l'adresse publique. Projetez-le ou imprimez-le.

1. Connectez les téléphones des fidèles au réseau **Wi-Fi de l'église**.
2. Partagez l'URL **Public** (ex: `http://192.168.1.50:3000`) via un QR Code affiché à l'accueil ou projeté sur les écrans.
3. Les fidèles ouvrent l'URL sur leur smartphone, choisissent leur langue de préférence et cliquent sur "Écouter la traduction". Ils n'ont plus qu'à brancher leurs écouteurs.

---

## ☁️ Mise en ligne sur Netlify

Le serveur tourne sur **Netlify Server** (Early Access) : `netlify/server/index.mjs` démarre le serveur Node, `netlify.toml` publie un dossier volontairement vide (`netlify/static`) pour qu'aucun fichier du projet (comme `.env`) ne soit exposé.

Variables à définir dans Netlify (*Project configuration → Environment variables*), puis redéployer :
`GEMINI_API_KEY` (secret), `ADMIN_PASSWORD` (sans lui, la console est verrouillée en ligne), `CHURCH_NAME`, `TARGET_LANGUAGES`, `PUBLIC_URL`.

Limites du plan Free : un seul petit serveur, **~30 auditeurs simultanés** (32 requêtes en parallèle) et connexions coupées toutes les **30 minutes** (le téléphone et la console se reconnectent automatiquement, coupure d'environ 1 s). Les plans payants montent à 2 h et à plusieurs instances.

---

## 📶 Quel réseau pour les fidèles ?

| Solution | Pour qui | Points d'attention |
|---|---|---|
| **Serveur hébergé en ligne (recommandé)** | Toute église | Les fidèles utilisent leur 4G/5G ou n'importe quel Wi-Fi, même depuis chez eux. HTTPS. ~22 Mo/heure par auditeur. Nécessite `ADMIN_PASSWORD` et `PUBLIC_URL`. |
| **Routeur Wi-Fi dédié à la traduction** | Pas d'hébergement en ligne | Un petit routeur (30–40 €) relié au PC de régie, isolation des clients **désactivée**. Afficher un QR code pour le Wi-Fi et un pour l'adresse. |
| **Wi-Fi de l'église** | Si vous gérez la box | Vérifier que l'**isolation des clients** et le **réseau invité** ne bloquent pas les échanges entre appareils (sinon : `ERR_ADDRESS_UNREACHABLE`). |
| **Point d'accès mobile du PC** | Tests, petit groupe | Windows limite à 8 appareils environ. |

Le PC de régie a toujours besoin d'Internet (connexion à Gemini).

---

## 🛠️ Technologies Utilisées

* **Backend** : Node.js, Express, `ws` (WebSockets rapides).
* **Frontend Admin** : HTML5, Vanilla CSS (Glassmorphism), AudioWorklet API (capture et rééchantillonnage de l'audio en 16kHz PCM mono directement dans le navigateur).
* **Frontend Client** : HTML5, Vanilla CSS, élément `<audio>` lisant un flux MP3 en direct (encodé côté serveur avec `@breezystack/lamejs`), Media Session API, sous-titres via WebSocket.
* **Moteur de Traduction** : API Gemini Multimodal Live (WebSockets bi-directionnels à ultra-faible latence).
