/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_ROUTER_RPC?: string;
  readonly VITE_PLATFORM_RPC?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
