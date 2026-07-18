# Design System — TransAudio

Ce document définit les directives de design et le système visuel pour TransAudio.

## 🎨 Palette de Couleurs (Dark OLED & Gold/Blue Accent)

| Rôle | Couleur | Valeur Hex | Variable CSS | Usage |
|---|---|---|---|---|
| Background | Deep Navy Obsidian | `#050814` | `--color-bg` | Fond principal de l'application |
| Card / Glass | Translucide Slate | `rgba(15, 23, 42, 0.45)` | `--color-card-bg` | Fonds de cartes et conteneurs glassmorphic |
| Primary Accent | Sapphire Blue | `#2563eb` | `--color-primary` | Liens primaires, boutons admin, accents admin |
| Public Accent | Spiritual Gold | `#d97706` | `--color-gold` | Liens publics, boutons d'écoute, accents fidèles |
| Accent/Play | Play Emerald | `#22c55e` | `--color-accent` | Indicateurs de diffusion, boutons de lecture |
| Text Main | Crisp White | `#f8fafc` | `--color-text-main` | Titres et textes principaux |
| Text Muted | Slate Muted | `#94a3b8` | `--color-text-muted` | Textes de description, labels secondaires |
| Border | Deep Indigo Border | `rgba(49, 46, 129, 0.3)` | `--color-border` | Bordures fines et séparateurs |

## ✍️ Typographie

* **Polices** : 
  * Titres : **Outfit** (moderne, géométrique, excellente lisibilité à grande échelle)
  * Corps de texte : **Inter** (neutre, lisible, excellente pour la lecture sur mobile)
* **Tailles** : 
  * Corps : `16px` (1rem) minimum sur mobile pour éviter le zoom automatique d'iOS
  * Hauteur de ligne : `1.6` pour une lecture aérée et reposante

## 🚀 Mouvements et Micro-animations

* **Transitions de survol/focus** : `200ms cubic-bezier(0.4, 0, 0.2, 1)` pour une sensation de réactivité fluide.
* **Animations d'état (Hover/Active)** : Légère élévation (`translateY(-2px)`) et halo lumineux progressif (`box-shadow`), sans jamais déplacer les éléments voisins (pas de Layout Shift).

## 📐 Règles UX Clés

1. **Aucun emoji dans la structure** : Tous les indicateurs visuels ou boutons doivent utiliser des icônes SVG vectorielles propres, homogènes en épaisseur de trait (1.5px) et dimensionnées de façon cohérente.
2. **Cibles tactiles conformes** : Toutes les zones cliquables font au moins `44px × 44px` pour éviter les erreurs de clic sur mobile.
3. **Responsive Mobile-First** : Grille adaptative fluide sans défilement horizontal.
