/// <reference types="vite/client" />
/// <reference types="vite-plugin-pwa/client" />

interface ImportMetaEnv {
  readonly VITE_REVEAL_HOLD_MS?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
