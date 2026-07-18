/**
 * TransAudio — Brand & Tutorial Website Logic
 * Gère l'interactivité du guide étape par étape (changement de diapositive).
 * Conforme aux directives UI/UX Pro Max (Accessibilité, Clavier, Motion).
 */

(function () {
  'use strict';

  // Attendre que le DOM soit chargé
  document.addEventListener('DOMContentLoaded', () => {
    initStepTutorial();
  });

  /**
   * Initialise le guide interactif étape par étape.
   */
  function initStepTutorial() {
    const stepItems = document.querySelectorAll('.tuto-step-item');
    const graphicSlides = document.querySelectorAll('.graphic-slide');
    const tabList = document.querySelector('[role="tablist"]');

    if (stepItems.length === 0 || graphicSlides.length === 0) return;

    // Détecter la préférence d'animations réduites du système
    const prefersReducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

    // Fonction pour activer une étape spécifique
    function activateStep(index, focus = false) {
      stepItems.forEach((item, i) => {
        const isActive = i === index;
        item.classList.toggle('active', isActive);
        item.setAttribute('aria-selected', isActive ? 'true' : 'false');
        if (isActive) {
          item.setAttribute('tabindex', '0');
          if (focus) {
            item.focus();
          }
        } else {
          item.setAttribute('tabindex', '-1');
        }
      });

      graphicSlides.forEach((slide, i) => {
        const isActive = i === index;
        slide.classList.toggle('active', isActive);
        if (prefersReducedMotion) {
          // Si l'utilisateur préfère réduire les animations, on coupe les transitions CSS
          slide.style.transition = 'none';
        }
      });
    }

    // Gestion du clic et de l'accessibilité
    stepItems.forEach((item, index) => {
      item.addEventListener('click', () => {
        clearInterval(autoPlayInterval);
        activateStep(index, false);
      });

      // Support navigation au clavier
      item.addEventListener('keydown', (e) => {
        let newIndex = index;
        if (e.key === 'ArrowDown' || e.key === 'ArrowRight') {
          e.preventDefault();
          newIndex = (index + 1) % stepItems.length;
          clearInterval(autoPlayInterval);
          activateStep(newIndex, true);
        } else if (e.key === 'ArrowUp' || e.key === 'ArrowLeft') {
          e.preventDefault();
          newIndex = (index - 1 + stepItems.length) % stepItems.length;
          clearInterval(autoPlayInterval);
          activateStep(newIndex, true);
        } else if (e.key === 'Home') {
          e.preventDefault();
          clearInterval(autoPlayInterval);
          activateStep(0, true);
        } else if (e.key === 'End') {
          e.preventDefault();
          clearInterval(autoPlayInterval);
          activateStep(stepItems.length - 1, true);
        }
      });
    });

    // Rotation automatique toutes les 6 secondes pour rendre le site vivant
    let currentStepIndex = 0;
    const totalSteps = stepItems.length;
    let autoPlayInterval = null;

    if (!prefersReducedMotion) {
      autoPlayInterval = setInterval(autoPlaySteps, 6000);
    }

    function autoPlaySteps() {
      currentStepIndex = (currentStepIndex + 1) % totalSteps;
      activateStep(currentStepIndex, false);
    }

    // Initialiser les attributs de départ
    activateStep(0, false);
  }

})();
