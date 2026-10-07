import { RAW_SCENARIOS } from "../../../fixtures/scenarios";
import { scenarioSchema, type Scenario } from "./scenario";

let cache: Scenario[] | null = null;

export function listScenarios(): Scenario[] {
  cache ??= RAW_SCENARIOS.map((s) => scenarioSchema.parse(s));
  return cache;
}

export function getScenario(id: string): Scenario | null {
  return listScenarios().find((s) => s.id === id) ?? null;
}

export const PLAN_FIXTURES = ["suitable_home", "unsupported_construction", "missing_budget", "price_only", "interrupted_call"] as const;
