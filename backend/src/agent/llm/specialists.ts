import { z } from "zod";
import type { AgentContext } from "../../tools/context.js";
import type { ActionType, GapEntry, ScoredResource } from "../../core/types.js";
import { structuredCompletion } from "./service.js";

const actionSchema = z.enum(["LEARN", "PRACTICE", "IMMEDIATE_TEST", "ACTIVE_RECALL", "REVISION", "FINAL_TEST", "NONE"]);
const strategistSchema = z.object({
  actions: z.array(z.object({ subtopic_id: z.string(), action: actionSchema, overrides_baseline: z.boolean(), rationale: z.string().max(180).optional() })),
  budget_allocation: z.array(z.object({ subtopic_id: z.string(), hours: z.number().min(0) })),
  strategy_note: z.string().max(280),
  negotiation_message: z.string().max(600).optional(),
});

const diagnosticianSchema = z.object({
  subtopic_id: z.string(), root_cause_concept: z.string(), evidence: z.string().max(240), implication: z.string().max(160),
  recommended_resource_profile: z.object({ type: z.enum(["video", "article", "doc", "course", "practice"]), difficulty: z.number().int().min(1).max(5), focus_concept: z.string() }),
  confidence: z.enum(["low", "medium", "high"]),
});

const curatorSchema = z.object({ chosen_resource_id: z.string(), justification: z.string().max(200), expected_usefulness: z.number().min(0).max(1) });

function modelFor(tier: "haiku" | "strategist"): string {
  if ((process.env.LLM_PROVIDER ?? "gemini") === "anthropic") {
    return tier === "haiku"
      ? (process.env.ANTHROPIC_HAIKU_MODEL ?? "claude-haiku-4-5")
      : (process.env.ANTHROPIC_STRATEGIST_MODEL ?? "claude-sonnet-4-5");
  }
  return process.env.GEMINI_MODEL ?? "gemini-2.5-flash";
}

export type StrategyDecision = {
  actions: Map<string, ActionType>;
  budgetHours: Map<string, number>;
  strategyNote: string;
  source: "llm" | "cache" | "fallback";
  negotiationMessage?: string;
  cappedOverrides: number;
};

function proportionalBudget(gaps: GapEntry[], availableHours: number): Map<string, number> {
  const total = gaps.reduce((sum, g) => sum + Math.max(0, g.priority), 0);
  return new Map(gaps.map((g) => [g.subtopic_id, total > 0 ? availableHours * Math.max(0, g.priority) / total : 0]));
}

function extractNumerals(text: string): string[] {
  return text.match(/\d+(\.\d+)?/g) ?? [];
}

/** A negotiation paragraph may not contain a numeral absent from the
 * deterministic options it is describing — an invented "6 days" instead of
 * the computed "4" is worse than no message at all, so the whole message
 * is dropped rather than partially trusted. */
export function validateNegotiationMessage(message: string | undefined, computedOptions: unknown): string | undefined {
  if (!message) return undefined;
  const allowed = new Set(extractNumerals(JSON.stringify(computedOptions)));
  return extractNumerals(message).every((n) => allowed.has(n)) ? message : undefined;
}

/** The only model output that may alter tool selection.  It is still bounded:
 * unknown IDs discard the response; at most three valid overrides survive;
 * no override can bypass an unmet prerequisite. */
export async function runStrategist(opts: {
  ctx: AgentContext;
  gaps: GapEntry[];
  availableHours: number;
  requiredHours: number;
  unmetPrerequisites: Set<string>;
  deadline: string;
  simNow: string;
}): Promise<StrategyDecision> {
  const baseline = Object.fromEntries(opts.gaps.map((g) => [g.subtopic_id, g.action]));
  const fallback = { actions: opts.gaps.map((g) => ({ subtopic_id: g.subtopic_id, action: g.action === "MILESTONE" ? "NONE" : g.action, overrides_baseline: false })), budget_allocation: [], strategy_note: "Deterministic action selection used." };
  const result = await structuredCompletion({
    ctx: opts.ctx, agent: "strategist", schema: strategistSchema, fallback, model: modelFor("strategist"), maxTokens: 1200,
    input: { goal: { deadline: opts.deadline, sim_now: opts.simNow }, budget: { required_hours: opts.requiredHours, available_hours: opts.availableHours, deficit_hours: Math.max(0, opts.requiredHours - opts.availableHours) }, gap_table: opts.gaps.map((g) => ({ subtopic_id: g.subtopic_id, priority: g.priority, baseline_action: g.action })), valid_actions: actionSchema.options, baseline },
  });
  const validIds = new Set(opts.gaps.map((g) => g.subtopic_id));
  if (result.value.actions.some((a) => !validIds.has(a.subtopic_id))) {
    return { actions: new Map(opts.gaps.map((g) => [g.subtopic_id, g.action])), budgetHours: proportionalBudget(opts.gaps, opts.availableHours), strategyNote: "Strategist response rejected: unknown subtopic.", source: "fallback", cappedOverrides: 0 };
  }
  const priority = new Map(opts.gaps.map((g) => [g.subtopic_id, g.priority]));
  const eligibleOverrides = result.value.actions
    .filter((a) => a.overrides_baseline && a.action !== baseline[a.subtopic_id] && Boolean(a.rationale))
    .sort((a, b) => (priority.get(b.subtopic_id) ?? 0) - (priority.get(a.subtopic_id) ?? 0));
  const overrides = eligibleOverrides.slice(0, 3);
  const cappedOverrides = eligibleOverrides.length - overrides.length;
  const actions = new Map(opts.gaps.map((g) => [g.subtopic_id, g.action]));
  for (const proposed of overrides) {
    if (proposed.action === "LEARN" && opts.unmetPrerequisites.has(proposed.subtopic_id)) continue;
    actions.set(proposed.subtopic_id, proposed.action);
  }
  const proposedHours = new Map(result.value.budget_allocation.map((b) => [b.subtopic_id, b.hours]));
  const sum = [...proposedHours.values()].reduce((a, b) => a + b, 0);
  const budgetHours = sum > opts.availableHours * 1.5 ? proportionalBudget(opts.gaps, opts.availableHours) : new Map([...proposedHours].map(([id, hours]) => [id, sum > 0 ? hours * opts.availableHours / sum : 0]));
  return { actions, budgetHours, strategyNote: result.value.strategy_note, source: result.source, negotiationMessage: result.value.negotiation_message, cappedOverrides };
}

export async function runDiagnostician(opts: { ctx: AgentContext; subtopicId: string; concepts: string[]; fallbackConcept: string; input: unknown }) {
  const fallback = { subtopic_id: opts.subtopicId, root_cause_concept: opts.fallbackConcept, evidence: "Lowest observed concept accuracy selected deterministically.", implication: "Use targeted practice before increasing difficulty.", recommended_resource_profile: { type: "practice" as const, difficulty: 3, focus_concept: opts.fallbackConcept }, confidence: "low" as const };
  const input = typeof opts.input === "object" && opts.input !== null && !Array.isArray(opts.input) ? opts.input as Record<string, unknown> : { input: opts.input };
  const result = await structuredCompletion({ ctx: opts.ctx, agent: "diagnostician", schema: diagnosticianSchema, fallback, model: modelFor("haiku"), maxTokens: 500, input: { ...input, valid_concepts: opts.concepts } });
  if (result.value.subtopic_id !== opts.subtopicId || !opts.concepts.includes(result.value.root_cause_concept) || !opts.concepts.includes(result.value.recommended_resource_profile.focus_concept)) return { value: fallback, source: "fallback" as const };
  return { value: result.value, source: result.source };
}

export async function runCurator(opts: { ctx: AgentContext; candidates: ScoredResource[]; input: unknown }) {
  const top = opts.candidates[0];
  if (!top) return null;
  const fallback = { chosen_resource_id: top.resource_id, justification: `Highest deterministic fit (${top.fit.toFixed(2)}).`, expected_usefulness: top.fit };
  const input = typeof opts.input === "object" && opts.input !== null && !Array.isArray(opts.input) ? opts.input as Record<string, unknown> : { input: opts.input };
  const result = await structuredCompletion({ ctx: opts.ctx, agent: "curator", schema: curatorSchema, fallback, model: modelFor("haiku"), maxTokens: 400, input: { ...input, candidates: opts.candidates } });
  if (!opts.candidates.some((c) => c.resource_id === result.value.chosen_resource_id)) return { value: fallback, source: "fallback" as const };
  return { value: result.value, source: result.source };
}
