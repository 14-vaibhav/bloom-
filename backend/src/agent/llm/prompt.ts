import { readFile } from "node:fs/promises";
import path from "node:path";
import type { LLMAgentName } from "./types.js";

type Prompt = { version: string; system: string };
const memo = new Map<LLMAgentName, Prompt>();

export async function loadPrompt(agent: Exclude<LLMAgentName, "summary">): Promise<Prompt> {
  const hit = memo.get(agent);
  if (hit) return hit;
  const raw = await readFile(path.resolve(import.meta.dirname, "prompts", `${agent}.md`), "utf8");
  const match = raw.match(/^<!--\s*version:\s*([^\s]+)\s*-->\s*/);
  if (!match) throw new Error(`Prompt ${agent} is missing a version header`);
  const prompt = { version: match[1], system: raw.slice(match[0].length).trim() };
  memo.set(agent, prompt);
  return prompt;
}
