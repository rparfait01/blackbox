import path from 'node:path';
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { VitePWA } from 'vite-plugin-pwa';

// A fresh build id on every build. It bumps the service worker payload (so the
// browser always sees a byte-changed SW and triggers an update) and is shown in
// Settings so the device's live build can be confirmed at a glance (Brief 13 B1).
const BUILD_ID = new Date().toISOString();

// The PWA presents as "Stillpoint" — the meditation facade. Nothing in the
// installable manifest references BLACK BOX, safety, or emergency.
export default defineConfig({
  define: {
    __BUILD_ID__: JSON.stringify(BUILD_ID),
  },
  plugins: [
    react(),
    VitePWA({
      // 'prompt', not 'autoUpdate': a silent auto-reload would tear down an
      // in-progress recording session (capture dies on navigation). Instead the
      // app surfaces an in-app "update available — reload" banner the user taps,
      // suppressed during an active alert (Brief 13 B1). The generated SW still
      // skipWaiting + clientsClaim on demand, so the new build takes over the
      // instant the user reloads — no manual hard-reset needed.
      registerType: 'prompt',
      // We register + drive updates ourselves (UpdateBanner) with the native
      // ServiceWorker API, so the plugin must NOT also inject its own registration
      // script (that would double-register, and pulling in the virtual register
      // module drags in workbox-window which isn't resolvable here).
      injectRegister: false,
      includeAssets: [
        'icons/icon-192.png',
        'icons/icon-512.png',
        'icons/icon-maskable.png',
        'icons/apple-touch-icon.png',
      ],
      manifest: {
        name: 'Stillpoint',
        short_name: 'Stillpoint',
        description: 'A quiet space to breathe.',
        lang: 'en',
        theme_color: '#1a1f3a',
        background_color: '#1a1f3a',
        display: 'standalone',
        orientation: 'portrait',
        start_url: '/',
        scope: '/',
        // PNG icons: iOS home-screen + Android maskable both require PNG (SVG is
        // not honored). 'any maskable' on the 512 lets Android pick the safe-zone
        // render; the dedicated maskable icon is full-bleed.
        icons: [
          { src: 'icons/icon-192.png', sizes: '192x192', type: 'image/png', purpose: 'any' },
          { src: 'icons/icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'any' },
          {
            src: 'icons/icon-maskable.png',
            sizes: '512x512',
            type: 'image/png',
            purpose: 'maskable',
          },
        ],
      },
      workbox: {
        globPatterns: ['**/*.{js,css,html,svg,png,woff,woff2}'],
        // Take control of open pages as soon as the new SW activates, so a fresh
        // build's assets are used without a manual hard reset (Brief 13/14 B1).
        // skipWaiting stays message-driven (UpdateBanner) so we never tear down an
        // active recording session.
        clientsClaim: true,
      },
    }),
  ],
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
    },
  },
  server: {
    port: 5173,
  },
});
