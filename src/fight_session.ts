// The reusable group-fight engine — one call runs exactly one fight (search, difficulty check,
// engage, join, ready, turn loop, settle) and returns a full outcome report. Both the
// single-fight CLI and the looping session CLI call this; the logic lives in exactly one place.
//
// Split into one function per phase (prepare party -> find/create fight -> join & ready -> turn
// loop -> settle & report) purely for readability — each phase runs exactly once, in this exact
// order, same as when it was one function; nothing here changes what the bot actually does.
import { living_content } from '@aresrpg/sdk'
import { world_content_id, world_id as derive_world_id } from '@aresrpg/sdk/seed-ids'
import { create_fight, type FightCommand, type HydratedFightCheckpoint } from '@aresrpg/fight'

import type { BotSdk } from './sdk_client.ts'
import { castable_spells } from './spell_catalog.ts'
import { record_attempt, success_rate } from './spell_memory.ts'
import { read_group_state, write_group_state } from './group_state.ts'
import { read_mob_groups } from './zone_read.ts'
import { approach_path, find_cast_cell, manhattan, path_to, type SimState } from './fight_geometry.ts'
import { CHARACTERS, LEADER, PARTY_ID, WORLD } from './party_config.ts'
import { estimate_max_hp, ms_until_fraction, read_hp_state, write_hp_state, type HpState } from './hp_state.ts'
import {
  PRIMARY_STAT_BY_CLASS,
  split_stat_spending,
  caster_damage_multiplier,
  type LiveStats,
} from './stat_allocation.ts'
import {
  simulate_many,
  reward_score,
  type SimBatchResult,
  type SimMobGroupMember,
  type SimPartyMember,
} from './simulate.ts'
import { load_trained_policy } from './policy_store.ts'
import { element_advantage } from './policy.ts'
import { decide_turn_with_lookahead } from './lookahead.ts'
import { live_state_to_checkpoint, live_max_hp_by_character } from './live_checkpoint.ts'
import { read_live_character_stats } from './live_character.ts'
import { message_of, sleep, submit_with_retry, is_transient } from './chain_retry.ts'
import { auto_equip_available_gear } from './auto_equip.ts'

// Multi-turn lookahead (validated 2026-09-01 in the simulator: 30%->80% and 10%->50% win rate
// on contested matchups — see lookahead.ts) tried FIRST each turn; on ANY failure (an
// approximation in live_checkpoint.ts not holding, an unexpected field shape, anything) this
// silently falls back to the existing single-turn greedy logic below, which keeps working
// exactly as it did before this file ever existed. A wrong guess here costs nothing extra; it
// just doesn't help that turn.
const USE_LOOKAHEAD = true

// Loaded once at module scope — cli_train.ts's evolutionary search result if one exists, else
// the untrained default (policy.ts). Same policy the simulator scored candidates with, so a
// group accepted by the pre-engage screening (SIM_SCREEN_*) is actually fought the way it was
// evaluated.
const { policy: DECISION_POLICY, source: DECISION_POLICY_SOURCE } = load_trained_policy()

const SPEED_BUDGET = 1150
const SPEED_SCALE = 100_000
const WAIT_MARGIN_MS = 4_000
const TURN_MIN_MS = 3_000
const TURN_WAIT_MARGIN_MS = 500
// A mob group is skipped unless its average member level is within this many levels of the
// party's own average. Was 2 (the lesson from the moka fight, avg level 7.3 vs party avg 4.5,
// back when nothing screened harder groups at all before engaging) — widened once real
// simulation became the actual safety check (MIN_SIM_WIN_RATE below): this is now only a cheap
// pre-filter against truly hopeless matchups, not the winnability gate itself, so it can afford
// to let much harder — and more rewarding — groups through to simulation (2026-09-03, user
// request: prefer harder-but-still-winnable fights over always the safest one).
const MAX_LEVEL_MARGIN = 8
// How many level-eligible groups get an actual offline simulation before engaging — bounded
// because each one costs real wall-clock time (harder matchups run several seconds), not because
// it costs gas (it doesn't). Raised alongside MAX_LEVEL_MARGIN so opening the level range doesn't
// just get shadowed by an unchanged cap — see the pre-sort below for which groups fill it first
// when there are more eligible ones than this.
const SIM_SCREEN_CANDIDATES = 10
const SIM_SCREEN_RUNS = 5
// The hard safety floor: a group under this simulated win rate is skipped no matter how
// rewarding it looks — "always winnable" stays non-negotiable; reward_score (simulate.ts) only
// ever ranks candidates that already clear it. Deliberately NOT loosened alongside
// MAX_LEVEL_MARGIN above (2026-09-03, explicit user instruction: focus fights that are ALWAYS
// winnable, just don't rule out harder/farther ones a-priori before simulation gets to check).
// Revisit only once AresRPG-RL exports a validated stronger policy (learned_policy.local.json,
// the sibling repo's tools/export_policy_to_bot.py) that measurably wins harder fights faster —
// cli_validate_policy.ts's held-out comparison is the signal to check first.
const MIN_SIM_WIN_RATE = 0.6
// Don't walk into another fight under-healed — the lesson from going in at 1 HP after a loss.
const MIN_HP_FRACTION = 0.8
// Stalemate detection: if total enemy HP hasn't dropped after a full round's worth of turns, the
// enemies are healing faster than the party can damage them and the fight is a guaranteed
// infinite loop. Concede early by passing all remaining turns — cheaper than burning gas forever.
const STALEMATE_CHECK_INTERVAL = 20 // re-check every 20 turns
const STALEMATE_HP_FLOOR_FRACTION = 0.02 // must clear at least 2% total enemy HP per interval

// `stats` sits at the TOP LEVEL of every fighter (player and mob alike) -- NOT nested under
// `kind.pos0` as this type assumed until 2026-09-05. Confirmed live via a raw JSON dump: a mob's
// `kind.pos0` only ever carried build/loot data (kit/level/loot/mob_type/xp), never max_hp or any
// resistance; those, plus base_ap/base_mp and the stat sheet, live in this shared `stats` object,
// with full resistance names (earth_resistance, not earth_res). Reading pos0.max_hp/pos0.earth_res
// (the old code) silently produced NaN in finish_bonus/element_bonus for every live fight, ever
// since those were written -- no crash, just corrupted candidate scores nobody noticed because
// NaN-tainted comparisons just fall through to something else looking equally arbitrary.
export type FighterStatsJson = {
  max_hp: string | number
  base_ap: string | number
  base_mp: string | number
  earth_resistance: string | number
  fire_resistance: string | number
  water_resistance: string | number
  air_resistance: string | number
  sheet: { agility: string | number; wisdom: string | number }
}
export type FighterJson = {
  team: number
  cell: string | number
  hp: string | number
  mp: string | number
  ap: string | number
  ready: boolean
  settled: boolean
  stats?: FighterStatsJson
  kind: {
    '@variant': string
    character?: string
    pos0?: {
      level?: string | number
      mob_type?: string
      xp?: string | number
      loot?: { item_type: string }[]
    }
  }
}
// A guess (weapon stats aren't read) used only to budget the local multi-action loop below —
// if it's wrong the chain simply rejects that step, same as any other candidate miss.
const ASSUMED_STRIKE_AP_COST = 4
export type FightJson = {
  fighters: FighterJson[]
  queue: (string | number)[]
  turn_ptr: string | number
  turn_started_ms: string | number
  ended: boolean
  winner: number | null
  x: number
  z: number
  closed: (string | number)[]
  board: { obstacles: (string | number)[] }
}

// The live Fight object's REAL on-chain shape (2026-09-05, after the fight.move rewrite):
// fighters/board/closed/ended/queue/round/winner/turn_seed/turn_started_ms all moved under a
// nested `combat` object instead of sitting at the top level, `turn_ptr` was renamed
// `turn_pointer`, and each fighter's `kind` no longer carries `character`/`owner` inline for
// players -- that now lives in a PARALLEL top-level `authorities` array, matched by the same
// index as `combat.fighters`. Every caller in this file (and live_checkpoint.ts, which receives
// whatever read_fight returns) was written against the OLD flat shape, so this normalizes at
// the one boundary where raw chain JSON enters the system instead of touching every call site --
// confirmed live: a real fight's raw JSON has zero top-level `fighters`, crashing
// `fighter_indices` with "undefined is not an object (evaluating 'fight.fighters.forEach')".
type RawAuthority = { '@variant': string; character?: string; owner?: string }
type RawFightJson = {
  x: number
  z: number
  authorities?: RawAuthority[]
  combat: {
    fighters: FighterJson[]
    board: { obstacles: (string | number)[] }
    closed: (string | number)[]
    ended: boolean
    winner: number | null
    queue: (string | number)[]
    turn_pointer: string | number
    turn_started_ms: string | number
  }
}
export const normalize_fight_json = (raw: RawFightJson): FightJson => ({
  x: raw.x,
  z: raw.z,
  ended: raw.combat.ended,
  winner: raw.combat.winner,
  queue: raw.combat.queue,
  turn_ptr: raw.combat.turn_pointer,
  turn_started_ms: raw.combat.turn_started_ms,
  closed: raw.combat.closed,
  board: raw.combat.board,
  fighters: raw.combat.fighters.map((f, idx) => {
    const authority = raw.authorities?.[idx]
    return authority?.character ? { ...f, kind: { ...f.kind, character: authority.character } } : f
  }),
})

const as_number = (v: string | number): number => (typeof v === 'number' ? v : Number(v))

// A fight object with no live dynamic fields can be closed (deleted) by any participant once
// everyone has settled — fight.move's `close()`. Nothing in this bot ever calls it, so a
// vanished fight_id means something ELSE closed it after we lost track (our own read of `ended`
// lagging behind the object's true latest version long enough that we kept polling a fight that
// had already concluded and been cleaned up). Distinguishing this from a real read failure lets
// the caller drop the dead fight_id instead of retrying it forever.
export class FightNotFoundError extends Error {}

const PROPAGATION_RETRY_DELAYS_MS = [500, 1_000, 2_000, 3_000]
const read_fight = async (sdk: BotSdk['sdk'], fight_id: string): Promise<FightJson> => {
  for (let attempt = 0; ; attempt += 1) {
    const { objects } = await sdk.sui_client.core.getObjects({ objectIds: [fight_id], include: { json: true } })
    const json = objects[0]?.json
    if (json) return normalize_fight_json(json as unknown as RawFightJson)
    const delay = PROPAGATION_RETRY_DELAYS_MS[attempt]
    if (delay === undefined)
      throw new FightNotFoundError(`Fight object ${fight_id} not found after propagation retries`)
    await sleep(delay)
  }
}

const fighter_indices = (fight: FightJson): Map<string, number> => {
  const map = new Map<string, number>()
  fight.fighters.forEach((fighter, idx) => {
    if (fighter.kind['@variant'] === 'Player' && fighter.kind.character) map.set(fighter.kind.character, idx)
  })
  return map
}

export type Position = { x: number; z: number }
export type MobInfo = { mob_type: string; level: number }
export type FightOutcome = {
  won: boolean
  fight_id: string
  new_position: Position
  gas_mist: bigint
  xp_gained: Record<string, number>
  turns: number
  mobs: readonly MobInfo[]
  drops: Record<string, number>
}

// ── Phase 1: pre-fight party prep — spend stat/spell points, read the stats the rest of the
// fight (screening, HP gate, live decisions) needs. ─────────────────────────────────────────

type PartyPrep = {
  levels: Map<string, number>
  max_hp: Map<string, number>
  xp_before: Map<string, number>
  sim_party_stats: Map<string, SimPartyMember>
}

type RawStats = {
  vitality: number
  wisdom: number
  strength: number
  intelligence: number
  chance: number
  agility: number
}

const raise_available_stats = async (
  character: BotSdk['character'],
  c: (typeof CHARACTERS)[number],
  stats: RawStats,
  available_points: number,
  log: (msg: string) => void
): Promise<RawStats> => {
  const primary_field = PRIMARY_STAT_BY_CLASS[c.classe]
  const current_primary = primary_field ? stats[primary_field] : 0
  const spending = split_stat_spending(c.classe, available_points, current_primary)
  const summary = Object.entries(spending)
    .map(([stat, points]) => `${points} ${stat}`)
    .join(', ')
  log(`${c.name} has ${available_points} unspent stat point(s) — spending ${summary}…`)
  try {
    await submit_with_retry(() => character.raise_stats({ character_id: c.id, spending }), log)
    const updated = { ...stats }
    for (const [stat, points] of Object.entries(spending)) updated[stat as keyof RawStats] += points
    return updated
  } catch (error) {
    log(`raise_stats failed: ${message_of(error)}`)
    return stats
  } finally {
    await sleep(1_500)
  }
}

// Spell points (1 per level from level 2, progression.move) raise a spell's cast level — 1→2
// costs 1 point, 2→3 costs 2, etc. Rather than pre-reading the exact invested level (a dynamic
// field, a separate query), just keep raising the best-scoring known damage spell and stop on
// the first "can't afford the next level"/"already capped" abort — both expected, not real
// problems, bounded by available_spell_points attempts at most.
//
// "Best" is ranked by REAL expected damage, not spell_catalog.ts's raw authored score alone:
// caster_damage_multiplier folds in the character's own live stats through the exact in-game
// formula (fight_math::amplify_damage), and success_rate folds in how often this spell has
// actually landed for this class when tried. A spell with a great raw number but the wrong
// element for this build gets a 1.0x (or near it) multiplier — no better than a weapon strike —
// while a lower-raw-score spell the build actually amplifies can be the real pick. Same weighting
// decide_and_commit_turn uses to CAST each turn, so what gets leveled matches what actually
// carries the fight, not just what a static number ranked highest.
const raise_best_damage_spell = async (
  character: BotSdk['character'],
  c: (typeof CHARACTERS)[number],
  level: number,
  stats: LiveStats,
  available_spell_points: number,
  log: (msg: string) => void
): Promise<void> => {
  const [best_damage_spell] = castable_spells(c.classe, level)
    .filter((s) => s.role === 'damage')
    .map((s) => ({
      ...s,
      effective_score: s.score * caster_damage_multiplier(s.element, stats) * success_rate(c.classe, s.name),
    }))
    .sort((a, b) => b.effective_score - a.effective_score)
  if (!best_damage_spell) return

  let raised = 0
  for (let attempt = 0; attempt < available_spell_points; attempt += 1) {
    try {
      await submit_with_retry(() => character.raise_spell({ character_id: c.id, spell: best_damage_spell.name }), log)
      raised += 1
    } catch (error) {
      if (!/abort code:\s*(1602|1603)\b/i.test(message_of(error))) log(`raise_spell failed: ${message_of(error)}`)
      break
    }
    // Same spacing every other rapid-fire kiosk-touching loop in this file uses (join, ready,
    // settle) — missing it here caused a real "provided version doesn't match" race that killed
    // a whole fight attempt (2026-09-01, live).
    await sleep(2_000)
  }
  if (raised > 0) log(`${c.name} raised ${best_damage_spell.name} by ${raised} level(s)`)
}

const prepare_party = async (bot: BotSdk, log: (msg: string) => void): Promise<PartyPrep> => {
  const { sdk, character } = bot
  const levels = new Map<string, number>()
  const max_hp = new Map<string, number>()
  const xp_before = new Map<string, number>()
  const sim_party_stats = new Map<string, SimPartyMember>()

  for (const c of CHARACTERS) {
    const live = await read_live_character_stats(sdk, c.id)
    const { level } = live
    levels.set(c.id, level)
    let stats: RawStats = {
      vitality: live.vitality,
      wisdom: live.wisdom,
      strength: live.strength,
      intelligence: live.intelligence,
      chance: live.chance,
      agility: live.agility,
    }
    if (live.available_points > 0) stats = await raise_available_stats(character, c, stats, live.available_points, log)
    max_hp.set(c.id, estimate_max_hp(level, stats.vitality))
    xp_before.set(c.id, live.experience)

    if (live.available_spell_points > 0)
      await raise_best_damage_spell(character, c, level, stats, live.available_spell_points, log)

    sim_party_stats.set(c.id, { name: c.name, classe: c.classe, level, ...stats })
  }

  return { levels, max_hp, xp_before, sim_party_stats }
}

// ── Phase 2: find an in-progress fight to resume, or search + screen + engage a fresh one. ──

// Detects a character already seated in an on-chain fight by walking its OWNER chain up to 2
// hops (character -> immediate owner -> that owner's owner), since a character inside a fight is
// owned by the Fight object either directly or via one wrapper. Best-effort: a read failure just
// means "couldn't tell," not "definitely not in a fight," so the caller falls through to the
// normal search-a-fresh-fight path rather than treating it as fatal. Accepted soft hotspot
// (cyclomatic ~14 vs. this repo's usual 12 ceiling) — the 2-hop walk is inherently this many
// branches; splitting it further would trade clarity for a number this package isn't gated on.
const find_active_fight_id = async (
  sdk: BotSdk['sdk'],
  character_id: string,
  log: (msg: string) => void
): Promise<string | null> => {
  const is_fight = (t?: string) => Boolean(t && t.endsWith('::fight::Fight'))
  const owner_id = (object?: { owner?: unknown }): string | null => {
    const owner = (object?.owner as { ObjectOwner?: unknown })?.ObjectOwner
    return typeof owner === 'string' ? owner : null
  }
  // The gRPC transport accepts `owner` in `include` at runtime; SuiTransport's own declared type
  // only names `json` (client.ts's narrower structural interface for the SDK's OWN needs) — this
  // local widening reflects the real, wider runtime contract without touching the shared SDK.
  const get_objects_with_owner = (input: { objectIds: string[]; include: { owner?: boolean; json?: boolean } }) =>
    sdk.sui_client.core.getObjects(input as { objectIds: string[]; include?: { json?: boolean } })
  try {
    const { objects: r1 } = await get_objects_with_owner({ objectIds: [character_id], include: { owner: true } })
    const p1 = owner_id(r1[0])
    if (!p1) return null

    const { objects: r2 } = await get_objects_with_owner({ objectIds: [p1], include: { owner: true, json: true } })
    if (is_fight(r2[0]?.type)) return p1
    const p2 = owner_id(r2[0])
    if (!p2) return null

    const { objects: r3 } = await sdk.sui_client.core.getObjects({ objectIds: [p2], include: { json: true } })
    return is_fight(r3[0]?.type) ? p2 : null
  } catch (error) {
    log(`active-fight detection for ${character_id} inconclusive (${message_of(error)}) — assuming not in a fight`)
    return null
  }
}

type FoundFight = Readonly<
  { kind: 'ready'; fight_id: string; mobs: readonly MobInfo[] } | { kind: 'retried'; outcome: FightOutcome }
>

const find_or_create_fight = async (
  bot: BotSdk,
  position: Position,
  zx: number,
  zz: number,
  world: string,
  world_content: string,
  prep: PartyPrep,
  log: (msg: string) => void
): Promise<FoundFight> => {
  const { sdk, fight, character } = bot

  let { fight_id } = read_group_state()
  if (!fight_id) {
    for (const c of CHARACTERS) {
      const active_id = await find_active_fight_id(sdk, c.id, log)
      if (active_id) {
        fight_id = active_id
        write_group_state({ fight_id })
        log(`detected character ${c.name} already in active on-chain fight ${fight_id} — resuming fight!`)
        break
      }
    }
  }
  if (fight_id) {
    log(`resuming fight ${fight_id}`)
    return { kind: 'ready', fight_id, mobs: [] }
  }

  // HP-regen gate: only relevant when we're about to CHOOSE a new fight, not when resuming
  // one already in progress. Waits for the slowest-healing character to reach MIN_HP_FRACTION.
  const hp_state = read_hp_state()
  const now = Date.now()
  const hp_wait_ms = CHARACTERS.reduce((worst, c) => {
    const record = hp_state[c.id]
    return record ? Math.max(worst, ms_until_fraction(record, MIN_HP_FRACTION, now)) : worst
  }, 0)
  if (hp_wait_ms > 0) {
    log(`waiting ${(hp_wait_ms / 1000).toFixed(0)}s for the party to regen to ${MIN_HP_FRACTION * 100}% HP…`)
    await sleep(hp_wait_ms)
  }

  log(`searching zone (${zx},${zz}) at (${position.x},${position.z})…`)
  // search_zone's `refresh` isn't optional (character_actions.ts: false for first discovery,
  // true once the derived Zone object already exists) -- there's no local record of which
  // zones this account has already discovered, so try a fresh discovery first and fall back to
  // refresh only on the specific "already exists" collision. This dry-run-rejects-before-
  // submitting (the SDK's own "NOT submitted" wording), so the fallback costs no extra gas.
  try {
    await submit_with_retry(
      () => character.search_zone({ character_id: LEADER.id, world: WORLD, x: position.x, z: position.z, refresh: false }),
      log
    )
  } catch (error) {
    if (!/EObjectAlreadyExists|derived_object::claim/i.test(message_of(error))) throw error
    log('zone already discovered — refreshing instead…')
    await submit_with_retry(
      () => character.search_zone({ character_id: LEADER.id, world: WORLD, x: position.x, z: position.z, refresh: true }),
      log
    )
  }
  const checkpoint_at = Date.now()

  const groups = await read_mob_groups(sdk, world, world_content, zx, zz)
  if (groups.length === 0) throw new Error('No mob groups found in this zone right now')

  const party_avg_level = [...prep.levels.values()].reduce((sum, lvl) => sum + lvl, 0) / prep.levels.size
  const avg_level_of = (g: (typeof groups)[number]) =>
    g.members.reduce((sum, m) => sum + m.level_scalar, 0) / g.members.length
  const distance_of = (g: (typeof groups)[number]) => Math.hypot(g.x - position.x, g.z - position.z)

  const easy_enough = groups.filter((g) => avg_level_of(g) <= party_avg_level + MAX_LEVEL_MARGIN)
  if (easy_enough.length === 0) {
    const weakest = [...groups].sort((a, b) => avg_level_of(a) - avg_level_of(b))[0]!
    throw new Error(
      `No group in this zone is within reach of the party's level (party avg ${party_avg_level.toFixed(1)}, weakest group here avg ${avg_level_of(weakest).toFixed(1)})`
    )
  }

  // Simulate the toughest level-eligible candidates first against the party's REAL current stats
  // (free, no gas, only wall-clock cost) — when there are more eligible groups than
  // SIM_SCREEN_CANDIDATES can afford to check, spend that budget on the hardest ones, since those
  // are exactly the higher-XP/better-loot groups worth confirming winnable (2026-09-03: "chercher
  // des monstres de niveau plus élevé mais qu'on pourrait toujours battre" — the softer/closer
  // groups this leaves unsimulated are also the ones least likely to ever be the reward-optimal
  // pick anyway). If nothing simulated clears MIN_SIM_WIN_RATE, fall back to the LOWEST-level
  // screened group instead — the safest bet available, mirroring what "nearest" used to proxy for.
  type ScreenedGroup = {
    group: (typeof easy_enough)[number]
    mob_group: SimMobGroupMember[]
    sim: SimBatchResult | null
  }
  const sim_party = CHARACTERS.map((c) => prep.sim_party_stats.get(c.id)!)
  // Reserve one slot for the single EASIEST group in reach, always -- the rest of the budget
  // still goes to the hardest ones (comment above). Without this, the "fall back to the safest
  // simulated group" below (when nothing clears MIN_SIM_WIN_RATE) can only ever fall back to the
  // safest of the SAME hardest-first slice, never anything genuinely easy that just didn't make
  // the cut -- confirmed happening for a fresh level-1 party (2026-09-04): MAX_LEVEL_MARGIN=8
  // let mobs up to level 9 into `easy_enough`, all 10 simulated candidates were drawn from the
  // hard end of that range, none cleared 60%, and the "safest" fallback was still one of those
  // 10 -- never an easier group sitting right there in the same zone.
  const hardest_first = [...easy_enough].sort((a, b) => avg_level_of(b) - avg_level_of(a))
  const easiest = [...easy_enough].sort((a, b) => avg_level_of(a) - avg_level_of(b))[0]!
  const candidates = [easiest, ...hardest_first.filter((g) => g !== easiest)].slice(0, SIM_SCREEN_CANDIDATES)
  const screened: ScreenedGroup[] = candidates.map((group) => {
    const mob_group: SimMobGroupMember[] = group.members.map((m) => ({ mob_type: m.mob_type, level: m.level_scalar }))
    try {
      return { group, mob_group, sim: simulate_many(sim_party, mob_group, SIM_SCREEN_RUNS) }
    } catch (error) {
      log(`  simulated screening skipped for group #${group.index} (${message_of(error)})`)
      return { group, mob_group, sim: null }
    }
  })
  const viable = screened.filter((s) => s.sim !== null && s.sim.win_rate >= MIN_SIM_WIN_RATE)
  // "Always winnable" is meant to be non-negotiable (MIN_SIM_WIN_RATE's own comment) -- refuse to
  // engage rather than force the least-bad simulated option when NOTHING clears the bar, instead
  // of the old unconditional fallback. Confirmed a real problem for a fresh level-1 party
  // (2026-09-04): every simulated candidate came back well under 60%, and the bot fought the
  // "safest of a bad lot" anyway, repeatedly, rather than waiting for a better zone -- burning
  // gas on fights that were never winnable, exactly what MIN_SIM_WIN_RATE exists to prevent.
  if (viable.length === 0) {
    const safest = [...screened].sort((a, b) => avg_level_of(a.group) - avg_level_of(b.group))[0]!
    throw new Error(
      `Nothing in this zone clears the ${(MIN_SIM_WIN_RATE * 100).toFixed(0)}% win-rate floor (best simulated: group #${safest.group.index} at ${safest.sim ? (safest.sim.win_rate * 100).toFixed(0) : '?'}%) -- refusing to force a losing fight`
    )
  }
  const picked = viable.sort((a, b) => reward_score(b.sim!, b.mob_group) - reward_score(a.sim!, a.mob_group))[0]!
  const target = picked.group
  const mobs = target.members.map((m) => ({ mob_type: m.mob_type, level: m.level_scalar }))
  log(
    `${viable.length > 0 ? 'best-reward-simulated' : 'safest fallback (simulation unavailable or nothing met the win-rate bar)'} group #${target.index} (avg lv ${avg_level_of(target).toFixed(1)} vs party avg ${party_avg_level.toFixed(1)}) at (${target.x},${target.z}) — ${mobs.map((m) => `${m.mob_type}(lv${m.level})`).join(', ')}` +
      (picked.sim
        ? ` [simulated: ${(picked.sim.win_rate * 100).toFixed(0)}% win, ~${picked.sim.avg_turns.toFixed(0)} turns, ${picked.sim.avg_xp_per_turn.toFixed(0)} xp/turn]`
        : '')
  )

  const distance = distance_of(target)
  const required_wait_ms = Math.ceil((distance * SPEED_SCALE) / SPEED_BUDGET) + WAIT_MARGIN_MS
  const remaining_ms = required_wait_ms - (Date.now() - checkpoint_at)
  if (remaining_ms > 0) {
    log(`waiting ${(remaining_ms / 1000).toFixed(1)}s for travel time…`)
    await sleep(remaining_ms)
  }

  log(`${LEADER.name} engaging (group-only access)…`)
  let engaged: { fight: string }
  try {
    engaged = await submit_with_retry(
      () =>
        fight.engage({
          character_id: LEADER.id,
          world: WORLD,
          zone_x: zx,
          zone_z: zz,
          group_index: BigInt(target.index),
          mob_types: mobs.map((m) => m.mob_type),
          access: 1,
        }),
      log
    )
  } catch (error) {
    if (/abort code:\s*1702\b/i.test(message_of(error))) {
      log(`group #${target.index} despawned or was engaged by another player (abort code 1702) — re-searching zone…`)
      await sleep(3_000)
      return { kind: 'retried', outcome: await run_one_group_fight(bot, position, log) }
    }
    // EWrongMob (fight.move) -- add_mob rebuilds its pending queue from the zone's on-chain
    // state fresh at execution time, not from what we read minutes ago while simulating/waiting
    // out travel time; if the zone's seed got rerolled in between (another character's search
    // landing after this zone's TTL expired), group #target.index can have a different
    // size/type/order by the time this transaction actually executes. Same class of race as
    // 1702 above (stale client read vs. authoritative on-chain state at execution), just a
    // different failure shape -- same recovery.
    if (/abort code:\s*1703\b/i.test(message_of(error))) {
      log(`group #${target.index}'s composition changed under us (abort code 1703, likely a zone reseed) — re-searching zone…`)
      await sleep(3_000)
      return { kind: 'retried', outcome: await run_one_group_fight(bot, position, log) }
    }
    throw error
  }
  log(`fight created: ${engaged.fight}`)
  write_group_state({ fight_id: engaged.fight })
  return { kind: 'ready', fight_id: engaged.fight, mobs }
}

// ── Phase 3: join every not-yet-seated character and ready up. ──────────────────────────────

const join_and_ready = async (bot: BotSdk, fight_id: string, log: (msg: string) => void): Promise<void> => {
  const { sdk, fight, kiosk_cap } = bot
  let state_json = await read_fight(sdk, fight_id)
  if (state_json.ended) return

  const leader_idx = fighter_indices(state_json).get(LEADER.id)
  if (leader_idx === undefined) throw new Error('Leader is not seated in this fight — cannot recover automatically')
  const { team } = state_json.fighters[leader_idx]!

  // Placement is a strict on-chain race: combat.move force-starts the fight 60s after engage
  // (PLACEMENT_FORCE_MS) even with only the leader seated, once anyone readies -- after that,
  // join_gate's `in_placement` check is permanently false and any join attempt aborts with
  // ENotPlacement (1706), no matter how many retries. `queue.length > 0` is this file's existing
  // signal for "already started" (checked below, before readying) -- checking it here too, before
  // spending a transaction on a join that's guaranteed to abort, turns a hard crash into a
  // graceful "fight fewer than the full party" instead (2026-09-05, live: a leftover solo fight
  // from earlier in this session crossed the 60s window before the other three could join).
  if (state_json.queue.length > 0) {
    log(`fight already started without the full party seated (placement's 60s window elapsed) — continuing with whoever joined`)
  } else {
    const missing = CHARACTERS.filter((c) => !c.leader && !fighter_indices(state_json).has(c.id))
    if (missing.length > 0) {
      log(`${missing.map((c) => c.name).join(', ')} joining (grouped, one transaction)…`)
      const cap = await kiosk_cap()
      if (!cap) throw new Error('No personal kiosk found for this account')
      await submit_with_retry(
        () =>
          fight.join_many({
            fight: fight_id,
            character_ids: missing.map((c) => c.id),
            team,
            party: PARTY_ID ?? undefined,
            custody: { kiosk: cap.kioskId, kiosk_cap: cap.objectId },
          }),
        log
      )
      await sleep(1_500)
    }
  }

  state_json = await read_fight(sdk, fight_id)
  if (state_json.queue.length > 0) return
  const indices = fighter_indices(state_json)
  for (const c of CHARACTERS) {
    state_json = await read_fight(sdk, fight_id)
    if (state_json.queue.length > 0) break
    const idx = indices.get(c.id)
    if (idx === undefined || state_json.fighters[idx]!.ready) continue
    log(`${c.name} readying…`)
    await submit_with_retry(() => fight.ready({ fight: fight_id, fighter_idx: BigInt(idx) }), log)
    await sleep(1_500)
  }
}

// ── Phase 4: the turn loop — decide and commit one turn at a time until the fight ends. ─────

type Candidate = {
  kind: 'cast' | 'strike'
  spell?: string
  range_min: number
  range_max: number
  los: boolean
  ap_cost: number
  target_cell: bigint | null
  score: number
}

/** Decides and commits exactly one acting character's turn. Mirrors sim_decide.ts's scoring
 *  (not literally shared code yet, see the README) so a group the simulator screened as winnable
 *  is fought the same way it was evaluated — through DECISION_POLICY (cli_train.ts's evolutionary
 *  search result if one exists, else the untrained default), further weighted by success_rate
 *  (live-only: the simulator has no notion of "usually doesn't land" to learn from). */
const decide_and_commit_turn = async (
  bot: BotSdk,
  fight_id: string,
  state_json: FightJson,
  turn: number,
  acting_idx: number,
  acting: (typeof CHARACTERS)[number],
  acting_fighter: FighterJson,
  prep: PartyPrep,
  log: (msg: string) => void
): Promise<void> => {
  const { fight } = bot
  const my_team = acting_fighter.team
  const living_enemies = state_json.fighters
    .map((f, idx) => ({ ...f, idx }))
    .filter((f) => f.team !== my_team && as_number(f.hp) > 0)
  if (living_enemies.length === 0) {
    await submit_with_retry(() => fight.commit_turn({ fight: fight_id, actions: [] }), log)
    return
  }
  // Ranked by HP ascending (kill priority), NOT by distance — build_candidates() below tries
  // every enemy, not just the top-ranked one, so a far low-HP target no longer forces a wasted
  // approach-only turn when a different enemy is already in easy reach right now.
  const enemies_by_priority = [...living_enemies].sort((a, b) => as_number(a.hp) - as_number(b.hp))
  const enemy_cells = new Set(enemies_by_priority.map((f) => BigInt(as_number(f.cell))))

  const sim: SimState = {
    fighters: state_json.fighters.map((f) => ({
      cell: BigInt(as_number(f.cell)),
      dead: as_number(f.hp) <= 0,
      mp: BigInt(as_number(f.mp)),
    })),
    closed: state_json.closed.map((w) => BigInt(as_number(w))),
  }
  const obstacles = state_json.board.obstacles.map((o) => BigInt(as_number(o)))
  const my_cell = sim.fighters[acting_idx]!.cell

  // The most-wounded living ally (self included) below 80% hp — a real target for heals; null
  // if nobody needs one, so heal spells simply don't offer themselves this turn.
  const ally_fighters = state_json.fighters
    .map((f, idx) => ({ ...f, idx }))
    .filter((f) => f.team === my_team && as_number(f.hp) > 0 && f.kind['@variant'] === 'Player')
  const [wounded] = ally_fighters
    .map((f) => {
      const character_max_hp = prep.max_hp.get(f.kind.character!) ?? Infinity
      return { cell: BigInt(as_number(f.cell)), fraction: as_number(f.hp) / character_max_hp }
    })
    .sort((a, b) => a.fraction - b.fraction)
  const HEAL_THRESHOLD = 0.8
  const heal_target_cell = wounded && wounded.fraction < HEAL_THRESHOLD ? wounded.cell : null
  const heal_deficit = wounded && wounded.fraction < HEAL_THRESHOLD ? 1 - wounded.fraction : 0

  const known_spells = castable_spells(acting.classe, prep.levels.get(acting.id) ?? 1)
  const caster_stats = prep.sim_party_stats.get(acting.id)
  const caster_multiplier = (element: string | null): number =>
    caster_stats ? caster_damage_multiplier(element, caster_stats) : 1
  const priority_weight = (rank: number) => 1 / (rank + 1) ** DECISION_POLICY.priority_decay
  const finish_bonus = (enemy: (typeof enemies_by_priority)[number]): number => {
    const enemy_max_hp = enemy.stats ? as_number(enemy.stats.max_hp) : as_number(enemy.hp)
    return DECISION_POLICY.finish_weight * (1 - as_number(enemy.hp) / Math.max(1, enemy_max_hp))
  }
  const RESISTANCE_FIELD: Readonly<Record<string, keyof FighterStatsJson>> = {
    earth: 'earth_resistance',
    fire: 'fire_resistance',
    water: 'water_resistance',
    air: 'air_resistance',
  }
  const element_bonus = (enemy: (typeof enemies_by_priority)[number], element: string | null): number => {
    const field = element ? RESISTANCE_FIELD[element] : undefined
    const raw = field && enemy.stats ? as_number(enemy.stats[field] as string | number) : null
    return DECISION_POLICY.element_weight * element_advantage(raw)
  }
  const build_candidates = (): Candidate[] => {
    const list: Candidate[] = []
    for (const s of known_spells) {
      if (s.role === 'damage') {
        enemies_by_priority.forEach((enemy, rank) => {
          list.push({
            kind: 'cast',
            spell: s.name,
            range_min: s.range_min,
            range_max: s.range_max,
            los: s.line_of_sight,
            ap_cost: s.ap_cost,
            target_cell: BigInt(as_number(enemy.cell)),
            score:
              DECISION_POLICY.base_weight *
                s.score *
                caster_multiplier(s.element) *
                success_rate(acting.classe, s.name) *
                priority_weight(rank) +
              finish_bonus(enemy) +
              element_bonus(enemy, s.element),
          })
        })
        continue
      }
      if (s.role !== 'support') continue
      const target = s.is_heal ? heal_target_cell : my_cell
      if (target === null) continue
      list.push({
        kind: 'cast',
        spell: s.name,
        range_min: s.range_min,
        range_max: s.range_max,
        los: s.line_of_sight,
        ap_cost: s.ap_cost,
        target_cell: target,
        score:
          DECISION_POLICY.base_weight * s.score * success_rate(acting.classe, s.name) +
          (s.is_heal ? DECISION_POLICY.heal_weight * heal_deficit : 0),
      })
    }
    enemies_by_priority.forEach((enemy, rank) => {
      list.push({
        kind: 'strike',
        range_min: 1,
        range_max: 1,
        los: true,
        ap_cost: ASSUMED_STRIKE_AP_COST,
        target_cell: BigInt(as_number(enemy.cell)),
        score:
          (DECISION_POLICY.strike_bias + priority_weight(rank)) * success_rate(acting.classe, '__strike__') +
          finish_bonus(enemy) +
          element_bonus(enemy, 'earth'), // unarmed strikes are earth-elemental (weapon.ts's unarmed()); a modest fixed baseline, tried after named spells
      })
    })
    return list.sort((a, b) => b.score - a.score)
  }

  // Greedily fill this turn's AP with the best remaining candidate each step — real players
  // don't stop after one spell if they can afford another. At most one move total (MP is spent
  // once; every subsequent candidate is range-checked from the resulting cell).
  let remaining_ap = as_number(acting_fighter.ap)
  let cursor_cell = my_cell
  let moved_path: readonly bigint[] | null = null
  const chosen: { kind: 'cast' | 'strike'; spell?: string; target_cell: bigint }[] = []
  const used_spell_names = new Set<string>()

  // Built once regardless of USE_LOOKAHEAD: also doubles as the authoritative "would this action
  // end the fight?" oracle below (real engine semantics, not the lightweight local sim).
  let live_checkpoint: HydratedFightCheckpoint | null = null
  try {
    live_checkpoint = live_state_to_checkpoint(state_json, prep.sim_party_stats)
  } catch (error) {
    log(`live checkpoint unavailable this turn (${message_of(error)})`)
  }

  let lookahead_actions: readonly FightCommand[] | null = null
  if (USE_LOOKAHEAD && live_checkpoint) {
    try {
      const live_max_hp = live_max_hp_by_character(prep.sim_party_stats)
      lookahead_actions = decide_turn_with_lookahead(live_checkpoint, BigInt(acting_idx), live_max_hp, DECISION_POLICY)
    } catch (error) {
      log(`lookahead unavailable this turn, using the standard logic instead (${message_of(error)})`)
    }
  }

  if (lookahead_actions && lookahead_actions.length > 0) {
    for (const action of lookahead_actions) {
      if (action.type === 'move_to') moved_path = action.path
      else if (action.type === 'cast_spell')
        chosen.push({ kind: 'cast', spell: action.spell, target_cell: action.target_cell })
      else if (action.type === 'weapon_strike') chosen.push({ kind: 'strike', target_cell: action.target_cell })
    }
  } else {
    // A killing blow flips fight.ended mid-transaction (fight.move: the last-enemy-death check
    // runs after every damage action). Any bundled action AFTER it then aborts on assert_active
    // and reverts the WHOLE transaction — including the kill itself — which can loop forever.
    // So: at most one enemy-targeting action per turn, always last.
    let offensive_committed = false
    for (let step = 0; step < 6 && remaining_ap > 0 && !offensive_committed; step += 1) {
      const at_cursor: SimState = {
        ...sim,
        fighters: sim.fighters.map((f, i) => (i === acting_idx ? { ...f, cell: cursor_cell } : f)),
      }
      const picked = build_candidates().find((c) => {
        if (c.ap_cost > remaining_ap) return false
        if (c.spell && used_spell_names.has(c.spell)) return false
        if (c.target_cell === null) return false
        const cast_cell = find_cast_cell(
          at_cursor,
          acting_idx,
          c.target_cell,
          c.range_min,
          c.range_max,
          c.los,
          obstacles
        )
        if (cast_cell === null) return false
        if (cast_cell !== cursor_cell) {
          if (moved_path) return false // already spent this turn's one move
          const path = path_to(at_cursor, acting_idx, cast_cell)
          if (!path) return false
          moved_path = path
          cursor_cell = cast_cell
        }
        return true
      })
      if (!picked) break
      chosen.push({ kind: picked.kind, spell: picked.spell, target_cell: picked.target_cell! })
      remaining_ap -= picked.ap_cost
      if (picked.spell) used_spell_names.add(picked.spell)
      if (enemy_cells.has(picked.target_cell!)) offensive_committed = true
    }
  }

  await commit_turn_with_fallback(
    bot,
    fight_id,
    turn,
    acting,
    acting_idx,
    moved_path,
    chosen,
    live_checkpoint,
    sim,
    enemy_cells,
    my_cell,
    log
  )
}

type ChosenAction = { kind: 'cast' | 'strike'; spell?: string; target_cell: bigint }

/** Commits the decided actions, falling back to just the single best one alone if the bundled
 *  combo fails, then to a bare approach-only move, then to an empty pass — in that order, each
 *  only tried if the previous one didn't land. */
const commit_turn_with_fallback = async (
  bot: BotSdk,
  fight_id: string,
  turn: number,
  acting: (typeof CHARACTERS)[number],
  acting_idx: number,
  moved_path: readonly bigint[] | null,
  chosen: readonly ChosenAction[],
  live_checkpoint: HydratedFightCheckpoint | null,
  sim: SimState,
  enemy_cells: ReadonlySet<bigint>,
  my_cell: bigint,
  log: (msg: string) => void
): Promise<void> => {
  const { fight } = bot
  const to_actions = (rows: readonly ChosenAction[]) => [
    ...(moved_path ? [{ type: 'move' as const, path: moved_path }] : []),
    ...rows.map((c) =>
      c.kind === 'cast'
        ? { type: 'cast' as const, fighter_idx: BigInt(acting_idx), spell: c.spell!, target_cell: c.target_cell }
        : { type: 'strike' as const, fighter_idx: BigInt(acting_idx), target_cell: c.target_cell }
    ),
  ]
  const describe = (rows: readonly ChosenAction[]) =>
    rows.map((c) => (c.kind === 'cast' ? `cast ${c.spell}` : 'struck')).join(', ')

  // commit_turn always appends an end_fight_turn command unless told the fight already ended —
  // and end_fight_turn's Move implementation asserts the fight is STILL active before doing
  // anything else. A killing blow flips fight.ended mid-transaction, so that trailing command
  // then aborts on assert_active and reverts the WHOLE transaction, including the kill itself.
  // Simulate the exact actions on the real engine first so we know to skip it. to_actions()
  // produces the SDK's wire-format rows (fighter_idx, type: 'cast'/'strike'/'move') — translate
  // to the local engine's own FightCommand shape (fighter, type: 'cast_spell'/'weapon_strike'/'move_to').
  const as_engine_commands = (rows: ReturnType<typeof to_actions>): FightCommand[] =>
    rows.map((row) => {
      if (row.type === 'move') return { type: 'move_to', fighter: BigInt(acting_idx), path: row.path }
      if (row.type === 'cast')
        return { type: 'cast_spell', fighter: row.fighter_idx, spell: row.spell, target_cell: row.target_cell }
      return { type: 'weapon_strike', fighter: row.fighter_idx, target_cell: row.target_cell }
    })
  const would_end_fight = (rows: ReturnType<typeof to_actions>): boolean => {
    if (!live_checkpoint) return false
    try {
      const local_fight = create_fight({ state: live_checkpoint, mode: 'local', seed: 1n })
      let state = live_checkpoint
      for (const action of as_engine_commands(rows)) ({ state } = local_fight.apply(action))
      return state.contract.ended
    } catch {
      return false
    }
  }

  let acted = false
  if (chosen.length > 0) {
    const full_actions = to_actions(chosen)
    try {
      await submit_with_retry(
        () => fight.commit_turn({ fight: fight_id, actions: full_actions, ended: would_end_fight(full_actions) }),
        log
      )
      for (const c of chosen) record_attempt(acting.classe, c.spell ?? '__strike__', true)
      log(`turn ${turn}: ${acting.name}${moved_path ? ' moved and' : ''} ${describe(chosen)}`)
      acted = true
    } catch (error) {
      if (is_transient(error)) throw error
      // The combined turn failed — fall back to just the single best action alone rather than
      // blaming every spell we bundled with it.
      const [first] = chosen
      const first_actions = to_actions([first!])
      try {
        await submit_with_retry(
          () => fight.commit_turn({ fight: fight_id, actions: first_actions, ended: would_end_fight(first_actions) }),
          log
        )
        record_attempt(acting.classe, first!.spell ?? '__strike__', true)
        log(
          `turn ${turn}: ${acting.name}${moved_path ? ' moved and' : ''} ${describe([first!])} (combo didn't land, single action did)`
        )
        acted = true
      } catch (single_error) {
        if (is_transient(single_error)) throw single_error
        record_attempt(acting.classe, first!.spell ?? '__strike__', false)
      }
    }
  }

  if (!acted) {
    // Nothing was reachable this turn for any enemy — close distance on whichever one is
    // actually CLOSEST (fewest turns to get there), not the lowest-HP one, which may be on the
    // far side of the board and cost several extra approach-only turns to reach.
    const [closest_enemy_cell] = [...enemy_cells].sort((a, b) => Number(manhattan(my_cell, a) - manhattan(my_cell, b)))
    const approach = approach_path(sim, acting_idx, closest_enemy_cell!)
    if (approach && approach.length > 0) {
      try {
        await submit_with_retry(
          () => fight.commit_turn({ fight: fight_id, actions: [{ type: 'move', path: approach }] }),
          log
        )
        log(`turn ${turn}: ${acting.name} nothing in reach — approaching (${approach.length} cells)`)
        acted = true
      } catch (error) {
        if (is_transient(error)) throw error
      }
    }
  }
  if (!acted) {
    log(`turn ${turn}: ${acting.name} nothing lands and can't approach, passing`)
    await submit_with_retry(() => fight.commit_turn({ fight: fight_id, actions: [] }), log)
  }
}

const run_turn_loop = async (
  bot: BotSdk,
  fight_id: string,
  prep: PartyPrep,
  log: (msg: string) => void
): Promise<{ final_state: FightJson; turns: number }> => {
  const { sdk, fight } = bot
  let final_state: FightJson | null = null
  let turns = 0
  let last_stalemate_check_turn = 0
  let last_total_enemy_hp = Infinity
  let stalemate_detected = false

  for (let turn = 0; turn < 400; turn += 1) {
    const state_json = await read_fight(sdk, fight_id)
    if (state_json.ended) {
      final_state = state_json
      break
    }
    turns = turn + 1

    // Stalemate check: every STALEMATE_CHECK_INTERVAL turns, compare total enemy HP to the
    // previous checkpoint. If it hasn't dropped by the floor threshold, give up (pass turn).
    if (!stalemate_detected && turn > 0 && turn - last_stalemate_check_turn >= STALEMATE_CHECK_INTERVAL) {
      const living_enemy_total_hp = state_json.fighters
        .filter((f) => as_number(f.hp) > 0 && f.kind['@variant'] !== 'Player')
        .reduce((sum, f) => sum + as_number(f.hp), 0)
      const hp_progress =
        last_total_enemy_hp === Infinity
          ? 1
          : (last_total_enemy_hp - living_enemy_total_hp) / Math.max(1, last_total_enemy_hp)
      last_total_enemy_hp = living_enemy_total_hp
      last_stalemate_check_turn = turn
      if (hp_progress < STALEMATE_HP_FLOOR_FRACTION) {
        log(
          `stalemate detected at turn ${turn} — enemies regenerating faster than party damage (${(hp_progress * 100).toFixed(1)}% HP cleared in last ${STALEMATE_CHECK_INTERVAL} turns). Conceding to save gas.`
        )
        stalemate_detected = true
      }
    }

    const acting_idx = as_number(state_json.queue[as_number(state_json.turn_ptr)]!)
    const acting_fighter = state_json.fighters[acting_idx]!
    const acting_character = acting_fighter.kind['@variant'] === 'Player' ? acting_fighter.kind.character : undefined
    const acting = CHARACTERS.find((c) => c.id === acting_character)

    if (!acting || as_number(acting_fighter.hp) <= 0 || stalemate_detected) {
      await submit_with_retry(() => fight.commit_turn({ fight: fight_id, actions: [] }), log)
      await sleep(1_500)
      continue
    }

    const turn_started_ms = as_number(state_json.turn_started_ms)
    const wait = turn_started_ms + TURN_MIN_MS + TURN_WAIT_MARGIN_MS - Date.now()
    if (wait > 0) await sleep(wait)

    await decide_and_commit_turn(bot, fight_id, state_json, turn, acting_idx, acting, acting_fighter, prep, log)
    await sleep(1_500)
  }

  return { final_state: final_state ?? (await read_fight(sdk, fight_id)), turns }
}

// ── Phase 5: settle every character and report the outcome. ─────────────────────────────────

type RawDrop = { item_type?: string; qty?: number } | string
const drop_item_type = (d: RawDrop): string | undefined => (typeof d === 'string' ? d : d?.item_type)

// The set of item_types settle() might need to hand over for THIS fight, from every enemy mob's
// own loot table (already present on their live fighter snapshot — no seed-content lookup or
// extra read needed). Must be the full possible pool, not just what a pre-roll read of this
// character's OWN `drops` field currently shows: fight.move only actually ROLLS loot (mob
// tables -> a random split across winning seats) inside the FIRST successful settle call in the
// whole fight (`roll_and_split`, guarded by `drops_rolled`) — so whichever character settles
// first reads `drops` BEFORE anything has been rolled, sees it empty, and would authenticate
// zero templates. If that same roll then assigns THEM a non-empty share (their own settle is
// also where the roll executes, atomically), the chain has nowhere to deliver it: item.move's
// deliver_drops walks the caller's pre-authenticated plan for a matching template and, finding
// none, walks off the vector's end — `MoveAbort ... abort code: 131072`, Move's own
// EINDEX_OUT_OF_BOUNDS, not a game-defined code. That's a PERMANENT, deterministic abort for
// this exact fight — retrying changes nothing, since it re-derives the identical empty read
// every time (confirmed live 2026-09-02: every character, both a fresh attempt and the
// resumed retry, all four failing on the same fight, one attempt even burning real gas after
// clearing the free pre-flight simulation). Authenticating every possible template up front
// costs a little extra (harmless — `PM has drop`, an unclaimed template is just discarded, no
// abort, no dangling resource) and is the only way to be correct regardless of settle order.
const possible_loot_item_types = (state_json: FightJson): Set<string> => {
  const item_types = new Set<string>()
  for (const fighter of state_json.fighters) {
    if (fighter.kind['@variant'] === 'Player') continue
    for (const drop of fighter.kind.pos0?.loot ?? []) item_types.add(drop.item_type)
  }
  return item_types
}

// fight.settle() batches every fighter's settlement into ONE transaction (settlements: [{
// fighter_idx, loot }]) -- it does NOT take a single flat {fighter_idx, loot} (confirmed live
// 2026-09-05: the old one-call-per-character shape threw "undefined is not an object (evaluating
// 'settlements.length')" for every character, every time). All 4 characters share one personal
// kiosk (party_config.ts), so one kiosk_cap can authorize settling all of them together -- same
// batching win as join_many.
const settle_all = async (
  bot: BotSdk,
  fight_id: string,
  log: (msg: string) => void
): Promise<{ drops: Record<string, number> }> => {
  const { sdk, fight, kiosk_cap } = bot
  const drops: Record<string, number> = {}

  const state_json = await read_fight(sdk, fight_id).catch((error: unknown) => {
    log(`settle: couldn't re-read fight state (${message_of(error)}) — treating as already concluded`)
    return null
  })
  if (!state_json) return { drops }

  const indices = fighter_indices(state_json)
  const unsettled = CHARACTERS.filter((c) => {
    const idx = indices.get(c.id)
    return idx !== undefined && !state_json.fighters[idx]!.settled
  })
  if (unsettled.length === 0) return { drops }

  // Best-effort reporting only (each character's pre-roll snapshot, possibly empty/stale — see
  // possible_loot_item_types' header comment) — never what gets sent to settle() itself.
  for (const c of unsettled) {
    const idx = indices.get(c.id)!
    const raw_drops = ((state_json.fighters[idx] as unknown as { drops?: RawDrop[] })?.drops ?? []) as RawDrop[]
    for (const d of raw_drops) {
      const item_type = drop_item_type(d)
      const qty = typeof d === 'object' && typeof d.qty === 'number' ? d.qty : 1
      if (item_type) drops[item_type] = (drops[item_type] ?? 0) + qty
    }
  }

  log(`settling ${unsettled.map((c) => c.name).join(', ')} (one transaction)…`)
  const loot = [...possible_loot_item_types(state_json)].map((item_type) => ({ item_type, existing: null }))
  const settlements = unsettled.map((c) => ({ fighter_idx: BigInt(indices.get(c.id)!), loot }))
  const cap = await kiosk_cap()
  if (!cap) throw new Error('No personal kiosk found for this account')

  let all_settled = true
  try {
    await submit_with_retry(
      () =>
        fight.settle({
          fight: fight_id,
          settlements,
          custody: { kiosk: cap.kioskId, kiosk_cap: cap.objectId },
        }),
      log
    )
  } catch (error) {
    log(`settle threw, re-checking on-chain state: ${message_of(error)}`)
    const recheck = await read_fight(sdk, fight_id).catch((reread_error: unknown) => {
      log(`settle: re-read after failure also failed (${message_of(reread_error)}) — assuming NOT settled`)
      return null
    })
    const recheck_indices = recheck ? fighter_indices(recheck) : null
    const still_unsettled = unsettled.filter((c) => {
      const idx = recheck_indices?.get(c.id)
      return idx === undefined || !recheck!.fighters[idx]!.settled
    })
    if (still_unsettled.length > 0) {
      all_settled = false
      log(`  ${still_unsettled.map((c) => c.name).join(', ')} NOT settled — will need a retry run`)
    } else {
      log('  settled successfully despite the error')
    }
  }

  if (!all_settled)
    throw new Error(`some characters still need settling — fight_id ${fight_id} kept in group-state.local.json`)
  return { drops }
}

/** Runs exactly one group fight starting from `position`. Throws on unrecoverable errors (the
 *  caller — the session loop — is expected to log and continue rather than crash the process). */
export const run_one_group_fight = async (
  bot: BotSdk,
  position: Position,
  log: (msg: string) => void = console.log
): Promise<FightOutcome> => {
  const { sdk } = bot
  log(`combat policy: ${DECISION_POLICY_SOURCE}`)
  const zone_size = 512
  const zx = Math.floor(position.x / zone_size)
  const zz = Math.floor(position.z / zone_size)

  const { content_root, seed_package_original } = living_content(sdk, 'Group fight session')
  const game_original = sdk.game_type_package!
  const world_content = world_content_id(content_root, seed_package_original, WORLD)
  const world = derive_world_id(content_root, game_original, WORLD)
  await sdk.hydrate_unknown([world, world_content])

  const prep = await prepare_party(bot, log)

  const found = await find_or_create_fight(bot, position, zx, zz, world, world_content, prep, log)
  if (found.kind === 'retried') return found.outcome
  const { fight_id, mobs } = found

  // A vanished fight_id (join phase or turn loop, either can hit it) means the fight already
  // concluded and was closed by something other than this process — drop the dead fight_id so
  // the next attempt searches fresh instead of resuming a fight that no longer exists.
  let final_state: FightJson
  let turns: number
  try {
    await join_and_ready(bot, fight_id, log)
    ;({ final_state, turns } = await run_turn_loop(bot, fight_id, prep, log))
  } catch (error) {
    if (error instanceof FightNotFoundError) {
      write_group_state({})
      throw new Error(
        `${error.message} — it already concluded (won or lost) and was cleaned up elsewhere; local state cleared, will search fresh next run`,
        { cause: error }
      )
    }
    throw error
  }

  const won = final_state.winner === 0
  const new_position: Position = { x: final_state.x, z: final_state.z }

  // Record each character's hp-at-fight-end for the next run's HP-regen gate.
  {
    const now = Date.now()
    const hp_state: HpState = read_hp_state()
    const indices = fighter_indices(final_state)
    for (const c of CHARACTERS) {
      const idx = indices.get(c.id)
      const character_max_hp = prep.max_hp.get(c.id)
      if (idx === undefined || character_max_hp === undefined) continue
      hp_state[c.id] = { hp: as_number(final_state.fighters[idx]!.hp), at_ms: now, max_hp: character_max_hp }
    }
    write_hp_state(hp_state)
  }

  log(`fight ended (${won ? 'WON' : 'LOST'}) — settling all ${CHARACTERS.length} characters…`)
  const { drops } = await settle_all(bot, fight_id, log)
  write_group_state({})

  // Best-effort and non-fatal: the fight already succeeded by this point (won/lost, settled,
  // drops known), so an equip hiccup — even a transient one — should never turn a real result
  // into a thrown error the caller has to retry from scratch.
  try {
    await auto_equip_available_gear(bot, log)
  } catch (error) {
    log(`auto-equip skipped this fight (${message_of(error)})`)
  }

  const gas_mist = bot.fight.gas_spent(fight_id)
  const xp_gained: Record<string, number> = {}
  for (const c of CHARACTERS) {
    const live = await read_live_character_stats(sdk, c.id)
    xp_gained[c.name] = live.experience - (prep.xp_before.get(c.id) ?? 0)
  }

  return { won, fight_id, new_position, gas_mist, xp_gained, turns, mobs, drops }
}
