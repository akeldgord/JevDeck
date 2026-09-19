import { RuntimeEnvironment, resolveRuntimeEnvironment } from './capabilities';

/**
 * The single place the application reads its demo flag.
 *
 * `VITE_JEVDECK_DEMO_MODE` is set by the local development environment and is absent from
 * the repository and from production builds, so production always resolves to a non-demo
 * environment and never loads synthetic content.
 *
 * Capabilities are not resolved here: they depend on whether the API answers, which is a
 * runtime fact. `useSession` probes the API and calls `resolveCapabilities` with the result.
 */
export const runtimeEnvironment: RuntimeEnvironment = resolveRuntimeEnvironment(
  import.meta.env.VITE_JEVDECK_DEMO_MODE
);

export const isDemoMode = runtimeEnvironment.demoMode;
