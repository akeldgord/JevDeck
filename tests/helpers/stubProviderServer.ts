import { startStubProvider } from './stubProvider';

/**
 * The controlled provider as a process, for the container workflow.
 *
 * Every other suite starts the stub inside the test process. The container check cannot: the
 * application under test is in a container, so the provider it calls has to be reachable from
 * outside this process — the CI job starts this script on the host and gives the container the
 * address.
 *
 *   bun tests/helpers/stubProviderServer.ts [port]      # default 4319
 *
 * Nothing in the product imports this file; it exists so the deployed image can be exercised
 * without a provider credential and without a hosted model.
 */

const port = Number(process.argv[2] ?? process.env.JEVDECK_STUB_PORT ?? 4319);
const stub = startStubProvider({}, port);

console.log(`[jevdeck] stub provider listening on ${stub.url}`);

// Kept alive deliberately: this is a server, not a script with an end.
await new Promise(() => {});
