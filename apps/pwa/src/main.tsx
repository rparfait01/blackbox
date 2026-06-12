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
import { resumeActiveSession } from '@/lib/activation';
import { resumeUploads } from '@/lib/upload';
import '@/index.css';

// On launch, re-hydrate from the server (Fix Brief 6 LT5-1): an alert that is
// still active server-side stays active and resumes its lifecycle (so a refresh
// can never close it and the user can still stand it down with the code). A
// session that never reached the backend is marked interrupted. Fire-and-forget.
void resumeActiveSession();

// Resume draining any uploads queued by a previous (possibly offline) session.
void resumeUploads();

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
