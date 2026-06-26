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
        │ (Audio traduit 24kHz PCM)
        ▼ (Diffusion Multiplexée)
[📱 Smartphones des Fidèles]
```

* **Serveur Central unique** : Seul le serveur Node.js maintient la connexion WebSocket avec l'API Gemini (une connexion par langue cible, par exemple l'Anglais).
* **Diffusion multiplexée (Broadcasting)** : Le serveur reçoit le flux traduit et le redistribue à tous les fidèles connectés via des WebSockets locaux. **Le coût reste fixe, peu importe s'il y a 10 ou 500 personnes qui écoutent.**

---

## ✨ Fonctionnalités

* **Traduction en direct de haute qualité** : Utilise le modèle officiel de traduction de Google (`models/gemini-3.5-live-translate-preview`).
* **Optimisation budgétaire** : Coût fixe par langue active (environ $2.20/heure par langue), totalement indépendant du nombre d'auditeurs.
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
   * `TARGET_LANGUAGES` : Les langues cibles disponibles pour la traduction, séparées par des virgules (ex: `en,es,pt`).
   * `CHURCH_NAME` : Le nom de votre église qui s'affichera sur l'écran des fidèles.

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
1. Connectez les téléphones des fidèles au réseau **Wi-Fi de l'église**.
2. Partagez l'URL **Public** (ex: `http://192.168.1.50:3000`) via un QR Code affiché à l'accueil ou projeté sur les écrans.
3. Les fidèles ouvrent l'URL sur leur smartphone, choisissent leur langue de préférence et cliquent sur "Écouter la traduction". Ils n'ont plus qu'à brancher leurs écouteurs.

---

## 🛠️ Technologies Utilisées

* **Backend** : Node.js, Express, `ws` (WebSockets rapides).
* **Frontend Admin** : HTML5, Vanilla CSS (Glassmorphism), AudioWorklet API (capture et rééchantillonnage de l'audio en 16kHz PCM mono directement dans le navigateur).
* **Frontend Client** : HTML5, Vanilla CSS, Web Audio API (décodage et lecture continue de flux PCM 24kHz par buffer circulaire).
* **Moteur de Traduction** : API Gemini Multimodal Live (WebSockets bi-directionnels à ultra-faible latence).
