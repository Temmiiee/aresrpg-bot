// bun run src/cli_train.ts — the actual "learns by itself" piece. Evolves policy.ts's weight
// vector against the simulator through generations of mutation + selection: no game rule here
// is hand-derived, every weight is discovered by which genomes actually won more simulated
// fights. Not deep RL (no neural net, no gradient signal — there's no ML framework in this
// environment) — this is a (μ+λ) evolution strategy over a small genome, which is a real,
// textbook self-play search method, just a much smaller hypothesis space than a neural policy.
//
// Trains against RANDOM scenarios (training_scenarios.ts): varied party levels, varied mob
// families/counts/levels around each party's own level, and implicitly varied maps (each fight's
// board_seed follows its RNG seed). A fixed easy matchup gives a search nothing to select for —
// everything wins regardless of policy, so every genome looks equally fit. Real spread in
// difficulty (some scenarios losable, most contested) is what makes the fitness signal mean
// anything. No chain calls at all — pure offline simulation.
import { simulate_many, fitness_score } from './simulate.ts'
import { clamp_policy, DEFAULT_POLICY, POLICY_KEYS, type Policy } from './policy.ts'
import { save_trained_policy } from './policy_store.ts'
import { random_scenarios, type Scenario } from './training_scenarios.ts'

const POPULATION = Number(process.argv[3] ?? 10)
const GENERATIONS = Number(process.argv[2] ?? 8)
const SCENARIO_COUNT = Number(process.argv[4] ?? 8)
const ELITES = 4
const RUNS_PER_EVAL = 3
const MUTATION_STD = 0.35
const SCENARIO_SEED = 20260901 // fixed so a training run is reproducible; change to sample a fresh set

const rand_gaussian = (): number => {
  const u = 1 - Math.random()
  const v = Math.random()
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v)
}

const mutate = (policy: Policy, std: number): Policy =>
  clamp_policy(Object.fromEntries(POLICY_KEYS.map((key) => [key, policy[key] + rand_gaussian() * std])) as Policy)

const crossover = (a: Policy, b: Policy): Policy =>
  clamp_policy(Object.fromEntries(POLICY_KEYS.map((key) => [key, (a[key] + b[key]) / 2])) as Policy)

const fitness_of = (scenarios: readonly Scenario[], policy: Policy): number => {
  const results = scenarios.map(({ party, group }) => simulate_many(party, group, RUNS_PER_EVAL, 1n, policy))
  return results.reduce((sum, r) => sum + fitness_score(r), 0) / scenarios.length
}

const describe = (policy: Policy): string => POLICY_KEYS.map((k) => `${k}=${policy[k].toFixed(2)}`).join(' ')

const main = async () => {
  const scenarios = random_scenarios(SCENARIO_SEED, SCENARIO_COUNT)
  console.log(`Scenarios (${scenarios.length}):`)
  for (const s of scenarios) console.log(`  ${s.label}`)
  console.log(`\nEvolving ${POPULATION} genomes x ${GENERATIONS} generations, ${RUNS_PER_EVAL} runs/scenario…\n`)

  const baseline_fitness = fitness_of(scenarios, DEFAULT_POLICY)
  console.log(
    `gen 0 baseline (untrained default): fitness=${baseline_fitness.toFixed(2)}  [${describe(DEFAULT_POLICY)}]`
  )

  let population: Policy[] = [
    DEFAULT_POLICY,
    ...Array.from({ length: POPULATION - 1 }, () => mutate(DEFAULT_POLICY, MUTATION_STD)),
  ]
  let best: { policy: Policy; fitness: number } = { policy: DEFAULT_POLICY, fitness: baseline_fitness }

  for (let gen = 1; gen <= GENERATIONS; gen += 1) {
    const scored = population
      .map((policy) => ({ policy, fitness: fitness_of(scenarios, policy) }))
      .sort((a, b) => b.fitness - a.fitness)
    if (scored[0]!.fitness > best.fitness) best = scored[0]!
    console.log(
      `gen ${gen}: best_this_gen=${scored[0]!.fitness.toFixed(2)}  all_time_best=${best.fitness.toFixed(2)}  [${describe(scored[0]!.policy)}]`
    )

    const elites = scored.slice(0, ELITES).map((s) => s.policy)
    const std = MUTATION_STD * (1 - gen / (GENERATIONS + 1)) // anneal: explore less as generations pass
    const next: Policy[] = [best.policy] // elitism: never lose the all-time best
    while (next.length < POPULATION) {
      const parent_a = elites[Math.floor(Math.random() * elites.length)]!
      const parent_b = elites[Math.floor(Math.random() * elites.length)]!
      next.push(mutate(crossover(parent_a, parent_b), std))
    }
    population = next
  }

  console.log(`\nbaseline fitness: ${baseline_fitness.toFixed(2)}`)
  console.log(`best found:       ${best.fitness.toFixed(2)}  [${describe(best.policy)}]`)
  const improvement = best.fitness - baseline_fitness
  if (improvement > 1) {
    save_trained_policy({
      policy: best.policy,
      trained_at: new Date().toISOString(),
      generations: GENERATIONS,
      fitness: best.fitness,
      matchups: scenarios.map((s) => s.label),
    })
    console.log(
      `→ +${improvement.toFixed(2)} over baseline. Saved to learned_policy.local.json — fight_session.ts will pick it up next fight.`
    )
  } else {
    console.log(
      `→ only +${improvement.toFixed(2)} over baseline — not saving; the untrained default is already competitive for this scenario set.`
    )
  }
}

await main()
