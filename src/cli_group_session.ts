// bun run src/cli_group_session.ts [max_fights]
//
// Runs group fights back-to-back, unattended: search -> engage -> fight -> settle, then repeat
// with the new position, logging each result to session.jsonl. Meant to be started and left
// running in the background (see README "Running unattended"). Ctrl+C to stop — the current
// fight (if any) resumes cleanly on the next run via group-state.local.json.
import { get_enoki_signer } from './enoki_auth.ts'
import { create_bot_sdk } from './sdk_client.ts'
import { run_one_group_fight } from './fight_session.ts'
import { message_of, is_insufficient_balance } from './chain_retry.ts'
import { read_position, write_position } from './position_state.ts'
import { append_log, clear_log, type FightLogEntry } from './session_log.ts'
import { GAS_WARN_MIST, mist_to_sui } from './session_stats.ts'
import { write_status } from './status_state.ts'
import { CHARACTERS } from './party_config.ts'
import { value_drops, calculate_farming_profit } from './item_valuation.ts'
import { ensure_min_balance, mist_to_sui_string, faucet_cooldown_remaining_ms } from './faucet.ts'

const DELAY_BETWEEN_FIGHTS_MS = 5_000
const RETRY_DELAY_MS = 30_000
const NO_TARGET_RETRY_DELAY_MS = 10 * 60_000 // zones only reroll every 2h — no point hammering
// A gas-selection "insufficient balance" failure means nothing will change for a while — the
// same reasoning that got the faucet itself a cooldown (faucet.ts) applies one layer up: retrying
// every 30s here would just spend that whole window re-attempting a doomed transaction instead of
// waiting it out. Floor of 2min covers the case where the wallet is simply low but the faucet was
// never actually rate-limited (no cooldown tracked yet) — still much less aggressive than 30s.
const INSUFFICIENT_BALANCE_MIN_RETRY_DELAY_MS = 2 * 60_000

const max_fights = process.argv[2] ? Number(process.argv[2]) : Infinity
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))
const timestamp = () => new Date().toISOString().slice(11, 19)
const describe_mobs = (mobs: readonly { mob_type: string; level: number }[]) =>
  mobs.map((m) => `${m.mob_type}(lv${m.level})`).join(', ')

const retry_delay_ms = (error: unknown, message: string): number => {
  if (/No group in this zone is within reach/.test(message)) return NO_TARGET_RETRY_DELAY_MS
  // Same reasoning as the case above -- zones only reroll every 2h, so a zone with nothing
  // winnable right now won't have anything different in 30s either.
  if (/clears the .*% win-rate floor/.test(message)) return NO_TARGET_RETRY_DELAY_MS
  if (is_insufficient_balance(error))
    return Math.max(INSUFFICIENT_BALANCE_MIN_RETRY_DELAY_MS, faucet_cooldown_remaining_ms())
  return RETRY_DELAY_MS
}

const main = async () => {
  clear_log()
  const signer = await get_enoki_signer()
  const address = create_bot_sdk(signer).address
  console.log(`session start — address ${address}, up to ${max_fights === Infinity ? 'unlimited' : max_fights} fights`)

  let position = read_position()
  let count = 0

  while (count < max_fights) {
    count += 1
    // A fresh BotSdk every fight, not one reused for the whole session (2026-09-05): the SDK's
    // own object-resolution cache accumulates across calls within one instance, and a search_zone
    // (or its refresh fallback) hydrating an object early in a fight, followed later by that same
    // object's version changing on-chain, leaves engage()'s later reference to it stale --
    // surfacing as "[sdk] unresolved object ... hydrate it first", reproducibly, only when
    // preceded by a search/refresh in the SAME process. Confirmed live: calling fight.engage()
    // with the EXACT failing parameters from a brand-new process (fresh cache, no preceding
    // search/refresh) succeeded every time. get_enoki_signer() reuses the cached session file (no
    // network round-trip), so recreating this per fight costs nothing real.
    const bot = create_bot_sdk(signer)
    console.log(`\n[${timestamp()}] === fight ${count} ===`)
    write_status(`fight ${count}: starting…`, count)
    try {
      const { balance_mist, claim } = await ensure_min_balance(bot.sdk.read_sui_balance, bot.address)
      if (claim?.claimed) {
        console.log(
          `  ⛽ balance ${mist_to_sui_string(balance_mist)} SUI — claimed from faucet (${claim.coins_sent} coin(s))`
        )
      } else if (claim && !claim.claimed) {
        console.log(
          `  ⛽ balance ${mist_to_sui_string(balance_mist)} SUI — faucet claim failed (${claim.reason}: ${claim.detail})`
        )
      }

      const outcome = await run_one_group_fight(bot, position, (msg) => {
        console.log(`  ${msg}`)
        write_status(msg, count)
      })
      position = outcome.new_position
      write_position(position)

      const gas_sui = Number(outcome.gas_mist) / 1e9
      const valuation = value_drops(outcome.drops ?? {})
      const profit = calculate_farming_profit(valuation.total_sui, gas_sui)

      const entry: FightLogEntry = {
        at: new Date().toISOString(),
        fight_id: outcome.fight_id,
        won: outcome.won,
        mobs: outcome.mobs,
        turns: outcome.turns,
        gas_mist: outcome.gas_mist.toString(),
        xp_gained: outcome.xp_gained,
        error: null,
        drops: outcome.drops,
        drops_value_sui: valuation.total_sui,
        net_profit_sui: profit.net_profit_sui,
      }
      append_log(entry)

      const drop_summary =
        Object.entries(outcome.drops ?? {})
          .map(([item, qty]) => `${item} x${qty}`)
          .join(', ') || 'none'

      write_status(`fight ${count}: ${outcome.won ? 'WON' : 'LOST'} vs ${describe_mobs(outcome.mobs)}`, count)
      console.log(
        `[${timestamp()}] ${outcome.won ? 'WON' : 'LOST'} vs ${describe_mobs(outcome.mobs)} — ${outcome.turns} turns, gas: ${gas_sui.toFixed(4)} SUI` +
          ` | drops: ${drop_summary} (+${valuation.total_sui.toFixed(4)} SUI est.)` +
          ` | NET: ${profit.net_profit_sui >= 0 ? '+' : ''}${profit.net_profit_sui.toFixed(4)} SUI`
      )
      if (outcome.gas_mist >= GAS_WARN_MIST) {
        console.log(
          `⚠ fight cost ${gas_sui.toFixed(4)} SUI — above the ~${mist_to_sui(GAS_WARN_MIST)} SUI expected for this ` +
            `${CHARACTERS.length}-character party (the dev's ~0.02 SUI/character baseline). ` +
            `Worth reporting fight ${outcome.fight_id} + address ${bot.address} to the dev.`
        )
      }
      await sleep(DELAY_BETWEEN_FIGHTS_MS)
    } catch (error) {
      const message = message_of(error)
      console.log(`[${timestamp()}] fight ${count} errored: ${message}`)
      write_status(`fight ${count}: error — ${message}`, count)
      append_log({
        at: new Date().toISOString(),
        fight_id: '',
        won: null,
        mobs: [],
        turns: 0,
        gas_mist: '0',
        xp_gained: {},
        error: message,
      })
      const delay = retry_delay_ms(error, message)
      console.log(`waiting ${(delay / 1000).toFixed(0)}s before retrying…`)
      await sleep(delay)
    }
  }
  write_status(`session done — ${count} fights attempted`, count)
  console.log(`\nsession done — ${count} fights attempted. Run "bun run session-stats" for a summary.`)
}

await main()
