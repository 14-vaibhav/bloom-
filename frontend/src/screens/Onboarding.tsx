import { useEffect, useMemo, useState } from "react";
import { api } from "../lib/api";
import { useApiData } from "../lib/useApiData";
import { useAgentStream } from "../lib/useAgentStream";
import type { AssessmentDetail, StudentState, Subject, SubjectTree } from "../lib/types";
import { Card, ErrorBox, Loading } from "../components/ui";
import { AssessmentRunner } from "./Assessment";

const DAYS = [
  { key: "1", label: "Mon" },
  { key: "2", label: "Tue" },
  { key: "3", label: "Wed" },
  { key: "4", label: "Thu" },
  { key: "5", label: "Fri" },
  { key: "6", label: "Sat" },
  { key: "0", label: "Sun" },
];

export function Onboarding({ studentId, onComplete }: { studentId: string; onComplete: () => void }) {
  // Navigation / View state
  const [viewMode, setViewMode] = useState<"configure" | "diagnostic" | "running">("configure");
  const [error, setError] = useState<string | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);

  // Configuration state
  const [subjectId, setSubjectId] = useState<string>("dsa");
  const [deadline, setDeadline] = useState<string>("");
  const [maxDailyMin, setMaxDailyMin] = useState<number>(90);
  const [availability, setAvailability] = useState<Record<string, Array<{ start: string; end: string }>>>({
    "1": [{ start: "18:00", end: "20:00" }],
    "2": [{ start: "18:00", end: "20:00" }],
    "3": [{ start: "18:00", end: "20:00" }],
    "4": [{ start: "18:00", end: "20:00" }],
    "5": [{ start: "18:00", end: "20:00" }],
  });

  // Curriculum scope state
  const [dropped, setDropped] = useState<Set<string>>(new Set());
  const [searchQuery, setSearchQuery] = useState("");
  const [collapsedTopics, setCollapsedTopics] = useState<Set<string>>(new Set());

  // Backend generated IDs
  const [goalId, setGoalId] = useState<string | null>(null);
  const [assessmentId, setAssessmentId] = useState<string | null>(null);

  // Fetch subjects catalog
  const { data: subjects, loading: subjectsLoading, error: subjectsError, reload: reloadSubjects } = useApiData(
    () => api.get<Subject[]>("/subjects"),
    [],
  );

  // Dynamically fetch curriculum tree whenever subjectId changes
  const { data: tree, loading: treeLoading, error: treeError } = useApiData(
    () => (subjectId ? api.get<SubjectTree>(`/subjects/${subjectId}/tree`) : Promise.resolve(null as SubjectTree | null)),
    [subjectId],
  );

  // Student baseline clock to accurately constrain deadline
  const { data: studentState } = useApiData(
    () => api.get<StudentState>(`/students/${studentId}/state`),
    [studentId],
  );
  const simNow = useMemo(() => {
    return studentState?.student?.sim_now ? new Date(studentState.student.sim_now) : new Date();
  }, [studentState]);

  // Set default deadline (30 days from simNow) once studentState is known
  useEffect(() => {
    if (!deadline && simNow) {
      const defaultDate = new Date(simNow.getTime() + 30 * 86_400_000).toISOString().slice(0, 10);
      setDeadline(defaultDate);
    }
  }, [simNow, deadline]);

  // Reset dropped subtopics when switching subjects
  useEffect(() => {
    setDropped(new Set());
  }, [subjectId]);

  // Minimum & Maximum deadline bounds (7–60 days from simNow)
  const minDate = useMemo(() => new Date(simNow.getTime() + 7 * 86_400_000).toISOString().slice(0, 10), [simNow]);
  const maxDate = useMemo(() => new Date(simNow.getTime() + 60 * 86_400_000).toISOString().slice(0, 10), [simNow]);

  // Quick preset deadline handler
  function applyDeadlinePreset(daysOffset: number) {
    const target = new Date(simNow.getTime() + daysOffset * 86_400_000).toISOString().slice(0, 10);
    setDeadline(target);
  }

  // Calculate usable weekly study hours
  const usableHours = useMemo(() => {
    let minutes = 0;
    for (const windows of Object.values(availability)) {
      for (const w of windows) {
        const [sh, sm] = w.start.split(":").map(Number);
        const [eh, em] = w.end.split(":").map(Number);
        minutes += Math.max(0, eh * 60 + em - (sh * 60 + sm));
      }
    }
    return (minutes * 4.3) / 60;
  }, [availability]);

  function toggleDay(day: string) {
    setAvailability((prev) => {
      const next = { ...prev };
      if (next[day]) delete next[day];
      else next[day] = [{ start: "18:00", end: "20:00" }];
      return next;
    });
  }

  function setAllWeekdays() {
    setAvailability({
      "1": [{ start: "18:00", end: "20:00" }],
      "2": [{ start: "18:00", end: "20:00" }],
      "3": [{ start: "18:00", end: "20:00" }],
      "4": [{ start: "18:00", end: "20:00" }],
      "5": [{ start: "18:00", end: "20:00" }],
    });
  }

  function setFullWeek() {
    const all: Record<string, Array<{ start: string; end: string }>> = {};
    for (const d of DAYS) all[d.key] = [{ start: "18:00", end: "20:00" }];
    setAvailability(all);
  }

  // Flatten all subtopics from the current tree
  const allSubtopics = useMemo(() => {
    if (!tree) return [];
    return tree.topics.flatMap((t) =>
      t.subtopics.map((s) => ({
        ...s,
        topicId: t.id,
        topicName: t.name,
        topicWeight: t.weight,
        rawWeight: t.weight * s.weight,
      })),
    );
  }, [tree]);

  // DYNAMIC WEIGHT RE-BALANCING
  // Computes normalized percentage weights for all active (not dropped) subtopics
  const dynamicWeights = useMemo(() => {
    const active = allSubtopics.filter((s) => !dropped.has(s.id));
    const totalRaw = active.reduce((sum, s) => sum + s.rawWeight, 0);
    const result: Record<string, number> = {};
    if (totalRaw > 0) {
      for (const s of active) {
        result[s.id] = s.rawWeight / totalRaw;
      }
    } else if (active.length > 0) {
      const equalShare = 1 / active.length;
      for (const s of active) result[s.id] = equalShare;
    }
    return result;
  }, [allSubtopics, dropped]);

  const activeSubtopicsCount = allSubtopics.length - dropped.size;
  const activeHoursEstimate = useMemo(() => {
    return allSubtopics
      .filter((s) => !dropped.has(s.id))
      .reduce((sum, s) => sum + s.base_hours, 0);
  }, [allSubtopics, dropped]);

  function toggleSubtopic(id: string) {
    setDropped((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  function selectAllSubtopics() {
    setDropped(new Set());
  }

  function toggleTopicCollapse(topicId: string) {
    setCollapsedTopics((prev) => {
      const next = new Set(prev);
      if (next.has(topicId)) next.delete(topicId);
      else next.add(topicId);
      return next;
    });
  }

  // Submission handler for creating goal, setting blueprint, and launching diagnostic
  async function handleConfirm(skipDiagnostic = false) {
    setError(null);
    setIsSubmitting(true);
    try {
      if (!subjectId) throw new Error("Please select a target subject.");
      if (!deadline) throw new Error("Please pick a target completion deadline.");
      if (Object.keys(availability).length === 0) throw new Error("Please select at least one study day.");
      if (activeSubtopicsCount === 0) throw new Error("Please select at least one curriculum subtopic.");

      // 1. Create the learning goal
      const created = await api.post<{ goal_id: string; blueprint: Record<string, number> }>("/goals", {
        student_id: studentId,
        subject_id: subjectId,
        deadline,
        availability,
        max_daily_min: maxDailyMin,
      });
      const gId = created.goal_id;
      setGoalId(gId);

      // 2. Commit dynamically re-balanced weights and dropped subtopics
      await api.post(`/goals/${gId}/blueprint`, {
        weights: dynamicWeights,
        dropped: Array.from(dropped),
      });

      if (skipDiagnostic) {
        setViewMode("running");
        return;
      }

      // 3. Request initial diagnostic assessment
      try {
        const diag = await api.get<AssessmentDetail & { assessment_id: string }>(`/goals/${gId}/diagnostic`);
        setAssessmentId(diag.assessment_id);
        setViewMode("diagnostic");
      } catch (diagErr) {
        console.warn("Diagnostic unavailable, proceeding directly to plan generation:", diagErr);
        setViewMode("running");
      }
    } catch (err: unknown) {
      console.error("Onboarding failed:", err);
      const msg = err instanceof Error ? err.message : "Failed to initialize learning goal. Please check constraints.";
      setError(msg);
    } finally {
      setIsSubmitting(false);
    }
  }

  // DIAGNOSTIC SCREEN
  if (viewMode === "diagnostic" && assessmentId) {
    return (
      <div className="mx-auto max-w-2xl space-y-6">
        <section className="rounded-2xl border border-zinc-900 bg-zinc-950 px-8 py-8">
          <div className="text-xs uppercase tracking-widest text-zinc-600 mb-3">Phase 1 · Diagnostic</div>
          <h1 className="text-3xl font-semibold text-zinc-100">Initial Diagnostic Checkpoint</h1>
          <p className="mt-2 text-base text-zinc-500">
            15 curated questions across your selected syllabus to initialize Bloom's probabilistic belief model.
          </p>
        </section>
        <DiagnosticWrapper
          assessmentId={assessmentId}
          onDone={() => setViewMode("running")}
          onSkip={() => setViewMode("running")}
        />
      </div>
    );
  }

  // AGENT RUNNER SCREEN
  if (viewMode === "running") {
    return <FirstRun studentId={studentId} onComplete={onComplete} />;
  }

  // UNIFIED ONBOARDING VIEW
  return (
    <div className="mx-auto max-w-4xl space-y-10 pb-16">
      {/* Header Banner */}
      <section className="rounded-2xl border border-zinc-900 bg-zinc-950 px-8 py-8">
        <div className="text-xs uppercase tracking-widest text-zinc-600 mb-3">Onboarding · Unified Setup</div>
        <h1 className="text-3xl font-semibold text-zinc-100">Design Your Learning Strategy</h1>
        <p className="mt-2 text-base text-zinc-500">
          Set your target subject, availability constraints, and customized curriculum scope in one unified view.
        </p>
      </section>

      {error && <ErrorBox message={error} onRetry={() => setError(null)} />}

      {/* SECTION 1: Subject Selection */}
      <div className="space-y-4">
        <div className="flex items-center justify-between">
          <div>
            <h2 className="text-lg font-semibold text-zinc-100">1. Select Target Subject</h2>
            <p className="text-xs text-zinc-500">Choose the primary domain to calibrate your pacing and practice engine.</p>
          </div>
          {subjectsLoading && <span className="text-xs text-zinc-500">Loading catalog…</span>}
        </div>

        {subjectsError && <ErrorBox message={subjectsError} onRetry={reloadSubjects} />}

        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          {(subjects ?? []).map((s) => {
            const isSelected = subjectId === s.id;
            return (
              <button
                key={s.id}
                type="button"
                onClick={() => setSubjectId(s.id)}
                className={`group relative rounded-2xl border p-5 text-left transition-all ${
                  isSelected
                    ? "border-zinc-500 bg-zinc-900/90 ring-1 ring-zinc-500"
                    : "border-zinc-900 bg-zinc-950 hover:border-zinc-800 hover:bg-zinc-900/40"
                }`}
              >
                <div className="flex items-center justify-between">
                  <span className="text-base font-semibold text-zinc-100 group-hover:text-white">{s.name}</span>
                  {s.id === "dsa" ? (
                    <span className="rounded-md border border-zinc-700 bg-zinc-800 px-2 py-0.5 text-[10px] font-mono text-zinc-300">
                      Recommended
                    </span>
                  ) : (
                    <span className="text-xs text-zinc-600">{s.topic_count} topics</span>
                  )}
                </div>
                <p className="mt-2 text-xs text-zinc-400 line-clamp-2 leading-relaxed">{s.description}</p>
                <div className="mt-4 flex items-center justify-between text-[11px] text-zinc-500 border-t border-zinc-900/80 pt-3">
                  <span>{s.topic_count} subtopics</span>
                  <span className={isSelected ? "text-zinc-200 font-medium" : "text-zinc-600"}>
                    {isSelected ? "Active Target ✓" : "Click to select"}
                  </span>
                </div>
              </button>
            );
          })}
        </div>
      </div>

      {/* SECTION 2: Timeline & Pacing */}
      <div className="space-y-4">
        <div>
          <h2 className="text-lg font-semibold text-zinc-100">2. Timeline & Study Availability</h2>
          <p className="text-xs text-zinc-500">Specify your target deadline and weekly schedule budget.</p>
        </div>

        <div className="grid grid-cols-1 gap-6 md:grid-cols-2">
          {/* Target Deadline */}
          <Card className="flex flex-col justify-between">
            <div>
              <label className="text-sm font-medium text-zinc-200 block mb-1">Target Completion Deadline</label>
              <p className="text-xs text-zinc-500 mb-3">Must be between 7 and 60 days from simulated time.</p>
              <input
                type="date"
                min={minDate}
                max={maxDate}
                value={deadline}
                onChange={(e) => setDeadline(e.target.value)}
                className="w-full rounded-xl border border-zinc-800 bg-zinc-900 px-4 py-2.5 text-sm text-zinc-100 focus:border-zinc-600 focus:outline-none font-mono"
              />
            </div>
            <div className="mt-4 pt-3 border-t border-zinc-900">
              <span className="text-[11px] text-zinc-500 block mb-1.5 font-mono">Quick Presets:</span>
              <div className="flex gap-2">
                <button
                  type="button"
                  onClick={() => applyDeadlinePreset(14)}
                  className="rounded-lg border border-zinc-800 bg-zinc-900 px-3 py-1 text-xs text-zinc-300 hover:border-zinc-700 hover:text-white transition-colors"
                >
                  +2 Weeks
                </button>
                <button
                  type="button"
                  onClick={() => applyDeadlinePreset(30)}
                  className="rounded-lg border border-zinc-800 bg-zinc-900 px-3 py-1 text-xs text-zinc-300 hover:border-zinc-700 hover:text-white transition-colors"
                >
                  +1 Month
                </button>
                <button
                  type="button"
                  onClick={() => applyDeadlinePreset(45)}
                  className="rounded-lg border border-zinc-800 bg-zinc-900 px-3 py-1 text-xs text-zinc-300 hover:border-zinc-700 hover:text-white transition-colors"
                >
                  +6 Weeks
                </button>
              </div>
            </div>
          </Card>

          {/* Daily & Weekly Hours */}
          <Card className="flex flex-col justify-between">
            <div>
              <div className="flex items-center justify-between mb-2">
                <label className="text-sm font-medium text-zinc-200">Weekly Study Schedule</label>
                <div className="flex gap-2 text-[10px]">
                  <button
                    type="button"
                    onClick={setAllWeekdays}
                    className="text-zinc-500 hover:text-zinc-300 underline"
                  >
                    Weekdays
                  </button>
                  <button
                    type="button"
                    onClick={setFullWeek}
                    className="text-zinc-500 hover:text-zinc-300 underline"
                  >
                    All Days
                  </button>
                </div>
              </div>
              <div className="flex gap-1.5 flex-wrap">
                {DAYS.map((d) => {
                  const active = !!availability[d.key];
                  return (
                    <button
                      key={d.key}
                      type="button"
                      onClick={() => toggleDay(d.key)}
                      className={`flex-1 rounded-xl border py-2 text-xs font-medium transition-all ${
                        active
                          ? "border-zinc-500 bg-zinc-800 text-zinc-100"
                          : "border-zinc-900 bg-zinc-950 text-zinc-600 hover:border-zinc-800 hover:text-zinc-400"
                      }`}
                    >
                      {d.label}
                    </button>
                  );
                })}
              </div>

              <div className="mt-4">
                <div className="flex items-center justify-between">
                  <label className="text-xs font-medium text-zinc-300">Daily Study Target</label>
                  <span className="text-xs font-mono text-zinc-400">{maxDailyMin} min/day</span>
                </div>
                <input
                  type="range"
                  min={30}
                  max={240}
                  step={15}
                  value={maxDailyMin}
                  onChange={(e) => setMaxDailyMin(Number(e.target.value))}
                  className="mt-2 w-full accent-zinc-200 bg-zinc-900 cursor-pointer"
                />
              </div>
            </div>

            <div className="mt-3 pt-3 border-t border-zinc-900 flex items-center justify-between text-xs">
              <span className="text-zinc-500">Calculated Horizon Budget:</span>
              <span className="font-mono text-zinc-300 font-medium">~{usableHours.toFixed(0)} usable study hours</span>
            </div>
          </Card>
        </div>
      </div>

      {/* SECTION 3: Dynamic Curriculum Scope */}
      <div className="space-y-4">
        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
          <div>
            <h2 className="text-lg font-semibold text-zinc-100">3. Dynamic Curriculum Scope</h2>
            <p className="text-xs text-zinc-500">
              Customize which topics and subtopics are covered. Weights re-balance automatically to 100%.
            </p>
          </div>
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={selectAllSubtopics}
              className="rounded-xl border border-zinc-800 bg-zinc-900 px-3 py-1.5 text-xs text-zinc-300 hover:border-zinc-700 hover:text-white transition-colors"
            >
              Select All
            </button>
            <input
              type="text"
              placeholder="Filter topics…"
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              className="rounded-xl border border-zinc-800 bg-zinc-900 px-3 py-1.5 text-xs text-zinc-100 placeholder-zinc-600 focus:border-zinc-600 focus:outline-none w-40"
            />
          </div>
        </div>

        {/* Live Metrics Header Bar */}
        <div className="grid grid-cols-3 gap-3 rounded-2xl border border-zinc-900 bg-zinc-950 p-4 text-center">
          <div>
            <p className="text-[11px] uppercase tracking-wider text-zinc-600 font-mono">Active Subtopics</p>
            <p className="text-xl font-semibold text-zinc-100 mt-0.5">
              {activeSubtopicsCount} <span className="text-xs text-zinc-500 font-normal">/ {allSubtopics.length}</span>
            </p>
          </div>
          <div>
            <p className="text-[11px] uppercase tracking-wider text-zinc-600 font-mono">Curriculum Coverage</p>
            <p className="text-xl font-semibold text-zinc-100 mt-0.5">
              {allSubtopics.length > 0 ? Math.round((activeSubtopicsCount / allSubtopics.length) * 100) : 0}%
            </p>
          </div>
          <div>
            <p className="text-[11px] uppercase tracking-wider text-zinc-600 font-mono">Est. Syllabus Depth</p>
            <p className="text-xl font-semibold text-zinc-100 mt-0.5">
              {activeHoursEstimate.toFixed(1)} <span className="text-xs text-zinc-500 font-normal">hrs</span>
            </p>
          </div>
        </div>

        {treeLoading && <Loading label="Loading curriculum blueprint…" />}
        {treeError && <ErrorBox message={treeError} />}

        {/* Topics List with Dynamic Weights */}
        <div className="space-y-4">
          {(tree?.topics ?? []).map((topic) => {
            const isCollapsed = collapsedTopics.has(topic.id);
            const visibleSubtopics = topic.subtopics.filter(
              (s) =>
                !searchQuery ||
                s.name.toLowerCase().includes(searchQuery.toLowerCase()) ||
                s.description?.toLowerCase().includes(searchQuery.toLowerCase()),
            );

            if (searchQuery && visibleSubtopics.length === 0) return null;

            const activeTopicCount = topic.subtopics.filter((s) => !dropped.has(s.id)).length;

            return (
              <Card key={topic.id} className="p-5">
                <div className="flex items-center justify-between pb-3 border-b border-zinc-900">
                  <div className="flex items-center gap-3">
                    <button
                      type="button"
                      onClick={() => toggleTopicCollapse(topic.id)}
                      className="text-xs text-zinc-500 hover:text-zinc-300 font-mono"
                    >
                      {isCollapsed ? "▶" : "▼"}
                    </button>
                    <div>
                      <p className="text-sm font-semibold text-zinc-100">{topic.name}</p>
                      <p className="text-[11px] text-zinc-500">
                        {activeTopicCount} of {topic.subtopics.length} subtopics included
                      </p>
                    </div>
                  </div>
                  <span className="text-xs font-mono text-zinc-500">Base {topic.base_hours}h</span>
                </div>

                {!isCollapsed && (
                  <div className="divide-y divide-zinc-900/60 pt-2">
                    {visibleSubtopics.map((s) => {
                      const isIncluded = !dropped.has(s.id);
                      const currentWeightPercent = ((dynamicWeights[s.id] ?? 0) * 100).toFixed(1);

                      return (
                        <div
                          key={s.id}
                          className={`flex items-start justify-between py-2.5 transition-colors ${
                            isIncluded ? "text-zinc-200" : "text-zinc-600"
                          }`}
                        >
                          <label className="flex items-start gap-3 cursor-pointer flex-1 mr-4">
                            <input
                              type="checkbox"
                              checked={isIncluded}
                              onChange={() => toggleSubtopic(s.id)}
                              className="mt-0.5 rounded border-zinc-800 bg-zinc-900 text-zinc-100 focus:ring-0 cursor-pointer"
                            />
                            <div>
                              <p className="text-xs font-medium">{s.name}</p>
                              {s.description && (
                                <p className="text-[11px] text-zinc-500 line-clamp-1 mt-0.5">{s.description}</p>
                              )}
                            </div>
                          </label>

                          <div className="flex items-center gap-3 shrink-0">
                            <span className="text-[11px] font-mono text-zinc-600">{s.base_hours}h</span>
                            <span
                              className={`rounded-md border px-2 py-0.5 text-[11px] font-mono transition-all ${
                                isIncluded
                                  ? "border-zinc-800 bg-zinc-900 text-zinc-200 font-medium"
                                  : "border-transparent text-zinc-700 line-through"
                              }`}
                              title="Dynamic weight re-balanced across selected subtopics"
                            >
                              {isIncluded ? `${currentWeightPercent}%` : "0%"}
                            </span>
                          </div>
                        </div>
                      );
                    })}
                  </div>
                )}
              </Card>
            );
          })}
        </div>
      </div>

      {/* SECTION 4: Confirmation & Launch Action Bar */}
      <div className="rounded-2xl border border-zinc-800 bg-zinc-950 p-6 shadow-2xl flex flex-col md:flex-row items-center justify-between gap-5 sticky bottom-4 z-30 backdrop-blur-md">
        <div>
          <p className="text-xs uppercase tracking-widest text-zinc-600 font-mono">Plan Readiness</p>
          <p className="text-sm font-semibold text-zinc-100 mt-0.5">
            {subjects?.find((s) => s.id === subjectId)?.name ?? "Subject"} · {activeSubtopicsCount} subtopics active
          </p>
          <p className="text-xs text-zinc-500 mt-1">
            Deadline: <span className="font-mono text-zinc-300">{deadline || "Not set"}</span> · Target Pacing:{" "}
            <span className="font-mono text-zinc-300">{maxDailyMin}m/day</span>
          </p>
        </div>

        <div className="flex items-center gap-3 w-full md:w-auto">
          <button
            type="button"
            disabled={isSubmitting || activeSubtopicsCount === 0 || !deadline}
            onClick={() => handleConfirm(true)}
            className="flex-1 md:flex-none rounded-xl border border-zinc-800 bg-zinc-900 px-5 py-3 text-xs font-medium text-zinc-300 hover:border-zinc-700 hover:text-white transition-colors disabled:opacity-40"
            title="Skip initial diagnostic and synthesize pacing schedule immediately"
          >
            Skip Diagnostic & Build Plan
          </button>

          <button
            type="button"
            disabled={isSubmitting || activeSubtopicsCount === 0 || !deadline}
            onClick={() => handleConfirm(false)}
            className="flex-1 md:flex-none flex items-center justify-center gap-2 rounded-xl bg-zinc-100 px-6 py-3 text-sm font-semibold text-zinc-900 hover:bg-white transition-all disabled:opacity-40 shadow-lg"
          >
            {isSubmitting ? (
              <>
                <span className="h-3.5 w-3.5 animate-spin rounded-full border-2 border-zinc-900 border-t-transparent" />
                <span>Initializing…</span>
              </>
            ) : (
              <span>Confirm & Take Diagnostic →</span>
            )}
          </button>
        </div>
      </div>
    </div>
  );
}

function DiagnosticWrapper({
  assessmentId,
  onDone,
  onSkip,
}: {
  assessmentId: string;
  onDone: () => void;
  onSkip: () => void;
}) {
  const [submitted, setSubmitted] = useState(false);
  if (submitted) {
    return (
      <Card>
        <p className="text-base font-semibold text-zinc-100">Diagnostic Complete</p>
        <p className="mt-2 text-sm text-zinc-400">
          Your initial baseline has been recorded. Bloom is now ready to build your customized pacing strategy.
        </p>
        <button
          onClick={onDone}
          className="mt-4 rounded-xl bg-zinc-100 px-5 py-2.5 text-sm font-medium text-zinc-900 hover:bg-white transition-colors"
        >
          Build My Study Plan →
        </button>
      </Card>
    );
  }
  return (
    <div className="space-y-4">
      <div className="flex justify-end">
        <button
          onClick={onSkip}
          className="text-xs text-zinc-500 hover:text-zinc-300 underline font-mono"
        >
          Skip diagnostic and generate plan →
        </button>
      </div>
      <AssessmentRunner assessmentId={assessmentId} onSubmitted={() => setSubmitted(true)} />
    </div>
  );
}

function FirstRun({ studentId, onComplete }: { studentId: string; onComplete: () => void }) {
  const { events } = useAgentStream(studentId);
  const [done, setDone] = useState(false);
  const [started, setStarted] = useState(false);

  useEffect(() => {
    if (!started) {
      setStarted(true);
      void api
        .post("/agent/run", { student_id: studentId })
        .then(() => setDone(true))
        .catch(() => setDone(true));
    }
  }, [started, studentId]);

  return (
    <div className="mx-auto max-w-xl space-y-6 pt-6">
      <section className="rounded-2xl border border-zinc-900 bg-zinc-950 px-8 py-8">
        <div className="text-xs uppercase tracking-widest text-zinc-600 mb-3">Plan Generation</div>
        <h1 className="text-3xl font-semibold text-zinc-100">Synthesizing Strategy…</h1>
        <p className="mt-2 text-base text-zinc-500">
          Running solver passes to generate optimal activity sequencing and mastery checkpoints.
        </p>
      </section>

      <div className="max-h-96 space-y-2 overflow-y-auto rounded-2xl border border-zinc-900 bg-zinc-950 p-5 font-mono text-xs">
        {events.map((e) => (
          <div key={e.id} className="flex items-start gap-2 text-zinc-400">
            <span className="text-zinc-600 uppercase tracking-wider">{e.phase}</span>
            <span className="text-zinc-300">{e.message}</span>
          </div>
        ))}
        {events.length === 0 && <p className="text-zinc-600">Connecting to planner stream…</p>}
      </div>

      {done && (
        <button
          onClick={onComplete}
          className="w-full rounded-xl bg-zinc-100 py-3.5 text-sm font-semibold text-zinc-900 hover:bg-white transition-colors shadow-lg"
        >
          View My Dashboard →
        </button>
      )}
    </div>
  );
}
