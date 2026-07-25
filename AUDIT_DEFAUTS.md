# Audit des défauts — TransAudio
Date : 25 juillet 2026

## Résumé exécutif
L'application **TransAudio** possède une fondation intéressante pour la traduction et la diffusion audio en direct dans un contexte d'église locale. Cependant, l'audit technique de A à Z révèle des fragilités structurelles et fonctionnelles majeures. L'application présente au moins trois blocages critiques : l'incompatibilité de décodage audio PCM sur Safari/iOS (qui fait planter le lecteur client), des problèmes d'isolement réseau local (AP Isolation) non traités qui empêchent les fidèles d'accéder au serveur via IP privée, et une authentification administrateur vulnérable en WebSocket. Des défauts de code significatifs (API dépréciées, rééchantillonnage instable, fuites de mémoire) et des écarts entre la documentation et la réalité complètent ce diagnostic. Une refonte ciblée est indispensable avant tout déploiement en conditions réelles.

---

## 1. Défauts conceptuels

### C1. Hypothèse réseau irréaliste et blocage par l'isolation du réseau Wi-Fi local (AP Isolation)
- **Description** : Le modèle d'utilisation suppose que le serveur Node.js tourne sur un ordinateur de régie et que les fidèles s'y connectent directement via son adresse IP locale (ex: `http://192.168.x.x:3000` ou `http://10.x.x.x:3000`).
- **Pourquoi c'est un problème** : Dans la très grande majorité des églises et lieux publics, le réseau Wi-Fi ouvert ou invité active la fonction **AP Isolation (Client Isolation)** sur les bornes Wi-Fi. Cette sécurité empêche tout smartphone d'interroger directement une adresse IP locale. Les fidèles obtiennent un délai d'attente dépassé (Timeout) sans pouvoir charger la page. De plus, sur iOS Safari et navigateurs récents, l'accès à certaines APIs Web Audio et WebSocket non sécurisées (`http://` et `ws://`) sur une IP locale privée rencontre des restrictions de sécurité strictes.
- **Gravité** : Critique
- **Preuve / exemple concret** : `README.md` lignes 79 et 91 (`http://192.168.1.50:3000`) et `server/index.js` lignes 323-334 (affichage de l'IP locale sans gestion de nom de domaine, HTTPS ou tunnel de diffusion).

### C2. Écart entre la promesse "Coût fixe / modèle économique" de la documentation et la réalité de l'API Gemini
- **Description** : Le document `README.md` et la page de présentation (`website/index.html`) avancent un coût fixe d'environ "$2.20/heure par langue" basé sur un modèle nommé `models/gemini-3.5-live-translate-preview`.
- **Pourquoi c'est un problème** : La tarification de l'API Gemini Multimodal Live (`BidiGenerateContent`) s'effectue strictement au nombre de jetons (tokens) de données audio en entrée et en sortie, et non via un tarif horaire forfaitaire garanti. De plus, si la régie laisse tourner la session sans parole (silence), le flux audio d'entrée (16 kHz PCM) continue de consommer des tokens d'entrée auprès de Google AI Studio. Promettre un tarif horaire garanti induit l'utilisateur en erreur.
- **Gravité** : Majeur
- **Preuve / exemple concret** : `README.md` lignes 27 et 34 ; `website/index.html` ligne 69 ; `server/gemini-translator.js` ligne 184.

### C3. Absence de prise en charge du paramètre de configuration `CHURCH_NAME`
- **Description** : Le fichier `README.md` et le fichier d'exemple `.env.example` indiquent que le nom de l'église peut être personnalisé via la variable d'environnement `CHURCH_NAME`.
- **Pourquoi c'est un problème** : Cette variable n'est ni chargée dans `server/index.js`, ni transmise aux clients Web. Dans le code client (`public/app.js`), la valeur est inscrite en dur sous la forme `const CHURCH_NAME = 'Notre Église'`.
- **Gravité** : Mineur
- **Preuve / exemple concret** : `README.md` ligne 51 ; `.env.example` ligne 11 ; `public/app.js` ligne 9 ; absence de la variable dans `server/index.js`.

---

## 2. Défauts architecturaux

### A1. Faiblesse et insécurité du système d'authentification administrateur et de la WebSocket Admin
- **Description** : L'accès aux fonctionnalités d'administration présente plusieurs failles de sécurité majeures :
  1. Si la variable `ADMIN_PASSWORD` n'est pas définie dans `.env`, aucune authentification n'est requise. N'importe quel utilisateur connecté au réseau peut ouvrir la WebSocket `ws://<ip>:3000/ws/admin` et prendre le contrôle total (démarrer/arrêter la traduction, envoyer du son arbitraire).
  2. La session admin utilise un cookie `transaudio_admin_auth` stockant un simple UUID v4 (`currentSessionToken`) généré en mémoire à chaque démarrage du serveur, sans signature cryptographique (`secret`).
  3. Tout redémarrage du serveur invalide silencieusement la session sans notification propre, et la WebSocket Admin ne vérifie pas le jeton à chaque message entrant.
- **Pourquoi c'est un problème** : Risque d'usurpation de contrôle de la régie, d'injection audio ou de déconnexion intempestive en pleine prédication.
- **Gravité** : Critique
- **Preuve / exemple concret** : `server/index.js` lignes 64-80 (middleware cookie), lignes 126-136 (upgrade WS) et lignes 167-225 (absence de re-vérification du token sur la réception de chaque message `ws.on('message')`).

### A2. Découplage insuffisant et absence de gestion de la limite de durée de session Gemini Live
- **Description** : La classe `SessionManager` orchestre plusieurs instances de `GeminiTranslator`. Cependant, les sessions WebSocket Gemini Multimodal Live ont des limites de durée maximale imposable par l'infrastructure Google AI Studio (ex: coupure automatique après un délai d'inactivité ou une durée maximale de session continue).
- **Pourquoi c'est un problème** : En cas de déconnexion brutale d'une session Gemini, `SessionManager` tente un réapprentissage/reconnexion isolée mais ne transmet aucun message explicite de statut de dégradation (`degraded` / `buffering`) à l'instance `AudioBroadcaster`. Les fidèles subissent une coupure de son inexpliquée sur leur téléphone.
- **Gravité** : Majeur
- **Preuve / exemple concret** : `server/session-manager.js` lignes 72-75 (événement `session_error` émis localement mais non propagé aux clients écouteurs dans `audio-broadcaster.js`).

### A3. Absence de limitation de débit (Rate Limiting) et de contrôle de taille des messages WebSocket
- **Description** : Le serveur HTTP / WebSocket ne définit aucune limite sur la taille des paquets entrants (`maxPayload` non configuré dans `ws`), ni aucun Rate Limiting par adresse IP sur les routes HTTP et les WebSockets.
- **Pourquoi c'est un problème** : Un client malveillant ou un script défaillant peut envoyer des paquets JSON volumineux à `/ws/listen` ou `/ws/admin`, provoquant des allocations mémoire massives ou un blocage du thread principal Node.js par `JSON.parse`.
- **Gravité** : Majeur
- **Preuve / exemple concret** : `server/index.js` ligne 120 (`new WebSocketServer({ noServer: true })` sans option `maxPayload`).

### A4. Gestion des journaux (Logs) non structurée et exposition de la clé API en clair
- **Description** : La gestion des journaux utilise des appels directs à `console.log` et `console.error`. Dans `GeminiTranslator`, l'URL de connexion WebSocket inclut directement la clé API Gemini en tant que paramètre de requête HTTP (`GEMINI_WS_URL?key=${this._apiKey}`).
- **Pourquoi c'est un problème** : Si l'URL de connexion est capturée dans les journaux d'erreurs (ex: échec d'établissement de la socket ou trace d'exception), la clé privée `GEMINI_API_KEY` est exposée en clair dans la console et les fichiers de log du serveur.
- **Gravité** : Majeur
- **Preuve / exemple concret** : `server/gemini-translator.js` lignes 70 et 72 (`const url = ...?key=${this._apiKey}` ; `this._log(...)`).

---

## 3. Défauts de code

### CDE1. Exception fatale d'alignement mémoire dans `AudioPlayer._decodeBase64ToFloat32` (Crash sur iOS / Safari)
- **Description** : Dans le décodeur audio côté client client, la conversion d'un tampon d'octets `Uint8Array` en `Int16Array` s'effectue via `new Int16Array(bytes.buffer)`.
- **Pourquoi c'est un problème** : Si `bytes.buffer` possède un décalage (offset) non aligné sur une frontière de 2 octets, le moteur JavaScript WebKit / V8 lève immédiatement une exception non rattrapée : `RangeError: start offset of Int16Array should be a multiple of 2`. Le lecteur audio s'arrête instantanément et aucun son n'est joué sur le smartphone du fidèle.
- **Gravité** : Critique
- **Preuve / exemple concret** : `public/audio-player.js` ligne 185 (`const int16 = new Int16Array(bytes.buffer);`).

### CDE2. Utilisation d'une API Web Audio obsolète (`ScriptProcessorNode`) causant des craquements audio
- **Description** : La lecture audio continue dans `AudioPlayer` s'appuie sur `createScriptProcessor(2048, 1, 1)`.
- **Pourquoi c'est un problème** : L'API `ScriptProcessorNode` est dépréciée par le W3C. Son exécution se fait sur le thread principal (UI thread) du navigateur. Dès que l'utilisateur fait défiler la page, qu'une animation s'exécute ou qu'un traitement DOM a lieu, le thread est bloqué, entraînant des pertes de blocs audio (underflow) et des craquements sonores perceptibles.
- **Gravité** : Majeur
- **Preuve / exemple concret** : `public/audio-player.js` lignes 67-70 (`this._ctx.createScriptProcessor(2048, 1, 1)`).

### CDE3. Incompatibilité de fréquence d'échantillonnage (SampleRate) sur les téléphones mobiles
- **Description** : Dans `public/audio-player.js`, le constructeur instancie un `AudioContext` en lui imposant la fréquence d'échantillonnage de `24000 Hz` : `new AudioContext({ sampleRate: 24000 })`.
- **Pourquoi c'est un problème** : De nombreux smartphones (en particulier les iPhones sous iOS et les appareils Android récents) refusent les `AudioContext` à 24000 Hz et forcent la fréquence matérielle native (44100 Hz ou 48000 Hz), ou déclenchent une exception `NotSupportedError`. Si le contexte bascule à 48000 Hz alors que le tampon contient des données à 24000 Hz sans rééchantillonnage applicatif, la voix est jouée à **double vitesse (effet voix aiguë / Chipmunk)**.
- **Gravité** : Critique
- **Preuve / exemple concret** : `public/audio-player.js` lignes 51-54 (`new AC({ sampleRate: this._inputSampleRate })`).

### CDE4. Rééchantillonnage inefficace avec fuite mémoire et dérive de phase dans `AudioCaptureProcessor`
- **Description** : Le composant AudioWorklet de la régie (`audio-processor.worklet.js`) rééchantillonne le signal micro vers 16 kHz en exécutant `this._buffer.push(sample)` et `this._buffer.splice(0, ...)` sur un tableau dynamique JavaScript classique au sein de la fonction `process()`.
- **Pourquoi c'est un problème** :
  1. L'utilisation d'allocations dynamiques (`push`, `splice`) à chaque bloc de 128 échantillons dans le thread temps réel d'AudioWorklet génère une forte pression sur le Garbage Collector, provoquant des micro-saccades dans l'acquisition du microphone.
  2. L'index de rééchantillonnage est réinitialisé à chaque appel de 128 frames sans conserver l'accumulateur de phase résiduel, ce qui introduit du bruit d'interpolation et du jitter fréquentiel sur le signal envoyé à Gemini.
- **Gravité** : Majeur
- **Preuve / exemple concret** : `public/admin/audio-processor.worklet.js` lignes 28-37 et 52-53.

### CDE5. Nom de modèle Gemini codé en dur et instable dans `GeminiTranslator`
- **Description** : Le nom du modèle Gemini est fixé en dur dans le fichier de service : `model: 'models/gemini-3.5-live-translate-preview'`.
- **Pourquoi c'est un problème** : Ce nom de modèle est une préversion spécifique. Si le compte Google AI Studio n'a pas accès à ce pré-identifiant ou si l'API fait évoluer ses modèles disponibles (ex: `gemini-2.0-flash-exp` ou `gemini-3.1-flash-live-preview`), la connexion WebSocket échoue immédiatement sans solution de repli (fallback).
- **Gravité** : Majeur
- **Preuve / exemple concret** : `server/gemini-translator.js` ligne 184.

### CDE6. Génération de QR Code factice et mauvaise résolution d'URL dans le panneau Admin
- **Description** : 
  1. Dans `public/admin/index.html`, l'élément `#qrCode` est un simple bloc HTML statique affichant le texte "QR Code" sans générateur visuel scannable.
  2. Dans `public/admin/admin.js`, la fonction `setClientUrl()` utilise `location.host`. Si la régie ouvre le panneau d'administration via `http://localhost:3000`, l'URL affichée et copiée sera `http://localhost:3000`, totalement inexploitable pour les fidèles connectés sur smartphone.
- **Pourquoi c'est un problème** : La régie ne peut ni projeter ni partager directement un QR Code valide lors du culte.
- **Gravité** : Majeur
- **Preuve / exemple concret** : `public/admin/index.html` lignes 173-176 ; `public/admin/admin.js` lignes 71-74.

### CDE7. Pollutions globales et absence d'encapsulation dans `server/index.js`
- **Description** : Le code serveur utilise l'objet global Node.js `global._audioChunkCount` pour suivre le nombre de paquets audio reçus.
- **Pourquoi c'est un problème** : La pollution de l'espace de noms `global` complique le débogage, empêche l'instanciation de plusieurs serveurs dans un même processus et constitue une mauvaise pratique d'ingénierie logicielle.
- **Gravité** : Mineur
- **Preuve / exemple concret** : `server/index.js` lignes 205-207.

---

## Tableau de synthèse

| # | Niveau | Défaut | Gravité | Impact |
|---|---|---|---|---|
| 1 | Conceptuel | C1. Blocage par l'isolation du réseau Wi-Fi local (AP Isolation) | **Critique** | Impossible pour les fidèles d'accéder au serveur sur le réseau Wi-Fi invité de l'église |
| 2 | Code | CDE1. Exception fatale d'alignement mémoire dans `AudioPlayer` | **Critique** | Plantage immédiat du lecteur audio sur iOS / Safari (aucun son diffusé) |
| 3 | Code | CDE3. Incompatibilité de SampleRate et voix à double vitesse sur mobile | **Critique** | Échec d'initialisation audio ou voix déformée ("Chipmunk") sur smartphone |
| 4 | Architectural | A1. Filles d'authentification Admin et sécurité WebSocket fragile | **Critique** | Risque de prise de contrôle ou d'interruption du flux de traduction par un tiers |
| 5 | Conceptuel | C2. Écart sur la promesse du coût fixe Gemini dans la documentation | **Majeur** | Mauvaise évaluation financière et gestion trompeuse de la consommation de jetons |
| 6 | Architectural | A2. Absence de gestion de limite de durée et reconnexion Gemini | **Majeur** | Coupure de son non expliquée pour les fidèles lors du rafraîchissement de session Gemini |
| 7 | Architectural | A3. Absence de Rate Limiting et de limite de taille des messages WS | **Majeur** | Vulnérabilité aux attaques par déni de service (DoS) et à la saturation mémoire |
| 8 | Architectural | A4. Logs non structurés et exposition de la clé API dans les requêtes | **Majeur** | Risque de fuite de la clé `GEMINI_API_KEY` dans les logs et la console |
| 9 | Code | CDE2. Utilisation de l'API dépréciée `ScriptProcessorNode` | **Majeur** | Craquements sonores et saccades audio dès que l'écran du smartphone réagit |
| 10 | Code | CDE4. Rééchantillonnage inefficace et jitter dans `AudioWorklet` | **Majeur** | Pression GC élevée et dégradation de la qualité audio envoyée à Gemini |
| 11 | Code | CDE5. Nom du modèle Gemini codé en dur et instable | **Majeur** | Risque d'échec total de connexion WebSocket en cas de modification de l'API Google |
| 12 | Code | CDE6. QR Code factice et mauvaise résolution d'URL dans le dashboard Admin | **Majeur** | Impossibilité de flasher le QR Code ou de copier une IP utilisable par les fidèles |
| 13 | Conceptuel | C3. Variable `CHURCH_NAME` inutilisée dans le code backend/frontend | **Mineur** | Nom de l'église figé à "Notre Église" quelle que soit la configuration `.env` |
| 14 | Code | CDE7. Pollution de l'espace global `global._audioChunkCount` | **Mineur** | Dette technique et mauvaise encapsulation dans le serveur Node.js |
