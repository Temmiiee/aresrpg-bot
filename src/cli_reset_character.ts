// bun run src/cli_reset_character.ts <name> [--stats-only|--spells-only]
//
// Buys scroll_of_rebirth (progression's reset_stats — every level-granted point returns,
// character.move) and/or scroll_of_oblivion (reset_spells — the raised-spell book clears, points
// refund) from the shop and uses one of each on the named character. A rare, manual maintenance
// action for a character whose CURRENT stat/spell allocation predates
// DEFAULT_PRIMARY_STAT_SHARE and caster_damage_multiplier (stat_allocation.ts) — those only
// shape NEW points going forward, never retroactively. This script only clears the slate; the
// very next `bun run session` / `bun run group-fight` naturally re-spends the refunded points
// correctly through the normal prepare_party flow, with no separate re-spend step needed here.
//
// Price is read LIVE off each Sale object, never assumed: seed/content/shop.json's "price": 5
// reads as 5 MIST at a glance, but what's actually live on-chain is 5 SUI (5_000_000_000 MIST) —
// the seed value is deploy-time input, not the deployed unit. Confirmed live 2026-09-03 after a
// hardcoded-5-MIST assumption aborted on shop.move's EWrongPayment (2402); worth exactly this
// much less trust in any other seed-file number read as a live price without checking.
import { buy_shop_item } from '@aresrpg/sdk/shop'
import { sale_id } from '@aresrpg/sdk/seed-ids'
import { living_content } from '@aresrpg/sdk'

import { get_enoki_signer } from './enoki_auth.ts'
import { create_bot_sdk } from './sdk_client.ts'
import { CHARACTERS } from './party_config.ts'
import { read_sellable_items } from './kiosk_inventory.ts'
import { mist_to_sui_string } from './faucet.ts'

const RESET_SCROLLS = {
  stats: { item_type: 'scroll_of_rebirth', label: 'stats' },
  spells: { item_type: 'scroll_of_oblivion', label: 'spells' },
} as const

const live_sale_price_mist = async (bot: ReturnType<typeof create_bot_sdk>, item_type: string): Promise<bigint> => {
  const { sdk } = bot
  const { content_root, seed_package_original } = living_content(sdk, 'Shop price check')
  const game_original = sdk.game_type_package
  if (!game_original) throw new Error('Shop price check unavailable: pins.json has no original game package')
  const id = sale_id(content_root, game_original, item_type)
  const { objects } = await sdk.sui_client.core.getObjects({ objectIds: [id], include: { json: true } })
  const price = (objects[0]?.json as { price?: string } | undefined)?.price
  if (typeof price !== 'string') throw new Error(`Sale for ${item_type} not found or has no price`)
  return BigInt(price)
}

const main = async () => {
  const [, , name] = process.argv
  const character = CHARACTERS.find((c) => c.name === name)
  if (!character) {
    console.log(
      `usage: bun run src/cli_reset_character.ts <name>  (one of ${CHARACTERS.map((c) => c.name).join(', ')})`
    )
    process.exitCode = 1
    return
  }
  const only_stats = process.argv.includes('--stats-only')
  const only_spells = process.argv.includes('--spells-only')
  const modes = only_stats ? (['stats'] as const) : only_spells ? (['spells'] as const) : (['stats', 'spells'] as const)

  const signer = await get_enoki_signer()
  const bot = create_bot_sdk(signer)

  const prices = new Map<string, bigint>()
  for (const mode of modes) prices.set(mode, await live_sale_price_mist(bot, RESET_SCROLLS[mode].item_type))
  const total_mist = [...prices.values()].reduce((sum, p) => sum + p, 0n)
  const balance_mist = await bot.sdk.read_sui_balance()

  console.log(`${character.name}: resetting ${modes.map((m) => RESET_SCROLLS[m].label).join(' + ')}`)
  for (const mode of modes)
    console.log(`  ${RESET_SCROLLS[mode].item_type}: ${mist_to_sui_string(prices.get(mode)!)} SUI`)
  console.log(`total: ${mist_to_sui_string(total_mist)} SUI — wallet balance: ${mist_to_sui_string(balance_mist)} SUI`)
  if (balance_mist < total_mist) {
    console.log('\nnot enough SUI for this — stopping before buying anything.')
    process.exitCode = 1
    return
  }

  const cap = await bot.kiosk_cap()
  if (!cap) throw new Error('No personal kiosk found for this account')

  for (const mode of modes) {
    const { item_type, label } = RESET_SCROLLS[mode]
    console.log(`\nbuying ${item_type} for ${character.name}…`)
    await buy_shop_item(bot.sdk, cap, {
      item_type,
      category: 'consumable',
      price_mist: prices.get(mode)!,
      quantity: 1,
    })

    const items = await read_sellable_items(bot)
    const scroll = items.find((i) => i.item_type === item_type)
    if (!scroll) throw new Error(`bought ${item_type} but couldn't find it in the kiosk afterward`)

    console.log(`using ${item_type} on ${character.name}…`)
    await bot.character.use_consumable({ character_id: character.id, item_id: scroll.id, item_type })
    console.log(`  ${label} reset`)
  }

  console.log(
    `\n${character.name} reset complete — run \`bun run group-fight\` or \`bun run session\` next to re-spend the refunded points.`
  )
}

await main()
