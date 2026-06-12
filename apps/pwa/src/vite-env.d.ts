/// <reference types="vite/client" />
/// <reference types="vite-plugin-pwa/client" />

/** Build identifier injected at build time (Brief 13 B1 — confirm live build). */
declare const __BUILD_ID__: string;

interface ImportMetaEnv {
  readonly VITE_REVEAL_HOLD_MS?: string;
  readonly VITE_API_BASE_URL?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
