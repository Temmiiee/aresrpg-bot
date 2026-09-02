// Prepares and (optionally) executes HDV listings for the bot's spare kiosk inventory, priced
// adaptively from the item's own past listing outcomes (market_pricing.ts) — the whole pipeline
// works identically on testnet today and on mainnet later; only sdk_client.ts's RPC/network
// picks which chain it touches. Planning is always safe (read-only); execution actually lists
// real items for real SUI, so callers decide when to cross that line.
import { KioskClient } from '@mysten/kiosk'

import { get_item_price } from './item_valuation.ts'
import { read_sellable_items } from './kiosk_inventory.ts'
import { append_listing, read_market_history, resolve_listing, type ListingRecord } from './market_history.ts'
import { suggest_listing_price_mist } from './market_pricing.ts'
import type { BotSdk } from './sdk_client.ts'

const MIST_PER_SUI = 1_000_000_000n
const mist_of_sui = (sui: number): bigint => BigInt(Math.round(sui * Number(MIST_PER_SUI)))
const sui_of_mist = (mist: bigint): string => (Number(mist) / Number(MIST_PER_SUI)).toFixed(4)

export type SellDecision = Readonly<{
  item_id: string
  item_type: string
  name: string
  kiosk_id: string
  price_mist: bigint
  price_sui: string
  estimated_price: boolean
}>

/** Read-only: what the auto-seller would list, and at what price, right now. Skips any item
 *  still tied to an open (unresolved) listing record so a re-plan never proposes the same item
 *  twice while it's already up for sale. */
export const plan_auto_sell = async (bot: BotSdk): Promise<SellDecision[]> => {
  const items = await read_sellable_items(bot)
  const history = read_market_history()
  const open_item_ids = new Set(history.filter((record) => record.outcome === null).map((record) => record.listing_id))

  return items
    .filter((item) => !open_item_ids.has(item.id))
    .map((item): SellDecision => {
      const { unit_price_sui, estimated } = get_item_price(item.item_type, item.level)
      const base_price_mist = mist_of_sui(unit_price_sui)
      const price_mist = suggest_listing_price_mist(item.item_type, base_price_mist, history)
      return {
        item_id: item.id,
        item_type: item.item_type,
        name: item.name,
        kiosk_id: item.kiosk_id,
        price_mist,
        price_sui: sui_of_mist(price_mist),
        estimated_price: estimated,
      }
    })
}

/** Actually lists the given decisions on-chain and records each as an open history entry. */
export const execute_auto_sell = async (
  bot: BotSdk,
  decisions: readonly SellDecision[]
): Promise<readonly Readonly<{ decision: SellDecision; digest: string }>[]> => {
  const results: Readonly<{ decision: SellDecision; digest: string }>[] = []
  for (const decision of decisions) {
    const { digest, listed_id } = await bot.marketplace.list({
      kind: 'item',
      id: decision.item_id,
      kiosk: decision.kiosk_id,
      price_mist: decision.price_mist,
    })
    const listed_at = new Date().toISOString()
    append_listing({
      listing_id: listed_id,
      item_type: decision.item_type,
      kiosk_id: decision.kiosk_id,
      price_mist: decision.price_mist.toString(),
      listed_at,
      resolved_at: null,
      outcome: null,
    })
    results.push({ decision, digest })
  }
  return results
}

type KioskPresence = 'listed' | 'present_unlisted' | 'absent'

/** Checks every still-open listing against live kiosk state: still listed there → leave open;
 *  present but no longer listed → 'delisted' (removed without this module's own execute path,
 *  e.g. by hand in the game client); absent from the kiosk entirely → 'sold' — the only way a
 *  listed item leaves kiosk custody, since nothing in this codebase delists automatically. */
export const reconcile_market_history = async (bot: BotSdk): Promise<void> => {
  const open = read_market_history().filter((record: ListingRecord) => record.outcome === null)
  if (open.length === 0) return

  const kiosk_client = new KioskClient({
    client: bot.sdk.sui_client as ConstructorParameters<typeof KioskClient>[0]['client'],
    network: bot.sdk.network,
  })
  const presence_by_kiosk = new Map<string, ReadonlyMap<string, KioskPresence>>()
  for (const kiosk_id of new Set(open.map((record) => record.kiosk_id))) {
    const { items } = await kiosk_client.getKiosk({ id: kiosk_id, options: { withListingPrices: true } })
    presence_by_kiosk.set(
      kiosk_id,
      new Map(items.map((item) => [item.objectId, item.listing ? 'listed' : 'present_unlisted']))
    )
  }

  const resolved_at = new Date().toISOString()
  for (const record of open) {
    const presence = presence_by_kiosk.get(record.kiosk_id)?.get(record.listing_id) ?? 'absent'
    if (presence === 'listed') continue
    resolve_listing(record.listing_id, presence === 'present_unlisted' ? 'delisted' : 'sold', resolved_at)
  }
}
