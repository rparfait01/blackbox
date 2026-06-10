import React from 'react';
import ReactDOM from 'react-dom/client';
import { RouterProvider } from 'react-router-dom';

// Fonts. IBM Plex faces carry the BLACK BOX instrument identity; Cormorant
// Garamond is the Stillpoint facade's serif. Loaded once, globally.
import '@fontsource/cormorant-garamond/300.css';
import '@fontsource/cormorant-garamond/400.css';
import '@fontsource/cormorant-garamond/500.css';
import '@fontsource/ibm-plex-sans/400.css';
import '@fontsource/ibm-plex-sans/500.css';
import '@fontsource/ibm-plex-sans/600.css';
import '@fontsource/ibm-plex-sans-condensed/500.css';
import '@fontsource/ibm-plex-sans-condensed/600.css';
import '@fontsource/ibm-plex-sans-condensed/700.css';
import '@fontsource/ibm-plex-mono/400.css';
import '@fontsource/ibm-plex-mono/500.css';
import '@fontsource/ibm-plex-mono/700.css';

import { router } from '@/app/router';
import { markStaleSessionsInterrupted } from '@/lib/storage';
import '@/index.css';

// On launch, reconcile any session left `active` by a previous reload (the
// browser kills capture on reload) by marking it `interrupted`. Fire-and-forget.
void markStaleSessionsInterrupted();

// Dev-only console harness for the classification foundation. Dynamically
// imported behind the DEV guard so production builds never bundle it and
// `globalThis.__stillpoint` stays undefined in production.
if (import.meta.env.DEV) {
  void import('@/dev/console-harness').then((module) => module.installDevConsole());
}

const rootElement = document.getElementById('root');
if (!rootElement) {
  throw new Error('Root element #root not found');
}

ReactDOM.createRoot(rootElement).render(
  <React.StrictMode>
    <RouterProvider router={router} />
  </React.StrictMode>,
);
