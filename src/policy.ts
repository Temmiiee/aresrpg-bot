// A "policy" is a weight vector over tactical features — how much a candidate action's score
// should care about raw damage-per-AP, kill priority, how close the target already is to dying,
// how badly a heal is needed, etc. cli_train.ts SEARCHES this vector (evolutionary selection
// against simulated fights) instead of it being hand-picked, which is the actual "learns by
// itself" part: nobody wrote down the tradeoff numbers, the simulator's win-rate did.
//
// What's still hand-built, deliberately: WHICH cells are reachable this turn (find_cast_cell,
// the exact BFS/LOS the chain itself uses) and the turn-structure rules (one move, one offensive
// action, capped last). Those aren't tactical judgment calls to learn — they're the actual rules
// of the game, and getting them from the engine instead of a policy guarantees every action a
// trained policy picks is legal. The policy only decides WHICH legal action is best.
export type Policy = {
  /** Multiplies each spell/strike's own damage-or-support-per-AP score (spell_catalog.ts). */
  base_weight: number
  /** Kill-priority falloff by HP rank among living enemies: weight = 1/(rank+1)^priority_decay. */
  priority_decay: number
  /** Rewards attacking a target that's already low — independent of its rank against OTHER
   *  enemies, this is "how close is THIS one to dying" (1 - hp_fraction), for kill-securing. */
  finish_weight: number
  /** Rewards a strike/cast that finishes far-below-1.0-HP-fraction allies via a heal spell,
   *  scaled by how deep the deficit is (1 - hp_fraction, 0 if not a heal or nobody's hurt). */
  heal_weight: number
  /** A flat bonus/malus applied to the weapon strike baseline specifically, separate from named
   *  spells — lets the search decide whether the "always available, no cooldown" fallback should
   *  be favored or avoided relative to spending AP on named spells. */
  strike_bias: number
  /** Rewards casting a spell whose element exploits the target's actual resistance/weakness
   *  (fight_math::apply_centered_resistance — the target's raw resistance value minus the 32768
   *  center IS the resistance percentage, capped at 50; below center is a weakness that
   *  AMPLIFIES damage by the deficit). Scaled to roughly ±1 per ±50 percentage points, so this
   *  weight is directly comparable in magnitude to the others. 0 = ignore element matchups
   *  entirely, which is what every version of this bot did before this weight existed. */
  element_weight: number
}

export const DEFAULT_POLICY: Policy = {
  base_weight: 1,
  priority_decay: 0.5, // cli_tune.ts's earlier 2-knob search (2026-08-31)
  finish_weight: 0,
  heal_weight: 0,
  strike_bias: 0,
  element_weight: 0,
}

export const POLICY_KEYS = Object.keys(DEFAULT_POLICY) as readonly (keyof Policy)[]

export const clamp_policy = (policy: Policy): Policy => ({
  base_weight: Math.max(0, policy.base_weight),
  priority_decay: Math.max(0, Math.min(3, policy.priority_decay)),
  finish_weight: Math.max(0, policy.finish_weight),
  heal_weight: Math.max(0, policy.heal_weight),
  strike_bias: policy.strike_bias,
  element_weight: Math.max(0, policy.element_weight),
})

// (raw_resistance - ITEM_STAT_CENTER) IS the resistance percentage (capped at 50 in practice,
// negative = weakness that amplifies damage) — aresrpg_math::fight_math::apply_centered_resistance.
const ITEM_STAT_CENTER = 32_768
/** -1..+1-ish: positive means this element is a real weakness worth exploiting, negative means
 *  it's resisted and worth avoiding when an alternative exists. 0 for an unknown/neutral target. */
export const element_advantage = (target_resistance: number | null): number =>
  target_resistance === null ? 0 : (ITEM_STAT_CENTER - target_resistance) / 50
