// Adaptive listing price, pure over a base fair-value estimate and this item type's own past
// listing outcomes (see market_history.ts for why "own outcomes" is the signal instead of a live
// order book). The strategy: undercut on a type's first-ever listing since an early/thin market
// has no visible price to anchor buyers, then walk the price up after a fast sale or down after
// a stale one — sequential price discovery, which is the right tool precisely when there are too
// few comparable listings to read a market price off directly.
import type { ListingRecord } from './market_history.ts'

const PCT_SCALE = 1000n
const pct = (mist: bigint, factor: number): bigint =>
  (mist * BigInt(Math.round(factor * Number(PCT_SCALE)))) / PCT_SCALE

export const FIRST_LISTING_UNDERCUT = 0.15 // no comparable sale yet — price under our own estimate to actually get seen
export const FAST_SELL_RAISE = 0.1 // sold quickly last time — the market will likely bear more
export const STALE_CUT = 0.12 // sat unsold past the timeout — priced above what the market will bear
export const MIN_PRICE_FLOOR = 0.4 // never chase the price down past this fraction of the base estimate
export const FAST_SELL_MS = 6 * 60 * 60 * 1000 // sold within 6h of listing counts as "fast"

export const suggest_listing_price_mist = (
  item_type: string,
  base_price_mist: bigint,
  history: readonly ListingRecord[]
): bigint => {
  const floor = pct(base_price_mist, MIN_PRICE_FLOOR)
  const clamped = (candidate: bigint): bigint => (candidate > floor ? candidate : floor)

  const resolved_for_type = history.filter((record) => record.item_type === item_type && record.outcome !== null)
  const last = resolved_for_type.at(-1)
  if (!last) return clamped(pct(base_price_mist, 1 - FIRST_LISTING_UNDERCUT))

  const last_price_mist = BigInt(last.price_mist)
  if (last.outcome === 'sold' && last.resolved_at) {
    const sell_duration_ms = new Date(last.resolved_at).getTime() - new Date(last.listed_at).getTime()
    return sell_duration_ms <= FAST_SELL_MS ? clamped(pct(last_price_mist, 1 + FAST_SELL_RAISE)) : last_price_mist
  }
  // 'unsold' or 'delisted' with no sale: the price was too high — cut it
  return clamped(pct(last_price_mist, 1 - STALE_CUT))
}
