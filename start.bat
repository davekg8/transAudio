@echo off
:: TransAudio — Lanceur Automatique pour Windows
:: Ce script vérifie la présence de Node.js, l'installe si nécessaire,
:: installe les dépendances au premier lancement, puis démarre l'application.

title TransAudio - Démarrage
chcp 65001 >nul

echo ==========================================================
echo           ✝  TransAudio — Lanceur Automatique  ✝
echo ==========================================================
echo.

:: 1. Vérification de Node.js
echo [1/3] Vérification de Node.js...
where node >nul 2>nul
if %errorlevel% neq 0 (
    echo ⚠️ Node.js n'est pas détecté sur ce système.
    echo Tentative d'installation automatique via Windows Package Manager (winget)...
    echo.
    
    where winget >nul 2>nul
    if %errorlevel% equ 0 (
        winget install --id OpenJS.NodeJS --silent --accept-source-agreements --accept-package-agreements
        if %errorlevel% equ 0 (
            echo.
            echo ✅ Node.js a été installé avec succès !
            echo ⚠️ IMPORTANT : Veuillez fermer cette fenêtre et relancer "start.bat"
            echo pour que le système prenne en compte la nouvelle installation.
            echo.
            pause
            exit /b 0
        )
    )
    
    echo ❌ Impossible d'installer Node.js automatiquement.
    echo Veuillez le télécharger et l'installer manuellement depuis : https://nodejs.org/
    echo.
    pause
    exit /b 1
)

echo ✅ Node.js est présent :
node -v
echo.

:: 2. Vérification des dépendances (npm install au premier lancement)
echo [2/3] Vérification des dépendances...
if not exist "node_modules\" (
    echo 📦 Premier lancement détecté. Installation des dépendances (npm install)...
    echo Cela peut prendre une minute, veuillez patienter...
    echo.
    call npm install
    if %errorlevel% neq 0 (
        echo.
        echo ❌ Échec de l'installation des dépendances.
        pause
        exit /b 1
    )
    echo.
    echo ✅ Dépendances installées avec succès.
) else (
    echo ✅ Dépendances déjà installées.
)
echo.

:: 3. Lancement de l'application
echo [3/3] Démarrage de TransAudio...
echo.
call npm start
if %errorlevel% neq 0 (
    echo.
    echo ❌ Le serveur s'est arrêté avec une erreur.
    pause
)
