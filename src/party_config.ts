// The one place the party roster lives — shared by the single-fight and session CLIs.
export const WORLD = 'nauvis'
export const PARTY_ID = '0xa02fd2bf0eb3813b9b4ed4c0177cec666d06689d7dd286ea7bfb270bca4c5e8c'

export const CHARACTERS = [
  {
    name: 'temmiie',
    id: '0x033c17f5da068f2f20bd428dd53382212b01f78583d1a944a48b70b951f267c1',
    classe: 'senshi',
    leader: true,
  },
  {
    name: 'norman',
    id: '0xce9fa15af7de9c003ed6601d296022262923dffc053991fa7bf4ce7acb472643',
    classe: 'yajin',
    leader: false,
  },
  {
    name: 'sasha',
    id: '0x5ba547ea6b943fb06bc399bbe3360ee01ec2dbe7ecf48bea023306a70d022964',
    classe: 'tomoda',
    leader: false,
  },
  {
    name: 'perefouras',
    id: '0x462a4f877cd4a29521fbfb0f9d5a1f72d17e70853951794dcaf8a3f40dfb895f',
    classe: 'mori',
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
