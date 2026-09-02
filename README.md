# @aresrpg/bot

A headless automation bot for a real AresRPG player's party — built directly on the game's own
`@aresrpg/sdk` (not the web client, not browser automation), signing in via the same zkLogin
flow the real app uses. No private key ever leaves your machine; there's nothing to export.

Lives inside the vendored `aresrpg` monorepo clone (`vendor/aresrpg-src/packages/bot`) as a Bun
workspace package, because `@aresrpg/sdk` and `@aresrpg/fight` are private, unpublished
packages pinned to exact dependency versions — this is the only way to use them without a
version-mismatch risk.

## Setup

```sh
bun install   # from the repo root, vendor/aresrpg-src
cd packages/bot
```

Edit `src/party_config.ts` with your own party: the 4 (or fewer) character object ids, their
classes, which one leads, the Party object id (see the README section below for how to find
one you don't have handy), and the world name. The committed values are one real party used to
build and test this bot — replace them with yours.

```sh
bun run enoki-login   # one-time interactive Google sign-in; cached after (.enoki-session.json)
```

The very first run prints a Google login URL — open it in a browser and sign in with the same
account you use for aresrpg.world. After that, every other command reuses the cached session
headlessly until it naturally expires.

## Usage

```sh
bun run group-fight    # one full fight: search, engage, join, ready, fight, settle
bun run session [n]    # loop fights back-to-back (omit n to run indefinitely) — see below
bun run session-stats  # terminal summary of session.jsonl
bun run dashboard      # live web view of the same data — http://localhost:5180
bun run faucet-check   # one-shot: claim testnet SUI if the wallet balance is low
bun run auto-sell      # one-shot: plan (and optionally --live execute) HDV listings — see below
```

Position **chains automatically** between fights — the very first fight needs a starting
position (`INITIAL_CHAIN_X`/`INITIAL_CHAIN_Z` in `party_config.ts`, in the chain's coordinate
grid, not the 3D voxel coordinates the game UI shows — see `chain_to_client_coordinate` /
`client_to_chain_coordinate` in `packages/immutable/src/world.ts` for the conversion). Every
fight after that uses the position the last one actually happened at (`position.local.json`).

## How it decides what to do

- **Difficulty check** — skips any mob group whose average level is more than
  `MAX_LEVEL_MARGIN` above the party's own average level, rather than picking a fight it can't
  win. Scans every group in the searched zone and picks the nearest one that qualifies.
- **HP-regen gate** — waits for the slowest-healing character to reach `MIN_HP_FRACTION` (80%)
  of estimated max HP before starting another fight, projected from HP-at-last-fight-end plus
  the game's flat 1 HP/second regen rate (there's no on-chain read for "current regenerated
  HP" outside combat, so `hp-state.local.json` tracks the bot's own best estimate across runs).
- **Real movement** — `src/fight_geometry.ts` reuses `packages/fight`'s own deterministic TS
  twin of the Move combat grid (`fight_path_to`, `bfs_cast_cell`, `approach_field`) to find the
  nearest reachable cell in range + line-of-sight for a given attack, so the bot's movement
  decisions can't diverge from what the chain will actually accept.
- **Damage-per-AP spell ranking** — `src/spell_catalog.ts` scores each known spell by its
  authored direct-damage effect divided by its AP cost (not raw damage — a spell that's
  cheaper AND nearly as strong should usually win over one big expensive cast), classifying
  spells as `damage`, `support` (a buff/heal aimed at an ally or self), or `other`
  (traps/displacement/utility, which the current logic doesn't use well and skips).
- **Multi-action turns** — a character spends its *whole* AP budget each turn where it can:
  the turn loop greedily picks the best remaining affordable, reachable action (repeatedly)
  instead of stopping after one spell, composing them into a single `[move, cast, cast, …]`
  transaction. This is the main lever against turn count and gas cost — one big turn beats many
  small ones.
- **Ally support** — heal spells target the most-wounded living ally (self included) below
  80% HP; non-heal buffs target self. Both are ranked alongside damage spells by the same
  score-per-AP metric, so they get used when they're actually the best available action, not
  forced in every turn regardless of need.
- **Learned spell effectiveness** — `src/spell_memory.ts` tracks, per class and spell name,
  how often a cast actually lands once tried (persisted in `spell-memory.local.json`), and
  multiplies each candidate's score by that success rate. A spell that keeps failing for this
  party's usual positioning gets tried less over time; nothing is hardcoded — it's inferred
  from real attempts.
- **Focus fire** — every turn's target is whichever living enemy currently has the lowest HP.
  No shared coordination needed: since every character's turn re-reads the same live state,
  the whole party naturally converges on one target without any extra bookkeeping.

All of the above lives in exactly one place, `src/fight_session.ts` — both `group-fight` (one
fight) and `session` (looping) call it, so there's a single source of truth for the combat logic.

## Running unattended

`cli_group_session.ts` runs fights in a loop, appending each result to `session.jsonl`, and
retries rather than crashing on errors (a transient network hiccup waits 30s; "no suitable mob
group in this zone" waits 10 minutes, since zones only reroll every 2h). Ctrl+C to stop — an
in-progress fight (if any) resumes cleanly on the next run via `group-state.local.json`.

**Gas-cost check**: the dev's own guidance is ~0.02 SUI **per character**, not per fight — a
group fight charges every owned participant's turns, so this committed 4-character party's
normal fight totals ~0.08 SUI. `GAS_WARN_MIST` (`src/session_stats.ts`) flags at 5x that
per-party baseline (scaled by `party_config.ts`'s actual roster size, so it stays correct if you
run a different party size) rather than a flat number. Both `group-fight` and `session` print a
warning with the fight id and wallet address whenever a fight crosses that threshold;
`session-stats` and the dashboard also list every flagged fight from the log.

To actually run this in the background: start it in its own terminal window/tab and leave it,
or use your OS's usual tools (a background terminal tab, `start /min`, a scheduled task,
tmux/screen, etc.) — nothing here needs a Claude session to stay open.

### Dashboard

`bun run dashboard` starts a tiny local web server (port 5180) serving a single
self-contained page — open `http://localhost:5180`. It polls every 2s and shows: whether the
session looks alive (a status update within the last 60s counts as "running" — a local-file
freshness check, not real process supervision), the live status line, session-wide stats
(fights/win rate/gas/XP), the mob types **and levels** fought, a banner for any 0.1+ SUI
fights, and a table of recent fights. It reads only local files — no wallet, no chain calls, no
cost to leave open, and it works even before a session has ever run.

## Files

- `src/party_config.ts` — the party roster (characters, party id, world, starting position) —
  the one file to edit for a different party
- `src/enoki_auth.ts`, `src/enoki_store.ts` — headless zkLogin sign-in (a Signer, not a raw key)
- `src/sdk_client.ts` — wires `@aresrpg/sdk` + its `character`/`fight` action builders to that
  signer (the kiosk cap is re-fetched fresh on every call — a cached ref goes stale after the
  very next transaction)
- `src/fight_session.ts` — the shared group-fight engine (search, difficulty check, HP gate,
  engage, join, ready, turn loop, settle) that both CLIs below call
- `src/fight_geometry.ts` — movement/targeting geometry via `packages/fight`'s deterministic
  Move twin
- `src/spell_catalog.ts` — damage-per-AP-ranked castable spells per class/level, read straight
  from `seed/content/spells.json`
- `src/spell_memory.ts` — learned per-spell success rate across fights
- `src/hp_state.ts` — HP-at-fight-end tracking for the pre-fight regen gate
- `src/zone_read.ts` — read-only zone content (mob groups) via a simulated Move view call —
  devInspect is dead on public testnet fullnodes, so this uses `sdk.simulate(...,
  { include: { commandResults: true } })` instead
- `src/group_state.ts`, `src/position_state.ts`, `src/status_state.ts`, `src/session_log.ts`,
  `src/session_stats.ts` — local state: in-progress-fight resume, last known position, the
  dashboard's live status line, the append-only fight log, and shared stats computation
- `src/cli_enoki_login.ts` — read-only: signs in and lists your characters, to confirm the bot
  is looking at the right account before it's ever allowed to touch it
- `src/cli_group_fight_loop.ts`, `src/cli_group_session.ts`, `src/cli_session_stats.ts`,
  `src/cli_dashboard.ts` — the runnable entry points

## Auto-equip

After every fight settles, `src/auto_equip.ts` tries to fill every EMPTY equipment slot on every
character from the account's spare (unlisted, unequipped) kiosk inventory — highest item level
first per slot, since gear power scales with level here. It does **not** try to upgrade a slot
that's already occupied: reading what's currently equipped means decoding a nested on-chain
dynamic field (`EquippedRecord` — item stats, damages) with no real captured payload to build
and verify that decoder against, which is exactly the failure shape code-law's L-D4 exists to
prevent. Filling empty slots needs none of that — every character starts with nothing worn, so
this is real, safe value without it. One `equip` call per candidate slot (not one batched call
per character): a batch is all-or-nothing, and without reading current gear there's no way to
know in advance which slots are already taken, so batching would let one occupied slot cost
every other, genuinely empty slot its equip too. An occupied slot, a level requirement, or a
duplicate relic template are the expected, zero-gas outcome of trying — logged only if something
else went wrong. Runs automatically; nothing to opt into.

## Testnet SUI: automatic top-up

`session` checks the wallet's live balance before every fight (`sdk.read_sui_balance()`) and,
whenever it drops below `DEFAULT_MIN_BALANCE_MIST` (`src/faucet.ts` — ~15 fights of headroom at
this party's actual size, ~1.2 SUI for the committed 4-character roster), claims from the
same official testnet faucet endpoint the frontend's own "Add funds" modal points players at
(`requestSuiFromFaucetV2` against `getFaucetHost('testnet')` — an unauthenticated, rate-limited
developer API Mysten Labs runs for this purpose, not the captcha'd browser page at
faucet.sui.io). A claim attempt (success or failure, including a rate-limit backoff) is logged
inline with the fight output; the session keeps running either way — a failed claim just means
the next fight may error out on gas, which the existing retry loop already handles.

Recipient is always the bot's own live signed-in address (`bot.address`, derived from the
zkLogin signer) — never a hardcoded one — so it always tops up the wallet actually paying gas.
Run `bun run faucet-check` standalone any time to check/claim without starting a session.

## HDV auto-selling (testnet now, mainnet-ready)

`bun run auto-sell` prices and lists the bot's spare kiosk inventory on the marketplace — built
and testable on testnet today, and works unchanged on mainnet once that exists (only
`sdk_client.ts`'s network/RPC config would need to point there, same as everything else).

- **Reading inventory** (`src/kiosk_inventory.ts`) goes straight to the chain — the bot's own
  kiosk contents via `@mysten/kiosk`'s `getKiosk`, no dependency on the game server's
  authenticated websocket protocol (`packet/market_observe` and friends), which this headless
  bot never connects to. Equipped items are structurally absent from the result: equipping SENDS
  the item out of the kiosk to the character's own address (`equipment.move`'s own module doc) —
  so anything unlisted here is, by construction, spare inventory, never gear a character has on.
- **Pricing** (`src/market_pricing.ts`) is pure sequential price discovery, not a live
  order-book read — there is no public way for a headless bot to see OTHER sellers' listings
  (that's the same websocket-only market feed above). A first-ever listing for an item type
  undercuts the estimated fair value by 15% (the point the dev flagged: an early/thin market has
  no visible comparable price, so pricing to actually get seen matters more than maximizing the
  first sale); a later listing rises 10% after a fast sale (<6h) or cuts 12% after one that sat
  unsold, floored at 40% of the base estimate either way.
- **The base fair-value estimate** is `item_valuation.ts`'s `get_item_price` — a custom override
  from `item_prices.json` when one exists (currently only the 7 raw materials), else a
  level-scaled flat fallback. That fallback is an uncalibrated placeholder for every equipment
  item_type today; treat early auto-sell prices as rough until real sales (or manually researched
  comparables) get written into `item_prices.json`.
- **Outcomes** (`src/market_history.ts`, `market_history.local.json`) are inferred from kiosk
  state, not a sale event feed: a listed item disappearing from the kiosk means sold (the only
  way custody leaves, since nothing here delists automatically); present-but-unlisted means
  someone delisted it by hand. `reconcile_market_history` (run automatically at the start of
  every `auto-sell` invocation) resolves every open record this way before planning the next
  pass, which is how the adaptive pricing above gets its signal.

`auto-sell` defaults to a dry run: reconcile, plan, print what it *would* list and at what
price — nothing is signed. Pass `--live` to actually submit the listings. It's a one-shot command
by design, not wired into `session`'s loop — selling is a deliberate, reviewed action, run by
hand or from your own scheduler, not something a fight loop should trigger unattended.

## Standalone build

`bun run build-standalone [output-dir]` (default: `../../standalone-bot`, a sibling of this
checkout) assembles a minimal, self-contained copy of the bot: its own source plus the exact
dependency closure of the private, unpublished workspace packages it imports (`@aresrpg/sdk`,
`@aresrpg/fight`, `@aresrpg/immutable`, `@aresrpg/protocol`) — none of the game's
frontend/engine/indexer/move/3D-and-audio assets. `cd` in, `bun install`, and it runs the same
commands as above.

This is a **snapshot, regenerated from this checkout, not a permanent fork** — those packages
are pinned to an exact game version specifically so the bot never silently drifts from the live
game (the whole reason it lives inside this checkout at all). Re-run the script after every
`git pull` here rather than hand-editing a standalone copy.

## CI

`.github/workflows/verify.yml` assembles the exact same tree `bun run build-standalone` builds
locally — this repo plus a fresh clone of the game's private `@aresrpg/sdk`, `@aresrpg/fight`,
`@aresrpg/immutable`, `@aresrpg/protocol` — and typechecks it. Runs on every push/PR, **and on a
weekly schedule independent of any push here**, so a game update that moves one of those
packages out from under the bot gets caught even when nobody touched this repo that week — the
one signal the scheduled game-changelog review can't give, since that routine has no access to
this source to compare against. Typechecks fully clean — a few spots that used to lean on the
shared SDK's own narrower structural types (or on a plain cast papering over a real mismatch,
like `zone_read.ts`'s mob-group `index` once being declared `bigint` when `bcs.u64()` actually
parses to a decimal string) are widened or corrected locally, without touching that shared package.

## Known gap: resource gathering

`gathering::gather` requires a job tool equipped (`tool_farmer` / `tool_herbalist` /
`tool_miner`). As of this beta's seed content (`seed/content/`), there is no shop sale, no
craftable recipe, and no mob loot drop for any starter tool (e.g. `basic_pickaxe`) — so a fresh
character currently has no way to begin gathering at all. This looks like missing beta content
rather than a bug; worth flagging to the team. `src/zone_read.ts` already supports reading live
resource packs (`read_resource_pack`) for whenever that's seeded.

Re-checked 2026-09-03 after the parties/dungeons update: `items.json` now defines starter tools
(`basic_pickaxe`, `old_hoe`, `tool_herbalist`) that didn't exist before, but `shop.json`,
`recipes.json`, and `mobs.json` still carry zero references to any `tool_*` item — the
acquisition gap is unchanged. Nothing to automate here yet.

## On building a stronger combat AI

`packages/fight` runs entirely offline, with no chain calls needed — that's what makes a real
self-play RL agent *possible* for this game without spending gas to train it (unlike most
"let's RL a blockchain game" ideas). But matching something like OpenAI Five's Dota bots took
massively more compute and months of dedicated engineering than fits here. The learned
spell-effectiveness tracking above is a small, real step in that direction; a genuinely
stronger agent (shallow lookahead, or a small locally-trained self-play model) is a real,
multi-day undertaking beyond it.
