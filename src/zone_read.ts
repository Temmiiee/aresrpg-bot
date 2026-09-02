// Read-only zone content (mob groups / resource packs) computed by the immutable
// aresrpg_math::zone_math module. Those are `public fun` views, not stored objects, so the
// only way to read them off-chain is simulating a one-command PTB and reading the Move call's
// return value — the same `commandResults` mechanism the SDK's own gRPC transport exposes
// (classic devInspect is dead on this fullnode; JSON-RPC returns "Method not found").
import { bcs } from '@mysten/sui/bcs'
import { Transaction } from '@mysten/sui/transactions'
import type { SDK } from '@aresrpg/sdk'

type GameSdk = ReturnType<typeof SDK>

const MobMember = bcs.struct('MobMember', { mob_type: bcs.string(), level_scalar: bcs.u8() })
const MobGroup = bcs.struct('MobGroup', {
  index: bcs.u64(),
  x: bcs.u32(),
  z: bcs.u32(),
  members: bcs.vector(MobMember),
})
const ResourcePack = bcs.struct('ResourcePack', {
  index: bcs.u64(),
  x: bcs.u32(),
  z: bcs.u32(),
  item_type: bcs.string(),
  nodes: bcs.u8(),
})

export type MobGroupView = {
  index: bigint
  x: number
  z: number
  members: { mob_type: string; level_scalar: number }[]
}
export type ResourcePackView = { index: bigint; x: number; z: number; item_type: string; nodes: number }

/** One bare (no math-init prelude) simulated Move call, decoded from its first return value. */
const simulate_view_call = async (
  sdk: GameSdk,
  target: string,
  push_args: (tx: Transaction) => unknown[]
): Promise<Uint8Array> => {
  const tx = new Transaction()
  tx.moveCall({ target, arguments: push_args(tx) as never })
  const result = await sdk.simulate(tx, { include: { commandResults: true, effects: true } })
  if (result.$kind === 'FailedTransaction')
    throw new Error(`view call ${target} failed: ${JSON.stringify(result.FailedTransaction?.effects?.status)}`)
  const bytes = result.commandResults?.[0]?.returnValues?.[0]?.bcs
  if (!bytes) throw new Error(`view call ${target} returned nothing`)
  return bytes
}

// Move-call TARGETS use the LATEST package id (type identity uses the original — see
// client.ts's "Package type identity uses original package IDs; Move-call targets use latest
// package IDs").
const game_package = (sdk: GameSdk): string => {
  const pkg = sdk.pins.package
  if (typeof pkg !== 'string' || !pkg) throw new Error('zone_read: pins.json has no game package for this network')
  return pkg
}

/** Every roaming mob group currently live in a searched zone (zone::search must already have
 *  run for (zx, zz), or this aborts ENotSearched). */
export const read_mob_groups = async (
  sdk: GameSdk,
  world_id: string,
  world_content_id: string,
  zx: number,
  zz: number
): Promise<MobGroupView[]> => {
  const bytes = await simulate_view_call(sdk, `${game_package(sdk)}::zone::mob_groups`, (tx) => [
    tx.object(world_id),
    tx.object(world_content_id),
    tx.pure.u32(zx),
    tx.pure.u32(zz),
  ])
  return bcs.vector(MobGroup).parse(bytes) as MobGroupView[]
}

/** One resource pack by index (aborts ENothingThere past the last live pack — probe index 0..
 *  until it throws to enumerate every pack in the zone). */
export const read_resource_pack = async (
  sdk: GameSdk,
  world_id: string,
  world_content_id: string,
  zx: number,
  zz: number,
  index: number
): Promise<ResourcePackView> => {
  const bytes = await simulate_view_call(sdk, `${game_package(sdk)}::zone::resource_pack_at`, (tx) => [
    tx.object(world_id),
    tx.object(world_content_id),
    tx.pure.u32(zx),
    tx.pure.u32(zz),
    tx.pure.u64(index),
  ])
  return ResourcePack.parse(bytes) as ResourcePackView
}
