// Splits newly-available stat points between vitality (survivability) and the class's primary
// damage stat, instead of dumping everything into vitality. fight.move's damage formula is
// `base × (100 + primary) / 100 + raw_damage` (aresrpg_math::fight_math::amplify_damage) where
// `primary` is looked up by the spell's element — earth→strength, fire→intelligence,
// water→chance, air→agility (fight_math::primary_stat). A character who has never spent a
// point there deals exactly base-roll damage forever, a flat 0% bonus, however high their level
// climbs — which is a real, compounding cause of long/lost fights, not just low HP.
import { characteristic_cost_step, type CharacteristicName, type ClassName } from '@aresrpg/immutable'

// The element with the highest total damage-weighted magnitude across each class's spell kit
// (computed from seed/content/spells.json — see the bot README for the raw numbers). All three
// earth-leaning classes share strength; tomoda leans fire and wants intelligence instead.
export const PRIMARY_STAT_BY_CLASS: Readonly<Record<string, CharacteristicName>> = {
  senshi: 'strength',
  yajin: 'strength',
  tomoda: 'intelligence',
  mori: 'strength',
}

// cli_tune.ts's search (2026-08-31, 2 matchups x 16 grid cells) put the RAW best score at
// share=1.0 (all-offense, zero new vitality) — but that's a corner value from a small matchup
// sample, and losing ALL new HP margin on the strength of two test fights felt like overfitting.
// 0.7 scored within noise of 1.0 (129.53 vs 130.49) and, notably, scored IDENTICALLY across
// every priority_decay value tested — a share the search wasn't sensitive to is a safer bet than
// the single best cell. Re-run cli_tune.ts against a wider matchup set before pushing toward 1.0.
export const DEFAULT_PRIMARY_STAT_SHARE = 0.7

export type StatSpending = Readonly<Partial<Record<CharacteristicName, number>>>

/** How many `available_points` to put into vitality vs. the class's primary damage stat. The
 *  primary stat's cost ladder can have thresholds past low values (unlike vitality, which is
 *  always a flat 1 point : 1 gain forever) — this walks the ladder step by step from the
 *  character's CURRENT value so the spend is always exactly payable, and any remainder that
 *  can't buy a whole step there falls back to vitality, which always can. */
export const split_stat_spending = (
  classe: string,
  available_points: number,
  current_primary_value: number,
  primary_share: number = DEFAULT_PRIMARY_STAT_SHARE
): StatSpending => {
  if (available_points <= 0) return {}
  const primary = PRIMARY_STAT_BY_CLASS[classe]
  if (!primary) return { vitality: available_points }

  const primary_budget = Math.floor(available_points * primary_share)
  let spent = 0
  let value = current_primary_value
  while (spent < primary_budget) {
    const step = characteristic_cost_step(classe as ClassName, primary, value)
    if (spent + step.cost > primary_budget) break
    spent += step.cost
    value += step.gain
  }

  const vitality_points = available_points - spent
  const spending: Record<string, number> = {}
  if (spent > 0) spending[primary] = spent
  if (vitality_points > 0) spending.vitality = vitality_points
  return spending
}
