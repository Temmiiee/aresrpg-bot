// Reads the bot's own kiosk contents straight from the chain — no dependency on the game
// server's authenticated websocket protocol (which this headless bot never connects to; see
// market_history.ts). Equipped items are structurally absent from this list: equipping SENDS
// the item out of the kiosk to the character's own address, and unequipping is what re-locks it
// there (equipment.move's own module doc) — so anything unlisted here is, by construction, spare
// inventory, never gear a character currently has on.
import { KioskClient, type KioskItem } from '@mysten/kiosk'
import { read_item_snapshot, type ItemSnapshot } from '@aresrpg/sdk/item-snapshot'

import type { BotSdk } from './sdk_client.ts'

export type SellableItem = ItemSnapshot & Readonly<{ kiosk_id: string }>

const ITEM_TYPE_SUFFIX = '::item::Item'
const is_unlisted_item = (item: KioskItem): boolean => item.type.endsWith(ITEM_TYPE_SUFFIX) && !item.listing

export const read_sellable_items = async (bot: BotSdk): Promise<SellableItem[]> => {
  const { sdk, address } = bot
  const kiosk_client = new KioskClient({
    client: sdk.sui_client as ConstructorParameters<typeof KioskClient>[0]['client'],
    network: sdk.network,
  })
  const { kioskIds } = await kiosk_client.getOwnedKiosks({ address })

  const per_kiosk = await Promise.all(
    kioskIds.map(async (kiosk_id) => {
      const { items } = await kiosk_client.getKiosk({ id: kiosk_id, options: { withListingPrices: true } })
      const snapshots = await Promise.all(
        items
          .filter(is_unlisted_item)
          .map((item) => read_item_snapshot(sdk.sui_client as never, sdk.game_type_package, item.objectId))
      )
      return snapshots.map((snapshot): SellableItem => ({ ...snapshot, kiosk_id }))
    })
  )

  return per_kiosk.flat()
}
