/**
 * TransAudio — Brand & Tutorial Website Logic
 * Gère l'interactivité du guide étape par étape (changement de diapositive).
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

    if (stepItems.length === 0 || graphicSlides.length === 0) return;

    stepItems.forEach((item) => {
      item.addEventListener('click', () => {
        const stepNum = item.getAttribute('data-step');
        if (!stepNum) return;

        // 1. Activer le bouton d'étape cliqué
        stepItems.forEach(el => el.classList.remove('active'));
        item.classList.add('active');

        // 2. Activer la diapositive d'illustration correspondante avec transition
        graphicSlides.forEach((slide) => {
          const slideNum = slide.getAttribute('data-slide');
          if (slideNum === stepNum) {
            slide.classList.add('active');
          } else {
            slide.classList.remove('active');
          }
        });
      });
    });

    // Rotation automatique toutes les 6 secondes pour rendre le site dynamique
    let currentStep = 1;
    const totalSteps = stepItems.length;
    let autoPlayInterval = setInterval(autoPlaySteps, 6000);

    function autoPlaySteps() {
      currentStep = (currentStep % totalSteps) + 1;
      const nextStepItem = document.querySelector(`.tuto-step-item[data-step="${currentStep}"]`);
      if (nextStepItem) {
        // Déclencher le clic de manière programmée
        nextStepItem.click();
      }
    }

    // Arrêter la rotation automatique dès que l'utilisateur clique sur une étape
    stepItems.forEach((item) => {
      item.addEventListener('click', () => {
        clearInterval(autoPlayInterval);
      });
    });
  }

})();
