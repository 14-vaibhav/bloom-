/**
 * Maps every "tool.operation" name to its implementation. This is the only
 * file that imports all five tool modules — the agent never imports a tool
 * directly (bloom-phase2-brief.md §2); it goes through callTool(), which
 * looks up handlers here.
 */

import * as performance from "./performance.js";
import * as rag from "./rag.js";
import * as calendar from "./calendar.js";
import * as qbank from "./qbank.js";
import * as state from "./state.js";
import * as kb from "./kb.js";
import type { AgentContext } from "./context.js";
import type { ToolInput, ToolName, ToolOutput } from "./schemas.js";

export type HandlerResult<T extends ToolName> = { output: ToolOutput<T>; notices?: string[] };
type Handler<T extends ToolName> = (input: ToolInput<T>, ctx: AgentContext) => Promise<HandlerResult<T>>;

async function plain<T extends ToolName>(output: ToolOutput<T>): Promise<HandlerResult<T>> {
  return { output };
}

export const registry: { [K in ToolName]: Handler<K> } = {
  "performance.get_student_performance": async (i) => plain(await performance.getStudentPerformance(i)),
  "performance.get_subtopic_performance": async (i) => plain(await performance.getSubtopicPerformance(i)),
  "performance.get_assessment_history": async (i) => plain(await performance.getAssessmentHistory(i)),
  "performance.get_completion_history": async (i) => plain(await performance.getCompletionHistory(i)),

  "rag.search_learning_resources": async (i, ctx) => {
    const { output, notices } = await rag.searchLearningResources(i, ctx.clock);
    return { output, notices };
  },
  "rag.get_resource_details": async (i) => plain(await rag.getResourceDetails(i)),

  "calendar.get_existing_events": async (i) => plain(await calendar.getExistingEvents(i)),
  "calendar.get_available_slots": async (i) => plain(await calendar.getAvailableSlots(i)),
  "calendar.create_learning_session": async (i) => plain(await calendar.createLearningSession(i)),
  "calendar.modify_learning_session": async (i) => plain(await calendar.modifyLearningSession(i)),
  "calendar.delete_learning_session": async (i) => plain(await calendar.deleteLearningSession(i)),

  "qbank.get_questions": async (i) => plain(await qbank.getQuestions(i)),
  "qbank.compose_assessment": async (i) => plain(await qbank.composeAssessment(i)),
  "qbank.submit_answers": async (i) => plain(await qbank.submitAnswers(i)),
  "qbank.get_revision_pool": async (i) => plain(await qbank.getRevisionPool(i)),

  "kb.search_course_content": async (i) => kb.searchCourse(i),
  "kb.get_chunk": async (i) => plain(await kb.getChunk(i)),
  "kb.get_source_outline": async (i) => plain(await kb.getSourceOutline(i)),

  "state.get_student_state": async (i) => plain(await state.getStudentState(i)),
  "state.patch_student_state": async (i) => plain(await state.patchStudentState(i)),
  "state.append_observation": async (i) => plain(await state.appendObservation(i)),
  "state.get_plan": async (i) => plain(await state.getPlan(i)),
  "state.save_plan_version": async (i) => plain(await state.savePlanVersion(i)),
  "state.get_constraints": async (i) => plain(await state.getConstraints(i)),
};
