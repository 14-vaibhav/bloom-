import { useEffect, useState } from "react";
import { api } from "./api";
import type { Student } from "./types";

const KEY = "bloom.studentId";

/** No auth exists — the id of the one demo student a viewer is looking at is a
 * per-browser convenience, not state Bloom needs to remember, so localStorage
 * is the right place for it (see the artifact/browser-storage convention this
 * mirrors: per-viewer only, never authoritative). */
export function useStudentId(): { studentId: string | null; setStudentId: (id: string) => void; loading: boolean } {
  const [studentId, setId] = useState<string | null>(() => {
    try { return localStorage.getItem(KEY); } catch { return null; }
  });
  const [loading, setLoading] = useState(studentId === null);

  useEffect(() => {
    if (studentId !== null) { setLoading(false); return; }
    let cancelled = false;
    api.get<Student[]>("/students").then((students) => {
      if (cancelled) return;
      if (students.length > 0) setStudentId(students[0].id);
    }).finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [studentId]);

  function setStudentId(id: string) {
    try { localStorage.setItem(KEY, id); } catch { /* private browsing — per-viewer convenience only */ }
    setId(id);
  }

  return { studentId, setStudentId, loading };
}
