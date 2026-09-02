import { fileURLToPath } from 'node:url'

import { create_local_json_store } from './local_store.ts'

const prices_store = create_local_json_store<Record<string, number>>(
  fileURLToPath(new URL('../item_prices.json', import.meta.url)),
  {}
)

// Default fallback prices in SUI for known items when market price is not listed
const DEFAULT_ESTIMATED_PRICES_SUI: Record<string, number> = {
  water: 0.005,
  fire: 0.008,
  earth: 0.008,
  wind: 0.008,
  wood: 0.01,
  iron: 0.02,
  gold: 0.05,
  potion_hp: 0.015,
  scroll_xp: 0.05,
}

const DEFAULT_FALLBACK_PRICE_SUI = 0.005

export type ItemValuation = {
  qty: number
  unit_price_sui: number
  total_sui: number
  estimated: boolean
}

export type ValuationReport = {
  total_sui: number
  items: Record<string, ItemValuation>
}

/** Reads custom price overrides from `item_prices.json` if available */
export const load_custom_prices = prices_store.read

// No entry in item_prices.json or the drop-price table above (true for every equipment item_type
// today — item_prices.json only carries the 7 raw materials) falls all the way back to this flat
// floor. A level-1 trash drop and a level-60 rare shouldn't list identically, so the fallback
// scales with level as a rough placeholder — real per-item prices belong in item_prices.json
// once actual sales give a signal; this just keeps an uncalibrated first listing from being
// wildly wrong in either direction.
const FALLBACK_LEVEL_SCALING_PER_LEVEL = 0.05

/**
 * Returns estimated or actual marketplace price for an item type in SUI. `level`, when known,
 * only affects the flat unknown-item fallback — a custom or known-drop price is used as-is.
 */
export const get_item_price = (item_type: string, level?: number): { unit_price_sui: number; estimated: boolean } => {
  const custom = load_custom_prices()
  if (typeof custom[item_type] === 'number') {
    return { unit_price_sui: custom[item_type], estimated: false }
  }
  const known = DEFAULT_ESTIMATED_PRICES_SUI[item_type.toLowerCase()]
  if (typeof known === 'number') {
    return { unit_price_sui: known, estimated: true }
  }
  const scale = 1 + Math.max(0, (level ?? 1) - 1) * FALLBACK_LEVEL_SCALING_PER_LEVEL
  return { unit_price_sui: Number((DEFAULT_FALLBACK_PRICE_SUI * scale).toFixed(6)), estimated: true }
}

/**
 * Evaluates the total estimated value of drops in SUI.
 */
export const value_drops = (drops: Record<string, number>): ValuationReport => {
  let total_sui = 0
  const items: Record<string, ItemValuation> = {}

  for (const [item_type, qty] of Object.entries(drops)) {
    if (qty <= 0) continue
    const { unit_price_sui, estimated } = get_item_price(item_type)
    const item_total = Number((unit_price_sui * qty).toFixed(6))
    total_sui += item_total
    items[item_type] = {
      qty,
      unit_price_sui,
      total_sui: item_total,
      estimated,
    }
  }

  return {
    total_sui: Number(total_sui.toFixed(6)),
    items,
  }
}

/**
 * Calculates farming profitability for a fight.
 */
export const calculate_farming_profit = (
  drops_value_sui: number,
  gas_spent_sui: number
): { net_profit_sui: number; is_profitable: boolean; roi_percent: number } => {
  const net_profit_sui = Number((drops_value_sui - gas_spent_sui).toFixed(6))
  const is_profitable = net_profit_sui > 0
  const roi_percent = gas_spent_sui > 0 ? Number(((net_profit_sui / gas_spent_sui) * 100).toFixed(1)) : 0
  return { net_profit_sui, is_profitable, roi_percent }
}
