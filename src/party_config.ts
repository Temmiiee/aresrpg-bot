// The one place the party roster lives — shared by the single-fight and session CLIs.
export const WORLD = 'nauvis'
// TODO(2026-09-05): also stale from the same redeploy that orphaned CHARACTERS below (see that
// comment) -- this is the OLD party's id, from before the reset. fight_session.ts's join_many
// call (the only real usage, see party.ts's PartyActions for how a Party is created/joined)
// will fail until this points at a real Party object containing the 4 new characters below.
// Group grandoulfe/perefouras/yoasobi/asobienne into a party in-game (or via the SDK's
// party_actions invite/accept flow) and put that Party object's id here.
export const PARTY_ID = '0xa02fd2bf0eb3813b9b4ed4c0177cec666d06689d7dd286ea7bfb270bca4c5e8c' // STALE — see TODO above

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
