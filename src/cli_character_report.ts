// bun run src/cli_character_report.ts — read-only. Prints each character's current level/stats
// and their full castable spell kit (what unlocks at their CURRENT level, with damage/AP
// scoring), so "what do my characters actually have to work with" is one command instead of
// a chain explorer + spells.json cross-reference by hand.
import { get_enoki_signer } from './enoki_auth.ts'
import { create_bot_sdk } from './sdk_client.ts'
import { CHARACTERS } from './party_config.ts'
import { castable_spells } from './spell_catalog.ts'
import { PRIMARY_STAT_BY_CLASS } from './stat_allocation.ts'

const signer = await get_enoki_signer()
const { sdk } = create_bot_sdk(signer)

for (const c of CHARACTERS) {
  const { objects } = await sdk.sui_client.core.getObjects({ objectIds: [c.id], include: { json: true } })
  const json = objects[0]?.json as Record<string, unknown> | undefined
  const level = Number(json?.level ?? 1)
  const primary_stat = PRIMARY_STAT_BY_CLASS[c.classe]

  console.log(`\n${'='.repeat(60)}`)
  console.log(`${c.name}  (${c.classe}, level ${level})${c.leader ? '  [leader]' : ''}`)
  console.log(
    `  xp: ${json?.experience ?? '?'}   available stat points: ${json?.available_points ?? 0}   available spell points: ${json?.available_spell_points ?? 0}`
  )
  console.log(
    `  vitality: ${json?.vitality ?? 0}   strength: ${json?.strength ?? 0}   intelligence: ${json?.intelligence ?? 0}   chance: ${json?.chance ?? 0}   agility: ${json?.agility ?? 0}   wisdom: ${json?.wisdom ?? 0}`
  )
  console.log(
    `  primary damage stat for this class: ${primary_stat ?? '(unknown class — falls back to vitality-only)'}`
  )

  const spells = castable_spells(c.classe, level)
  if (spells.length === 0) {
    console.log('  no spells unlocked yet at this level')
    continue
  }
  console.log(`  spells (${spells.length}):`)
  for (const s of [...spells].sort((a, b) => b.score - a.score)) {
    const range = s.range_min === s.range_max ? `${s.range_min}` : `${s.range_min}-${s.range_max}`
    console.log(
      `    ${s.name.padEnd(20)} role=${s.role.padEnd(7)} ap=${s.ap_cost}  range=${range}${s.line_of_sight ? '' : ' (no LoS needed)'}  score=${s.score.toFixed(2)}${s.is_heal ? '  [heal]' : ''}`
    )
  }
}
console.log(`\n${'='.repeat(60)}`)
