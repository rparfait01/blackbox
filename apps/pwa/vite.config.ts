import path from 'node:path';
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { VitePWA } from 'vite-plugin-pwa';

// The PWA presents as "Stillpoint" — the meditation facade. Nothing in the
// installable manifest references BLACK BOX, safety, or emergency.
export default defineConfig({
  plugins: [
    react(),
    VitePWA({
      registerType: 'autoUpdate',
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
