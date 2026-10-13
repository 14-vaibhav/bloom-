import { NavLink, Route, Routes, useNavigate } from "react-router-dom";
import { useStudentId } from "./lib/student";
import { Loading } from "./components/ui";
import { DemoPanel } from "./components/DemoPanel";
import { Onboarding } from "./screens/Onboarding";
import { Dashboard } from "./screens/Dashboard";
import { StudyPlan } from "./screens/StudyPlan";
import { TopicProgress } from "./screens/TopicProgress";
import { AssessmentScreen } from "./screens/Assessment";
import { AgentActivity } from "./screens/AgentActivity";
import { PlanChanges } from "./screens/PlanChanges";
import { Eval } from "./screens/Eval";
import { Library } from "./screens/Library";
import { Tutor } from "./screens/Tutor";

const NAV = [
  { to: "/", label: "Dashboard" },
  { to: "/plan", label: "Study Plan" },
  { to: "/progress", label: "Topic Progress" },
  { to: "/library", label: "Library" },
  { to: "/tutor", label: "Tutor" },
  { to: "/assessment", label: "Assessment" },
  { to: "/activity", label: "Agent Activity" },
  { to: "/changes", label: "Plan Changes" },
  { to: "/eval", label: "Eval" },
];

function Shell({ studentId, children }: { studentId: string; children: React.ReactNode }) {
  const navigate = useNavigate();
  return (
    <div className="min-h-screen bg-slate-950 text-slate-100">
      <header className="border-b border-slate-800 px-6 py-3">
        <div className="mx-auto flex max-w-6xl items-center gap-6">
          <span className="text-lg font-semibold">Bloom</span>
          <nav className="flex gap-1 text-sm">
            {NAV.map((n) => (
              <NavLink key={n.to} to={n.to} className={({ isActive }) => `rounded-md px-3 py-1.5 ${isActive ? "bg-slate-800 text-white" : "text-slate-400 hover:text-slate-200"}`}>
                {n.label}
              </NavLink>
            ))}
          </nav>
        </div>
      </header>
      <main className="mx-auto max-w-6xl px-6 py-6">{children}</main>
      <DemoPanel studentId={studentId} onReset={() => navigate(0)} />
    </div>
  );
}

export default function App() {
  const { studentId, loading } = useStudentId();

  if (loading) {
    return <div className="flex min-h-screen items-center justify-center bg-slate-950"><Loading label="Loading Bloom…" /></div>;
  }

  if (!studentId) {
    return (
      <div className="min-h-screen bg-slate-950 text-slate-100">
        <main className="mx-auto max-w-6xl px-6 py-10">
          <NoStudentBootstrap />
        </main>
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

/** No students table row exists yet (a totally empty database, before `npm run seed`
 * has ever run). Bloom has no signup flow — this is a small escape hatch, not a screen
 * the brief asks for, so it only appears when the student list is genuinely empty. */
function NoStudentBootstrap() {
  return (
    <div className="max-w-md space-y-3">
      <h1 className="text-xl font-semibold">No student found</h1>
      <p className="text-sm text-slate-400">Run <code className="rounded bg-slate-800 px-1">npm run seed</code> from the backend to create the demo student, then reload this page.</p>
      <button onClick={() => window.location.reload()} className="rounded-md bg-sky-600 px-4 py-2 text-sm font-medium text-white">Reload</button>
    </div>
  );
}
