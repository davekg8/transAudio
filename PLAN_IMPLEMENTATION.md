# Plan d'implémentation — Correction et mise à jour
Date : 25 juillet 2026
Référence : `AUDIT_DEFAUTS.md`

## Principe directeur
La priorité absolue est de rendre l'application **fiable, fonctionnelle et sécurisée en environnement d'église réel**. 
Le plan d'action suit une séquence stricte :
1. **Trancher les arbitrages conceptuels et réseau** (accès Wi-Fi / AP Isolation et modèle Gemini) avec le responsable du projet (Phase 0).
2. **Corriger les bugs critiques de décodage audio et d'authentification** qui empêchent totalement l'écoute sur smartphone ou compromettent la régie (Phase 1).
3. **Restructurer l'architecture audio et réseau** (AudioWorklet, AudioWorkletNode/AudioContext resampling, limitation de débit, sécurisation des logs) pour assurer la stabilité du flux (Phase 2).
4. **Assainir le code, la documentation et les outils d'administration** (QR Code réel, suppression des API dépréciées, nettoyage de la dette technique) (Phase 3).

---

## Phase 0 — Décisions à trancher avant de coder

Ces arbitrages stratégiques doivent être validés par l'humain responsable du projet avant le démarrage de l'implémentation technique.

### 0.1 Strategie d'accès réseau local et contournement de l'AP Isolation Wi-Fi
- **Contexte / Problème** : L'AP Isolation sur le Wi-Fi des églises bloque l'accès direct aux adresses IP locales (`http://192.168.x.x:3000`).
- **Options à trancher** :
  - **Option A (Recommandée - Tunnel sécurisé HTTPS/WSS)** : Intégrer un script / service léger (ex: Cloudflare Tunnel `cloudflared` ou `localtunnel`) au démarrage du serveur. Cela fournit automatiquement une URL publique HTTPS sécurisée (ex: `https://eglise-traduction.trycloudflare.com`) accessible par tous les fidèles même sur réseau Wi-Fi isolé ou en 4G/5G, et garantit le HTTPS indispensable pour iOS.
  - **Option B (Configuration réseau locale)** : Imposer dans la documentation que l'église configure un sous-réseau Wi-Fi spécifique sans AP Isolation et mette en place un mDNS / nom de domaine local.

### 0.2 Modèle Gemini par défaut et stratégie de repli (Fallback)
- **Contexte / Problème** : La chaîne `'models/gemini-3.5-live-translate-preview'` est codée en dur.
- **Options à trancher** :
  - Permettre la configuration de `GEMINI_MODEL` dans `.env` (avec comme valeur par défaut `models/gemini-2.0-flash-exp` ou `models/gemini-3.1-flash-live-preview`), et implémenter un fallback automatique vers les modèles secondaires compatibles `bidiGenerateContent`.

### 0.3 Clarté de la facturation et mise à jour des documents de communication
- **Contexte / Problème** : Le tarif horaire fixe de $2.20/h est inexact.
- **Options à trancher** :
  - Reformuler le README et les pages d'information pour expliquer en toute transparence la facturation aux jetons audio Gemini et l'impact de la mise en pause du micro.

---

## Phase 1 — Corrections critiques

### Action 1.1 — Correction de l'alignement mémoire dans le décodeur audio client
- **Défaut lié** : CDE1 (Exception fatale d'alignement mémoire dans `AudioPlayer`)
- **Action concrète** :
  Modifier `public/audio-player.js` dans la méthode `_decodeBase64ToFloat32` pour passer explicitement `byteOffset` et la longueur exacte de paires d'octets lors de l'instanciation de `Int16Array` :
  ```javascript
  const int16 = new Int16Array(bytes.buffer, bytes.byteOffset, Math.floor(bytes.byteLength / 2));
  ```
  Ajouter un bloc `try/catch` de sécurité qui retourne un tableau vide au lieu de faire planter l'application en cas d'octet tronqué.
- **Fichiers concernés** : `public/audio-player.js`
- **Risque de régression** : Aucun.
- **Effort estimé** : S

### Action 1.2 — Support universel du SampleRate mobile et élimination de l'effet "Chipmunk"
- **Défaut lié** : CDE3 (Incompatibilité de SampleRate sur les téléphones mobiles)
- **Action concrète** :
  Dans `public/audio-player.js` :
  1. Instancier `AudioContext` sans forcer un `sampleRate` non supporté par le matériel mobile : `this._ctx = new AC();`.
  2. Récupérer la fréquence réelle du contexte (`this._ctx.sampleRate`, ex: 44100 ou 48000 Hz).
  3. Si la fréquence réelle diffère de la fréquence source Gemini (`24000 Hz`), appliquer un rééchantillonnage linéaire ou spline fluide lors du décodage du tampon source vers la fréquence du contexte avant d'insérer dans le tampon circulaire.
- **Fichiers concernés** : `public/audio-player.js`
- **Risque de régression** : Faible (nécessite de vérifier la fluidité de la voix sur Safari iOS et Android Chrome).
- **Effort estimé** : M

### Action 1.3 — Sécurisation et authentification de la WebSocket Administrateur
- **Défaut lié** : A1 (Faiblesses d'authentification Admin et WebSocket fragile)
- **Action concrète** :
  1. Utiliser un module d'authentification robuste ou signer cryptographiquement le cookie administrateur via un secret de session (`SESSION_SECRET` dans `.env`).
  2. Lors de l'initialisation du serveur, si `ADMIN_PASSWORD` est configuré, exiger la présence du jeton de session valide lors du handshake Upgrade WebSocket (`/ws/admin`).
  3. Associer le jeton à la socket `adminWs` et rejeter immédiatement tout message provenant d'une connexion non authentifiée.
  4. Exiger un mot de passe admin par défaut si l'environnement est en production, ou afficher une alerte bloquante claire.
- **Fichiers concernés** : `server/index.js`, `.env.example`
- **Risque de régression** : Faible (nécessite de vérifier la reconnexion automatique du tableau de bord d'administration).
- **Effort estimé** : M

---

## Phase 2 — Corrections architecturales

### Action 2.1 — Refonte du composant d'acquisition micro AudioWorklet (Élimination du GC & Jitter)
- **Défaut lié** : CDE4 (Rééchantillonnage inefficace et dérive de phase dans `AudioCaptureProcessor`)
- **Action concrète** :
  1. Dans `public/admin/audio-processor.worklet.js`, remplacer le tableau JavaScript dynamique (`this._buffer.push`/`splice`) par un tampon annulaire de taille fixe pré-alloué `Float32Array(32768)`.
  2. Conserver la phase de rééchantillonnage (`phaseAccumulator`) entre chaque appel de la méthode `process()` pour éliminer tout décalage temporel ou discontinuité de phase.
  3. Effectuer la conversion vers `Int16Array` directement dans un tampon pré-alloué réutilisé et transférer son `ArrayBuffer` sans réallocations mémoire.
- **Fichiers concernés** : `public/admin/audio-processor.worklet.js`
- **Risque de régression** : Moyen (tester l'intégration avec `admin.js` et vérifier l'animation du VU-mètre).
- **Effort estimé** : M

### Action 2.2 — Remplacement de `ScriptProcessorNode` déprécié par un `AudioWorkletNode` de lecture client
- **Défaut lié** : CDE2 (Utilisation de l'API dépréciée `ScriptProcessorNode`)
- **Action concrète** :
  1. Créer un nouveau fichier `public/audio-player.worklet.js` déclarant la classe `AudioPlayerProcessor extends AudioWorkletProcessor`.
  2. Transférer la gestion du tampon circulaire et du calcul du niveau RMS dans ce Worklet temps réel isolé du thread UI.
  3. Dans `public/audio-player.js`, charger le module Worklet et remplacer l'appel déprécié `createScriptProcessor` par `new AudioWorkletNode(ctx, 'audio-player-processor')`.
  4. Conserver un fallback dégradé automatique si `audioWorklet` n'est pas supporté sur d'anciens navigateurs.
- **Fichiers concernés** : `public/audio-player.worklet.js` (nouveau), `public/audio-player.js`, `public/index.html`
- **Risque de régression** : Moyen (tester l'initialisation de l'AudioContext lors d'une interaction utilisateur sur mobile).
- **Effort estimé** : L

### Action 2.3 — Masquage des clés API dans les logs et structuration des journaux
- **Défaut lié** : A4 (Logs non structurés et exposition de la clé API)
- **Action concrète** :
  1. Dans `server/gemini-translator.js`, construire l'URL WebSocket sans afficher la clé API en clair dans les messages de journalisation :
     `this._log('Connecting to Gemini Live Translate API…');` (ne loguer que le nom du modèle et de la langue sans la query string).
  2. Remplacer les `console.log` dispersés par une classe/utilitaire de journalisation centralisée `logger.js` avec niveaux de log (`INFO`, `WARN`, `ERROR`).
- **Fichiers concernés** : `server/gemini-translator.js`, `server/session-manager.js`, `server/index.js`, `server/logger.js` (nouveau)
- **Risque de régression** : Aucun.
- **Effort estimé** : S

### Action 2.4 — Protection de la WebSocket et contrôle de débit (Rate Limiting & Payload Limit)
- **Défaut lié** : A3 (Absence de Rate Limiting et de limite de taille de message)
- **Action concrète** :
  1. Configurer `maxPayload: 1024 * 1024` (1 Mo max par paquet) sur l'instance `WebSocketServer` dans `server/index.js`.
  2. Implémenter un filtre simple comptabilisant le nombre de messages reçus par socket et par minute (ex: rejeter si > 120 messages/sec pour l'audio ou > 5 messages/sec pour le client écouteur).
- **Fichiers concernés** : `server/index.js`
- **Risque de régression** : Faible.
- **Effort estimé** : S

### Action 2.5 — Notification de dégradation de session et reprise Gemini
- **Défaut lié** : A2 (Absence de gestion de limite de durée et reconnexion Gemini)
- **Action concrète** :
  1. Dans `SessionManager`, écouter l'événement `'disconnected'` ou `'error'` émis par une instance `GeminiTranslator`.
  2. Notifier immédiatement `AudioBroadcaster` du changement d'état de la langue concernée (ex: envoyer un message `{ type: 'status', language: 'en', state: 'buffering' }` aux fidèles écoutant cette langue).
  3. Sur l'interface client (`public/app.js`), afficher un indicateur discret "Reconnexion du flux..." sans couper brutalement la page ni fermer l'AudioContext.
- **Fichiers concernés** : `server/session-manager.js`, `server/audio-broadcaster.js`, `public/app.js`
- **Risque de régression** : Faible.
- **Effort estimé** : M

---

## Phase 3 — Nettoyage de code / dette technique

### Action 3.1 — Intégration d'un vrai générateur de QR Code et résolution d'URL IP réseau local
- **Défaut lié** : CDE6 (QR Code factice et mauvaise résolution d'URL dans le dashboard Admin)
- **Action concrète** :
  1. Inclure une bibliothèque autonome légère de génération de QR Code (ex: `qrcode.min.js` en local dans `public/admin/vendor/`).
  2. Modifier `server/index.js` pour transmettre au panneau administrateur lors du message `status` l'URL réseau local externe réelle du serveur (ex: `http://192.168.1.50:3000` ou l'URL du tunnel HTTPS le cas échéant).
  3. Dans `public/admin/admin.js`, générer dynamiquement le canevas QR Code scannable et mettre à jour le bouton de copie avec cette URL valide.
- **Fichiers concernés** : `public/admin/index.html`, `public/admin/admin.js`, `server/index.js`
- **Risque de régression** : Aucun.
- **Effort estimé** : M

### Action 3.2 — Dynamisation et prise en charge effective de `CHURCH_NAME`
- **Défaut lié** : C3 (Variable `CHURCH_NAME` inutilisée)
- **Action concrète** :
  1. Dans `server/index.js`, charger la variable `CHURCH_NAME = process.env.CHURCH_NAME || 'Notre Église'`.
  2. Transmettre cette propriété dans le message d'accueil / `info` envoyé par WebSocket ou via un point d'accès d'API aux clients écouteurs.
  3. Dans `public/app.js`, mettre à jour l'élément `#church-name` dynamiquement à partir des données reçues du serveur.
- **Fichiers concernés** : `server/index.js`, `server/audio-broadcaster.js`, `public/app.js`
- **Risque de régression** : Aucun.
- **Effort estimé** : S

### Action 3.3 — Sélection dynamique du modèle Gemini et fallback configurable
- **Défaut lié** : CDE5 (Nom du modèle Gemini codé en dur)
- **Action concrète** :
  1. Dans `server/gemini-translator.js`, rendre le nom du modèle configurable via une option `modelName` transmise par `SessionManager` (qui la lit depuis `process.env.GEMINI_MODEL`).
  2. Si le modèle configuré échoue lors du handshake `setupComplete`, tenter automatiquement un basculement sur la liste des modèles de secours (`models/gemini-2.0-flash-exp`, `models/gemini-3.1-flash-live-preview`).
- **Fichiers concernés** : `server/gemini-translator.js`, `server/session-manager.js`, `.env.example`
- **Risque de régression** : Faible.
- **Effort estimé** : M

### Action 3.4 — Suppression des variables globales et nettoyage du code
- **Défaut lié** : CDE7 (Pollution de l'espace global `global._audioChunkCount`)
- **Action concrète** :
  1. Supprimer l'utilisation de `global._audioChunkCount` dans `server/index.js`.
  2. Encapsuler le compteur de paquets au sein d'une propriété d'instance dans `SessionManager` ou utiliser l'utilitaire de log structuré.
- **Fichiers concernés** : `server/index.js`
- **Risque de régression** : Aucun.
- **Effort estimé** : S

---

## Ordre d'exécution recommandé

Voici la séquence chronologique et logique de réalisation des travaux :

```
[Phase 0 : Décisions Humaines & Réseau]
    │
    ▼
[Action 1.1 : Fix Alignement Mémoire Int16Array (iOS/Safari)]
    │
    ▼
[Action 1.2 : Support Universal SampleRate & Resampling Client]
    │
    ▼
[Action 1.3 : Sécurisation WebSocket Admin & Session Cookie]
    │
    ▼
[Action 2.1 : Refonte AudioWorklet Capture (Fix GC & Phase)]
    │
    ▼
[Action 2.2 : Migration Client vers AudioWorklet Node (Fix Stutter)]
    │
    ▼
[Action 2.3 & 2.4 : Logs Sécurisés & Protection Rate Limiting / Payload]
    │
    ▼
[Action 2.5 : Management des Reconnexions & Statuts Gemini]
    │
    ▼
[Action 3.1 à 3.4 : QR Code Réel, CHURCH_NAME, Modèle Configurable & Nettoyage]
```

---

## Points de vigilance

1. **Politique d'Autoplay Web Audio sur Safari iOS** :
   - L'instanciation et l'appel à `AudioContext.resume()` DOIVENT impérativement être déclenchés à l'intérieur du gestionnaire d'événement de clic de l'utilisateur (`onLangSelect` dans `app.js`). Ne jamais tenter de démarrer le contexte audio en arrière-plan lors de l'ouverture de la socket.
2. **Latence globale de bout en bout** :
   - Les modifications du tampon circulaire (`AudioPlayer` et `AudioWorklet`) doivent conserver une latence maximale inférieure à 500 ms. Veiller à ce que la taille des blocs de rééchantillonnage ne dépasse pas 100 ms d'audio.
3. **Tests multi-appareils indispensables** :
   - Les corrections d'alignement mémoire et de fréquence d'échantillonnage doivent obligatoirement être testées sur un iPhone physique (Safari iOS) et un téléphone Android (Chrome) avec écouteurs Bluetooth et filaires.
