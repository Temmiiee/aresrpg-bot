// The one place the party roster lives — shared by the single-fight and session CLIs.
export const WORLD = 'nauvis'
// TODO(2026-09-05): null until the 4 characters below are grouped into a party in-game (this
// bot never drives party creation itself -- see party.ts's PartyActions, which needs a
// CharacterRow/PartyRow only the real game client's indexer-backed session can produce).
// null (not a stale id) is deliberate: fight_session.ts's join_many call only takes the
// grouped-join path when this is truthy, so leaving it null correctly falls back to joining
// each character individually instead of feeding a dead Party object into the transaction --
// the exact bug that produced an ArityMismatch abort once the old id was pointed at an object
// under the previous (redeployed-away) game package. Fill this in with the real Party object id
// once grandoulfe/perefouras/yoasobi/asobienne are grouped -- no other code change needed, the
// grouped-join path picks it up automatically.
export const PARTY_ID: string | null = null

// Replaced 2026-09-05: the testnet was fully redeployed (new game_type_package, not an upgrade
// -- see docs/ROADMAP.md), which orphaned every character ID from the previous deployment.
// These are the real, currently-owned characters under the CURRENT package (confirmed via a
// direct kiosk read -- the old IDs' objects still physically exist on chain but under an
// incompatible package type, which is exactly what produced the
// `dynamic_field::borrow_child_object_mut` abort on every real transaction).
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
