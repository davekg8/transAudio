#!/bin/bash
# TransAudio — Lanceur Automatique pour macOS et Linux
# Ce script vérifie la présence de Node.js, l'installe si nécessaire,
# installe les dépendances au premier lancement, puis démarre l'application.

clear
echo "=========================================================="
echo "          ✝  TransAudio — Lanceur Automatique  "
echo "=========================================================="
echo ""

# Fonction d'installation pour macOS
install_mac() {
    echo "Tentative d'installation de Node.js via Homebrew..."
    if command -v brew &> /dev/null; then
        brew install node
    else
        echo "⚠️ Homebrew n'est pas détecté. Installation de Homebrew..."
        /bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"
        
        # Charger Homebrew dans la session courante
        if [ -f "/opt/homebrew/bin/brew" ]; then
            eval "$(/opt/homebrew/bin/brew shellenv)"
        elif [ -f "/usr/local/bin/brew" ]; then
            eval "$(/usr/local/bin/brew shellenv)"
        fi
        
        brew install node
    fi
}

# Fonction d'installation pour Linux
install_linux() {
    echo "Tentative d'installation de Node.js via le gestionnaire de paquets..."
    if command -v apt-get &> /dev/null; then
        echo "Utilisation de apt (Debian/Ubuntu)..."
        sudo apt-get update && sudo apt-get install -y nodejs npm
    elif command -v dnf &> /dev/null; then
        echo "Utilisation de dnf (Fedora/RHEL)..."
        sudo dnf install -y nodejs
    elif command -v pacman &> /dev/null; then
        echo "Utilisation de pacman (Arch)..."
        sudo pacman -S --noconfirm nodejs npm
    else
        echo "❌ Gestionnaire de paquets non pris en charge pour l'installation automatique."
        echo "Veuillez installer Node.js manuellement : https://nodejs.org/"
        exit 1
    fi
}

# 1. Vérification de Node.js
echo "[1/3] Vérification de Node.js..."
if ! command -v node &> /dev/null; then
    echo "⚠️ Node.js n'est pas détecté sur ce système."
    
    # Détection de l'OS
    OS="$(uname -s)"
    if [ "$OS" = "Darwin" ]; then
        echo "Système détecté : macOS (Darwin)"
        install_mac
    elif [ "$OS" = "Linux" ]; then
        echo "Système détecté : Linux"
        install_linux
    else
        echo "❌ Système d'exploitation non pris en charge pour l'installation automatique."
        exit 1
    fi
    
    # Double vérification après tentative d'installation
    if ! command -v node &> /dev/null; then
        echo "❌ L'installation automatique de Node.js a échoué."
        echo "Veuillez l'installer manuellement depuis : https://nodejs.org/"
        exit 1
    fi
    echo "✅ Node.js installé avec succès !"
fi

echo "✅ Node.js est présent : $(node -v)"
echo ""

# 2. Vérification des dépendances
echo "[2/3] Vérification des dépendances..."
if [ ! -d "node_modules" ]; then
    echo "📦 Premier lancement détecté. Installation des dépendances (npm install)..."
    echo "Cela peut prendre une minute, veuillez patienter..."
    echo ""
    npm install
    if [ $? -ne 0 ]; then
        echo ""
        echo "❌ Échec de l'installation des dépendances."
        exit 1
    fi
    echo ""
    echo "✅ Dépendances installées avec succès."
else
    echo "✅ Dépendances déjà installées."
fi
echo ""

# 3. Démarrage de l'application
echo "[3/3] Démarrage de TransAudio..."
echo ""
npm start
if [ $? -ne 0 ]; then
    echo ""
    echo "❌ Le serveur s'est arrêté avec une erreur."
    exit 1
fi
