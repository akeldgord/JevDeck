/// <reference types="vite/client" />

interface ImportMetaEnv {
  /**
   * Enables the local demo workspace: synthetic documents, cards, identities and
   * simulated usage figures.
   *
   * Must be set explicitly. It is absent from the repository and from production
   * builds, so production can never fall back to fabricated content.
   */
  readonly VITE_JEVDECK_DEMO_MODE?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
