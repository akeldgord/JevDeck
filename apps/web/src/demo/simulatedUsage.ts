import { SystemUsageStats } from '@jevdeck/contracts';

/**
 * SIMULATED USAGE — demo only.
 *
 * The previous implementation added invented token and dollar figures to the instance
 * totals straight from the generation handler, which made simulated spend look like real
 * provider billing. It now lives here, is only reachable in demo mode, and every surface
 * that renders its output is labelled as simulated.
 *
 * Remediation workstream R5 replaces this with an append-only, server-owned usage ledger
 * with transactional reservations against per-user and installation caps.
 */

/** Benchmark rates used to invent a plausible figure. Not a real price list. */
const SIMULATED_TOKENS_PER_CARD = 550;
const SIMULATED_USD_PER_1K_TOKENS = 0.003;

export function simulateUsageForCards(
  stats: SystemUsageStats,
  cardCount: number
): SystemUsageStats {
  const tokens = cardCount * SIMULATED_TOKENS_PER_CARD;
  const spend = Math.round((tokens / 1000) * SIMULATED_USD_PER_1K_TOKENS * 100) / 100;

  return {
    ...stats,
    instanceTotalSpendUsd: Math.round((stats.instanceTotalSpendUsd + spend) * 100) / 100,
    instanceTotalTokens: stats.instanceTotalTokens + tokens,
    totalCardsGenerated: stats.totalCardsGenerated + cardCount,
  };
}
