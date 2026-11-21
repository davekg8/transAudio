// Netlify Server entry point (Early Access).
// Starts the regular TransAudio server, which listens on process.env.PORT.
// Static pages, the live MP3 streams and the WebSockets are all served by it.

// Explicit imports so Netlify's bundler ships these packages: the server code
// loads them with require(), which the bundler does not follow on its own.
import 'express';
import 'ws';
import 'qrcode';
import '@breezystack/lamejs';

import '../../server/index.js';

export const config = {
  region: 'fra', // Frankfurt: closest region to France
  includedFiles: ['../../public/**', '../../website/**'],
};
