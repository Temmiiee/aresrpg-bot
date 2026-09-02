// Auto-tops-up the bot wallet from the official Sui testnet faucet (the same
// `requestSuiFromFaucetV2` the frontend's own AddFundsModal points players at — an
// unauthenticated, rate-limited developer API Mysten Labs runs for exactly this purpose, not a
// scrape of the browser faucet page) whenever the balance drops below a threshold, so an
// unattended session doesn't just die out of gas overnight.
import { FaucetRateLimitError, getFaucetHost, requestSuiFromFaucetV2 } from '@mysten/sui/faucet'

import { PER_CHARACTER_GAS_BASELINE_MIST } from './session_stats.ts'
import { CHARACTERS } from './party_config.ts'

const MIST_PER_SUI = 1_000_000_000n

// ~0.02 SUI/character (the dev's own guidance — see session_stats.ts) times this party's actual
// roster size gives the expected cost of one normal fight; keep ~15 fights of headroom.
const FIGHTS_OF_HEADROOM = 15n
export const DEFAULT_MIN_BALANCE_MIST = PER_CHARACTER_GAS_BASELINE_MIST * BigInt(CHARACTERS.length) * FIGHTS_OF_HEADROOM

export type FaucetClaimResult =
  { claimed: true; coins_sent: number } | { claimed: false; reason: 'rate_limited' | 'error'; detail: string }

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

/** Reads the live balance and claims from the faucet only if it's below the threshold. Returns
 *  null when no claim was needed (balance already healthy). */
export const ensure_min_balance = async (
  read_balance_mist: () => Promise<bigint>,
  recipient: string,
  min_balance_mist: bigint = DEFAULT_MIN_BALANCE_MIST
): Promise<{ balance_mist: bigint; claim: FaucetClaimResult | null }> => {
  const balance_mist = await read_balance_mist()
  if (balance_mist >= min_balance_mist) return { balance_mist, claim: null }
  return { balance_mist, claim: await claim_from_faucet(recipient) }
}

export const mist_to_sui_string = (mist: bigint): string => (Number(mist) / Number(MIST_PER_SUI)).toFixed(4)
