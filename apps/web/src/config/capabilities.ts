import type { CoverageChoice } from '@jevdeck/contracts';

/** What the API reports about itself. `null` means it has not answered (or is not running). */
export interface ApiStatus {
  reachable: boolean;
  capabilities: {
    authentication: boolean;
    administration: boolean;
    durableStorage: boolean;
    generation: boolean;
  };
  bootstrapRequired: boolean;
  tokenRequired: boolean;
}

/**
 * Runtime environment of the application.
 *
 * Resolved from configuration plus one health probe, and kept as a plain value so both the
 * demo and production branches can be exercised by tests without touching `import.meta.env`.
 */
export interface RuntimeEnvironment {
  /**
   * Whether the local demo workspace may be loaded.
   *
   * Off unless explicitly requested. Fabricated content is only ever reachable through this
   * switch — see `docs/decisions/0001-remediation-requirement-corrections.md`.
   */
  demoMode: boolean;
  /** Absent or `null` while the API has not answered. */
  api?: ApiStatus | null;
}

/** Resolves the demo flag from its raw value. Anything but `"true"` is off. */
export function resolveRuntimeEnvironment(demoFlag: string | undefined): RuntimeEnvironment {
  return { demoMode: demoFlag === 'true' };
}

/**
 * A capability the application either really has, or does not.
 *
 * There is deliberately no third state. If a capability is unavailable the UI must say so
 * and disable the action; it must never substitute fabricated output.
 */
export interface CapabilityUnavailable {
  available: false;
  /** Short statement of what is missing. */
  title: string;
  /** What this means for the person using the application. */
  detail: string;
  /** The concrete step that would make the capability available. */
  remedy: string;
}

export interface CapabilityAvailable {
  available: true;
  /** True when the capability is a local simulation that must be labelled as such. */
  simulated: boolean;
}

export type Capability = CapabilityAvailable | CapabilityUnavailable;

export interface Capabilities {
  /** Provider-backed card generation. */
  generation: Capability;
  /** Invitations, accounts, roles and usage limits. */
  administration: Capability;
  /** Durable document/deck storage with ownership. */
  durableStorage: Capability;
  /** An authenticated user session. */
  session: Capability;
}

const available = (simulated = false): Capability => ({ available: true, simulated });

const API_NOT_RUNNING_REMEDY =
  'Start the JevDeck API service and point VITE_JEVDECK_API_URL at it. Until then this build cannot reach its own backend.';

function apiUnreachable(reason: string): Capability {
  return {
    available: false,
    title: 'The JevDeck API is not reachable',
    detail: reason,
    remedy: API_NOT_RUNNING_REMEDY,
  };
}

function generationUnavailableButApiUp(): Capability {
  return {
    available: false,
    title: 'Card generation is unavailable',
    detail:
      'Card generation requires a configured AI provider. This installation has no provider adapter or credentials, so no cards can be produced from your document.',
    remedy:
      'An administrator must connect a generation provider on the server and set its API key. Until then the application will not produce cards — not even placeholder cards.',
  };
}

/**
 * Resolves what this build can actually do.
 *
 * Demo mode is a self-contained local simulation, so nothing is claimed beyond that. In
 * production every capability is taken from what the API reports, and an unreachable API is
 * reported as such rather than being papered over with synthetic content.
 */
export function resolveCapabilities(env: RuntimeEnvironment): Capabilities {
  if (env.demoMode) {
    return {
      generation: available(true),
      administration: available(true),
      durableStorage: available(true),
      session: available(true),
    };
  }

  const api = env.api ?? null;

  if (!api || !api.reachable) {
    return {
      generation: apiUnreachable(
        'Generation runs on the API: it extracts concepts from stored source text and calls a provider. Neither the API nor a provider is available to this build.'
      ),
      administration: apiUnreachable(
        'Invitations, accounts and spending limits are enforced on the API. Without it there is no account store to administer, so nothing here issues an invitation or creates a user.'
      ),
      durableStorage: apiUnreachable(
        'Uploaded documents are parsed in your browser and then discarded. Keeping them requires the API, which is not reachable.'
      ),
      session: apiUnreachable(
        'Signing in requires the API. This build has no authentication of its own and does not assume a default or administrator identity.'
      ),
    };
  }

  return {
    generation: api.capabilities.generation ? available() : generationUnavailableButApiUp(),
    administration: api.capabilities.administration
      ? available()
      : {
          available: false,
          title: 'Administration is unavailable',
          detail: 'This API reports that account administration is not available.',
          remedy: 'Enable administration on the API service.',
        },
    durableStorage: api.capabilities.durableStorage
      ? available()
      : apiUnreachable('This API reports that durable storage is not available.'),
    session: api.capabilities.authentication
      ? available()
      : apiUnreachable('This API reports that authentication is not available.'),
  };
}

/**
 * The two agreed coverage choices.
 *
 * Coverage changes which concepts are selected, never a displayed multiplier, so no choice
 * advertises a card count. See `SPEC.md` §2.2.
 */
export const COVERAGE_CHOICES: readonly CoverageChoice[] = [
  {
    value: 'high-yield',
    label: 'High-yield',
    description: 'The central, source-supported concepts in the sections you selected.',
  },
  {
    value: 'comprehensive',
    label: 'Comprehensive',
    description: 'Every distinct eligible concept in the sections you selected.',
  },
];
