"use client";

import { useEffect, useState } from "react";
import { supabase } from "@/lib/supabase/client";

export default function StudentCount() {
  const [count, setCount] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let isMounted = true;

    const loadStudentCount = async () => {
      const {
        data: { session },
        error: sessionError,
      } = await supabase.auth.getSession();

      if (sessionError) {
        if (isMounted) setError(sessionError.message);
        return;
      }

      if (!session) {
        if (isMounted) setError("Sign in to view the student count.");
        return;
      }

      const response = await fetch("/api/student-count", {
        headers: { Authorization: `Bearer ${session.access_token}` },
        cache: "no-store",
      });
      const result: unknown = await response.json();

      if (!isMounted) return;

      if (
        typeof result !== "object" ||
        result === null ||
        !("count" in result) ||
        typeof result.count !== "number" ||
        !Number.isInteger(result.count)
      ) {
        const message =
          typeof result === "object" &&
          result !== null &&
          "error" in result &&
          typeof result.error === "string"
            ? result.error
            : "Supabase did not return a valid student count.";
        setError(message);
        return;
      }

      if (!response.ok) {
        setError("Failed to fetch student count from Supabase.");
        return;
      }

      setCount(result.count);
    };

    void loadStudentCount().catch((cause: unknown) => {
      if (!isMounted) return;
      setError(
        cause instanceof Error ? cause.message : "Failed to fetch student count.",
      );
    });

    return () => {
      isMounted = false;
    };
  }, []);

  if (error) {
    return (
      <span className="mt-3 block text-sm font-medium text-rose-600" role="alert">
        Count unavailable: {error}
      </span>
    );
  }

  return (
    <span className="mt-3 block text-4xl font-semibold tracking-tight text-slate-900">
      {count ?? "…"}
    </span>
  );
}
