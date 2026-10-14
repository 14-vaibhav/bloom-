import { useEffect, useState } from "react";
import { NavLink, Route, Routes, useNavigate } from "react-router-dom";
import { useStudentId } from "./lib/student";
import { Loading } from "./components/ui";
import { DemoPanel } from "./components/DemoPanel";
import { Onboarding } from "./screens/Onboarding";
import { Login } from "./screens/Login";
import { UNAUTHENTICATED_EVENT } from "./lib/session";
import { Dashboard } from "./screens/Dashboard";
import { StudyPlan } from "./screens/StudyPlan";
import { TopicProgress } from "./screens/TopicProgress";
import { AssessmentScreen } from "./screens/Assessment";
import { AgentActivity } from "./screens/AgentActivity";
import { PlanChanges } from "./screens/PlanChanges";
import { Eval } from "./screens/Eval";
import { Library } from "./screens/Library";
import { Tutor } from "./screens/Tutor";

// Focused primary navigation: 6 clean, intuitive tabs
const PRIMARY_NAV = [
  { to: "/", label: "Dashboard" },
  { to: "/plan", label: "Study Plan" },
  { to: "/progress", label: "Curriculum" },
  { to: "/library", label: "Library" },
  { to: "/tutor", label: "AI Tutor" },
  { to: "/assessment", label: "Practice" },
];

// Developer / System diagnostics navigation
const SYSTEM_NAV = [
  { to: "/activity", label: "Agent Activity Stream", desc: "Live planner and solver execution events" },
  { to: "/changes", label: "Plan Version Diff", desc: "Audit trigger rationale and plan versions" },
  { to: "/eval", label: "Model & KB Evaluation", desc: "Retrieval and simulation calibration metrics" },
  { to: "/onboarding", label: "Setup Wizard / New Goal", desc: "Re-run full curriculum setup" },
];

function Shell({ studentId, children }: { studentId: string; children: React.ReactNode }) {
  const navigate = useNavigate();
  const [toolsOpen, setToolsOpen] = useState(false);
  const [demoOpen, setDemoOpen] = useState(false);

  return (
    <div className="min-h-screen bg-black text-zinc-100 flex flex-col font-sans selection:bg-zinc-800 selection:text-white">
      {/* Top Application Header */}
      <header className="sticky top-0 z-40 w-full border-b border-zinc-900 bg-black/90 backdrop-blur-md px-6 py-3.5">
        <div className="mx-auto flex max-w-7xl items-center justify-between gap-6">
          {/* Logo & Brand */}
          <div className="flex items-center gap-6">
            <NavLink to="/" className="flex items-center gap-2 group">
              <span className="h-6 w-6 rounded-lg bg-white flex items-center justify-center font-bold text-xs text-black transition-transform group-hover:scale-105">
                ✦
              </span>
              <span className="text-lg font-semibold tracking-tight text-white">Bloom</span>
              <span className="rounded-full border border-zinc-800 bg-zinc-900/80 px-2 py-0.5 text-[10px] font-mono text-zinc-400 hidden sm:inline-block">
                AI Companion
              </span>
            </NavLink>

            {/* Primary Navigation Tabs */}
            <nav className="hidden md:flex items-center gap-1">
              {PRIMARY_NAV.map((n) => (
                <NavLink
                  key={n.to}
                  to={n.to}
                  end={n.to === "/"}
                  className={({ isActive }) =>
                    `rounded-xl px-3.5 py-1.5 text-xs font-medium transition-all whitespace-nowrap ${
                      isActive
                        ? "bg-zinc-900 text-white shadow-sm ring-1 ring-zinc-800"
                        : "text-zinc-400 hover:text-zinc-200 hover:bg-zinc-900/50"
                    }`
                  }
                >
                  {n.label}
                </NavLink>
              ))}
            </nav>
          </div>

          {/* Right Controls: System Dropdown & Simulator Trigger */}
          <div className="flex items-center gap-3">
            {/* System Menu Dropdown */}
            <div className="relative">
              <button
                type="button"
                onClick={() => setToolsOpen((prev) => !prev)}
                className={`flex items-center gap-1.5 rounded-xl border px-3 py-1.5 text-xs font-medium transition-all ${
                  toolsOpen
                    ? "border-zinc-700 bg-zinc-900 text-white"
                    : "border-zinc-800/80 bg-zinc-950 text-zinc-400 hover:border-zinc-700 hover:text-zinc-200"
                }`}
              >
                <span>Diagnostics</span>
                <span className="text-[10px] text-zinc-500 font-mono">▾</span>
              </button>

              {toolsOpen && (
                <>
                  <div className="fixed inset-0 z-30" onClick={() => setToolsOpen(false)} />
                  <div className="absolute right-0 mt-2 z-40 w-72 rounded-2xl border border-zinc-800 bg-zinc-950 p-2 shadow-2xl backdrop-blur-xl divide-y divide-zinc-900">
                    <div className="px-3 py-2">
                      <p className="text-[11px] font-mono uppercase tracking-wider text-zinc-500">System & Inspection</p>
                    </div>
                    <div className="py-1">
                      {SYSTEM_NAV.map((item) => (
                        <button
                          key={item.to}
                          type="button"
                          onClick={() => {
                            navigate(item.to);
                            setToolsOpen(false);
                          }}
                          className="w-full text-left rounded-xl px-3 py-2 text-xs hover:bg-zinc-900 transition-colors group flex flex-col"
                        >
                          <span className="font-medium text-zinc-200 group-hover:text-white">{item.label}</span>
                          <span className="text-[11px] text-zinc-500 line-clamp-1">{item.desc}</span>
                        </button>
                      ))}
                    </div>
                    <div className="pt-2 pb-1 px-1">
                      <button
                        type="button"
                        onClick={() => {
                          setDemoOpen(true);
                          setToolsOpen(false);
                        }}
                        className="w-full flex items-center justify-between rounded-xl border border-zinc-800/60 bg-zinc-900/60 px-3 py-2 text-xs text-zinc-300 hover:border-zinc-700 hover:text-white transition-colors"
                      >
                        <span className="flex items-center gap-2">
                          <span className="h-1.5 w-1.5 rounded-full bg-emerald-400" />
                          <span>Simulation Controls</span>
                        </span>
                        <span className="text-[10px] text-zinc-500 font-mono">Open →</span>
                      </button>
                    </div>
                  </div>
                </>
              )}
            </div>

            {/* Quick Simulation Trigger Pill */}
            <button
              type="button"
              onClick={() => setDemoOpen((prev) => !prev)}
              className="flex items-center gap-1.5 rounded-xl border border-zinc-800/80 bg-zinc-950 px-3 py-1.5 text-xs text-zinc-400 hover:border-zinc-700 hover:text-zinc-200 transition-all font-mono"
              title="Toggle learner clock simulation and fault-injection controls"
            >
              <span className="h-1.5 w-1.5 rounded-full bg-emerald-400 animate-pulse" />
              <span className="hidden sm:inline">Sim</span>
            </button>
          </div>
        </div>

        {/* Mobile Navigation Bar */}
        <div className="flex md:hidden items-center gap-1 overflow-x-auto pt-3 border-t border-zinc-900 mt-2">
          {PRIMARY_NAV.map((n) => (
            <NavLink
              key={n.to}
              to={n.to}
              end={n.to === "/"}
              className={({ isActive }) =>
                `rounded-lg px-3 py-1 text-xs font-medium whitespace-nowrap ${
                  isActive ? "bg-zinc-900 text-white" : "text-zinc-500 hover:text-zinc-300"
                }`
              }
            >
              {n.label}
            </NavLink>
          ))}
        </div>
      </header>

      {/* Main Content Viewport */}
      <main className="flex-1 mx-auto w-full max-w-7xl px-6 py-8">{children}</main>

      {/* Controlled Simulation Drawer / Modal */}
      {demoOpen && <DemoPanel studentId={studentId} onReset={() => navigate(0)} onClose={() => setDemoOpen(false)} />}
    </div>
  );
}

export default function App() {
  const { studentId, setStudentId, loading } = useStudentId();
  const [needsLogin, setNeedsLogin] = useState(false);

  useEffect(() => {
    const show = () => setNeedsLogin(true);
    window.addEventListener(UNAUTHENTICATED_EVENT, show);
    return () => window.removeEventListener(UNAUTHENTICATED_EVENT, show);
  }, []);

  if (needsLogin) {
    return <Login onSignedIn={(id) => { setStudentId(id); setNeedsLogin(false); window.location.assign("/"); }} />;
  }

  if (loading) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-black">
        <Loading label="Calibrating Bloom learning workspace…" />
      </div>
    );
  }

  if (!studentId) {
    return (
      <div className="min-h-screen bg-black text-zinc-100 flex items-center justify-center p-6">
        <div className="max-w-md w-full rounded-2xl border border-zinc-900 bg-zinc-950 p-8 space-y-4 text-center">
          <div className="h-10 w-10 mx-auto rounded-xl bg-white text-black flex items-center justify-center font-bold text-lg">
            ✦
          </div>
          <h1 className="text-2xl font-semibold text-white">No Student Profile Found</h1>
          <p className="text-sm text-zinc-400">
            Please run the database seed from the repository backend to create the demo student profile:
          </p>
          <pre className="rounded-xl border border-zinc-900 bg-black p-3 text-xs text-zinc-300 font-mono text-left">
            npm run seed --workspace=backend
          </pre>
          <button
            onClick={() => window.location.reload()}
            className="w-full rounded-xl bg-white py-2.5 text-sm font-semibold text-black hover:bg-zinc-200 transition-colors"
          >
            Refresh Workspace
          </button>
        </div>
      </div>
    );
  }

  return (
    <Shell studentId={studentId}>
      <Routes>
        <Route path="/" element={<Dashboard studentId={studentId} />} />
        <Route path="/onboarding" element={<Onboarding studentId={studentId} onComplete={() => window.location.assign("/")} />} />
        <Route path="/plan" element={<StudyPlan studentId={studentId} />} />
        <Route path="/progress" element={<TopicProgress studentId={studentId} />} />
        <Route path="/library" element={<Library />} />
        <Route path="/tutor" element={<Tutor studentId={studentId} />} />
        <Route path="/assessment" element={<AssessmentScreen studentId={studentId} />} />
        <Route path="/activity" element={<AgentActivity studentId={studentId} />} />
        <Route path="/changes" element={<PlanChanges studentId={studentId} />} />
        <Route path="/eval" element={<Eval />} />
      </Routes>
    </Shell>
  );
}
