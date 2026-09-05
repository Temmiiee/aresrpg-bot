// The one place the party roster lives — shared by the single-fight and session CLIs.
export const WORLD = 'nauvis'
// Filled in 2026-09-05: the real Party object, grouped in-game and confirmed via a direct chain
// read (type `::party::Party`, `members` contains exactly these 4 character ids). Finding this
// couldn't be done from bot code alone (party.move's on-chain state only records a boolean
// "already in some party" per character, not which one -- no queryable character->party
// mapping, no creation event either) -- found by hand via a block explorer, tracing the
// transaction that accepted asobienne's invitation.
export const PARTY_ID: string | null = '0x844a2f8605ce805c8c3ddd73168b62cf69252386666b4986907f193b993b6a64'

// Replaced 2026-09-05: the testnet was fully redeployed (new game_type_package, not an upgrade
// -- see docs/ROADMAP.md), which orphaned every character ID from the previous deployment.
// These are the real, currently-owned characters under the CURRENT package (confirmed via a
// direct kiosk read -- the old IDs' objects still physically exist on chain but under an
// incompatible package type, which is exactly what produced the
// `dynamic_field::borrow_child_object_mut` abort on every real transaction).
// `leader` here is this BOT's own internal convention (whichever character search_zone/engage
// act as, and whoever join_and_ready expects to already be seated to anchor team assignment) --
// it does NOT need to match the real Party's on-chain leader (members[0], confirmed asobienne)
// for fights to work; nothing in fight.move gates search/engage on being the party leader.
// Deliberately NOT switched to asobienne (2026-09-05): grandoulfe is the one actually seated in
// the fight currently in progress (created before the real Party was found), and
// join_and_ready throws "Leader is not seated in this fight" unless CHARACTERS' leader matches
// whoever is actually anchoring that fight -- changing this now would break resuming it.
export const CHARACTERS = [
  {
    name: 'grandoulfe',
    id: '0x2770b7442bb6ca564ad0d9de64c2a558280909ce74d6327f1b09eb9f35b626a4',
    classe: 'mori',
    leader: true,
  },
  {
    name: 'perefouras',
    id: '0x3a81f3673b049cb79608fea891127ff089dbdfb60e2c04479c91bbb176369dc6',
    classe: 'mori',
    leader: false,
  },
  {
    name: 'yoasobi',
    id: '0x3330e3bac447a344adeb7b82cdd105b3ee6e33c11feef79da6fcfcb6ad8609fe',
    classe: 'asobi',
    leader: false,
  },
  {
    name: 'asobienne',
    id: '0x11871cbf71fd5aec58f2e150dc4e1bed2c579b4b0265209982db82fd59b8ea14',
    classe: 'asobi',
    leader: false,
  },
] as const
export const LEADER = CHARACTERS.find((c) => c.leader)!

// Told to us directly (2026-08-31) — client/voxel coordinates, converted to the chain's grid
// with client_to_chain_coordinate (= value + world_center, world_center = world_size/2 = 50000).
// Only used as the SEED position for the very first fight of a session; every fight after that
// carries its own position forward automatically (the Fight object's own x/z).
export const INITIAL_CHAIN_X = 48612
export const INITIAL_CHAIN_Z = 49736
