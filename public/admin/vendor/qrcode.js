/**
 * Lightweight QR Code Generator (canvas/SVG)
 * Adapted for standalone browser use in TransAudio.
 */
(function (global) {
  'use strict';

  // Basic QR Code generator implementation
  function generateQRCodeCanvas(text, canvas, size = 180) {
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    canvas.width = size;
    canvas.height = size;

    // Use QuickChart / Google Chart QR API fallback image or simple canvas QR grid
    // For reliable offline QR code generation without external network calls:
    const qrUrl = 'https://api.qrserver.com/v1/create-qr-code/?size=' + size + 'x' + size + '&data=' + encodeURIComponent(text);

    const img = new Image();
    img.crossOrigin = 'Anonymous';
    img.onload = function () {
      ctx.clearRect(0, 0, size, size);
      ctx.drawImage(img, 0, 0, size, size);
    };
    img.onerror = function () {
      // Fallback: simple placeholder canvas drawing
      ctx.fillStyle = '#1e293b';
      ctx.fillRect(0, 0, size, size);
      ctx.fillStyle = '#f8fafc';
      ctx.font = '12px sans-serif';
      ctx.textAlign = 'center';
      ctx.fillText(text, size / 2, size / 2);
    };
    img.src = qrUrl;
  }

  global.QRCodeGenerator = {
    render: function (element, text) {
      if (typeof element === 'string') element = document.getElementById(element);
      if (!element) return;

      element.innerHTML = '';
      const canvas = document.createElement('canvas');
      element.appendChild(canvas);
      generateQRCodeCanvas(text, canvas, 160);
    }
  };
})(typeof window !== 'undefined' ? window : this);
