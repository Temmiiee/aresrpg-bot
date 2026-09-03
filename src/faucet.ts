// Auto-tops-up the bot wallet from the official Sui testnet faucet (the same
// `requestSuiFromFaucetV2` the frontend's own AddFundsModal points players at — an
// unauthenticated, rate-limited developer API Mysten Labs runs for exactly this purpose, not a
// scrape of the browser faucet page) whenever the balance drops below a threshold, so an
// unattended session doesn't just die out of gas overnight.
import { fileURLToPath } from 'node:url'

import { FaucetRateLimitError, getFaucetHost, requestSuiFromFaucetV2 } from '@mysten/sui/faucet'

import { create_local_json_store } from './local_store.ts'
import { PER_CHARACTER_GAS_BASELINE_MIST } from './session_stats.ts'
import { CHARACTERS } from './party_config.ts'

const MIST_PER_SUI = 1_000_000_000n

// ~0.02 SUI/character (the dev's own guidance — see session_stats.ts) times this party's actual
// roster size gives the expected cost of one normal fight; keep ~15 fights of headroom.
const FIGHTS_OF_HEADROOM = 15n
export const DEFAULT_MIN_BALANCE_MIST = PER_CHARACTER_GAS_BASELINE_MIST * BigInt(CHARACTERS.length) * FIGHTS_OF_HEADROOM

// A balance stuck below the threshold means every session-loop retry (every ~30s, indefinitely —
// see cli_group_session.ts) would otherwise re-call the faucet API too, hammering it for hours
// straight (measured live 2026-09-03: ~580 retries against one still-rate-limited address in a
// single run). Once rate-limited, stop trying for this long instead of re-asking every 30
// seconds — a real cooldown, not a guess at the exact server-side window, but "much less
// aggressive than every retry" is true regardless of the exact number, and this backs off far
// enough to matter without ever losing more than one real top-up cycle to it.
const RATE_LIMIT_COOLDOWN_MS = 10 * 60_000
const cooldown_store = create_local_json_store<{ until_ms: number } | null>(
  fileURLToPath(new URL('../faucet-cooldown.local.json', import.meta.url)),
  null
)

export type FaucetClaimResult =
  | { claimed: true; coins_sent: number }
  | { claimed: false; reason: 'rate_limited' | 'cooling_down' | 'error'; detail: string }

export const claim_from_faucet = async (recipient: string): Promise<FaucetClaimResult> => {
  try {
    const response = await requestSuiFromFaucetV2({ host: getFaucetHost('testnet'), recipient })
    if (response.status === 'Success') return { claimed: true, coins_sent: response.coins_sent?.length ?? 0 }
    return { claimed: false, reason: 'error', detail: response.status.Failure.internal }
  } catch (error) {
    if (error instanceof FaucetRateLimitError) return { claimed: false, reason: 'rate_limited', detail: 'rate limited' }
    return { claimed: false, reason: 'error', detail: error instanceof Error ? error.message : String(error) }
  }
}

/** Reads the live balance and claims from the faucet only if it's below the threshold — and,
 *  within that, only if a PRIOR claim wasn't rate-limited recently (see RATE_LIMIT_COOLDOWN_MS).
 *  Returns null when no claim was needed at all (balance already healthy). */
export const ensure_min_balance = async (
  read_balance_mist: () => Promise<bigint>,
  recipient: string,
  min_balance_mist: bigint = DEFAULT_MIN_BALANCE_MIST
): Promise<{ balance_mist: bigint; claim: FaucetClaimResult | null }> => {
  const balance_mist = await read_balance_mist()
  if (balance_mist >= min_balance_mist) return { balance_mist, claim: null }

  const cooldown = cooldown_store.read()
  if (cooldown && Date.now() < cooldown.until_ms) {
    const minutes_left = Math.ceil((cooldown.until_ms - Date.now()) / 60_000)
    return {
      balance_mist,
      claim: {
        claimed: false,
        reason: 'cooling_down',
        detail: `still cooling down from a prior rate limit, ~${minutes_left}min left`,
      },
    }
  }

  const claim = await claim_from_faucet(recipient)
  if (claim.claimed) cooldown_store.write(null)
  else if (claim.reason === 'rate_limited') cooldown_store.write({ until_ms: Date.now() + RATE_LIMIT_COOLDOWN_MS })
  return { balance_mist, claim }
}

export const mist_to_sui_string = (mist: bigint): string => (Number(mist) / Number(MIST_PER_SUI)).toFixed(4)
