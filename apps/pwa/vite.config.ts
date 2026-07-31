import path from 'node:path';
import { execSync } from 'node:child_process';
import { defineConfig, loadEnv, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';
import { VitePWA } from 'vite-plugin-pwa';
import { API_ORIGIN_VAR, assertApiOrigin } from '../../scripts/api-origin.mjs';

// The build id (Brief 21): the git commit short SHA, so the LIVE production build
// can be asserted equal to the committed source by the deploy script. Falls back
// to an ISO timestamp outside a git checkout. It bumps the service worker payload
// (so the browser always sees a byte-changed SW and triggers an update) and is
// shown in Settings so the device's live build can be confirmed at a glance.
function resolveBuildId(): string {
  if (process.env.VITE_BUILD_ID) return process.env.VITE_BUILD_ID;
  try {
    return execSync('git rev-parse --short HEAD', { stdio: ['ignore', 'pipe', 'ignore'] })
      .toString()
      .trim();
  } catch {
    return new Date().toISOString();
  }
}
const BUILD_ID = resolveBuildId();

// Emit dist/version.json carrying the build id. It is NOT precached (json is not in
// the SW globPatterns) so it is always fetched fresh — the single source of truth
// the deploy script asserts against and the client checks on resume (Brief 21).
function emitVersionJson(): Plugin {
  return {
    name: 'emit-version-json',
    apply: 'build',
    generateBundle() {
      this.emitFile({ type: 'asset', fileName: 'version.json', source: JSON.stringify({ build: BUILD_ID }) });
    },
  };
}

/**
 * Brief 35 §A — THE BUILD GATE. A production build with a missing, empty, non-HTTPS
 * or non-routable API origin FAILS TO COMPILE.
 *
 * There is no valid production state in which the PWA has no backend: without one,
 * activation starts local capture and shows an active alert while creating no event,
 * notifying nobody, and uploading nothing. Every one of those failures is silent from
 * the device, and the deploy-currency check passes anyway because the build ids match.
 * The only honest response is a non-zero exit before anything is built.
 *
 * DEV IS PERMISSIVE, AND IT IS GATED ON THE DEV FLAG — never on the variable being
 * absent. `vite dev` and `vite build --mode development` may run without an origin
 * (uploads simply stay off); a PRODUCTION build may not. That distinction is the whole
 * fix: absence used to mean "quietly disable the product", and now it means
 * "development" only where development was explicitly asked for.
 *
 * `mode` is the flag: it is 'production' for `vite build` unless --mode says otherwise.
 */
function assertProductionApiOrigin(mode: string): void {
  const env = loadEnv(mode, path.resolve(__dirname), 'VITE_');
  const value = env[API_ORIGIN_VAR];
  if (mode !== 'production') {
    const shown = value ? value : '(unset — uploads disabled, local capture only)';
    console.log(`[env] ${mode} build — ${API_ORIGIN_VAR}=${shown}`);
    return;
  }
  // Throws with a message naming the variable; vite exits non-zero and publishes nothing.
  const origin = assertApiOrigin(value, 'production build');
  console.log(`[env] production build — API origin: ${origin}`);
}

// The PWA presents as "Stillpoint" — the meditation facade. Nothing in the
// installable manifest references BLACK BOX, safety, or emergency.
export default defineConfig(({ mode }) => {
  assertProductionApiOrigin(mode);
  return {
    define: {
      __BUILD_ID__: JSON.stringify(BUILD_ID),
    },
    plugins: [
      react(),
      emitVersionJson(),
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
          // Purge previous precache buckets on activate so a stale asset can never
          // linger behind a new build (Brief 21 §2).
          cleanupOutdatedCaches: true,
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
  };
});
