"use client";

import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import type { FormEvent } from "react";
import { supabase } from "@/lib/supabase/client";
import { getSchoolByCode, SchoolRecord } from "@/lib/api";

export type LoginMode = "schoolCode" | "credentials";
export type LoginRole = "Principal" | "SuperAdmin" | "Registrar" | "Faculty" | "Student" | "Parent";

/**
 * All state and side-effects for the Login page.
 * Follows Edmatix & MyClassBoard (MCB) architecture:
 * - Clean enterprise cloud login (no school preselected on login page)
 * - Org Code / School Code verification
 * - User enters their credentials & role
 * - After login only does the dashboard load and display the institution details
 */
export function useLoginLogic() {
  const router = useRouter();

  // Mode: "schoolCode" (default) or "credentials"
  const [loginMode, setLoginMode] = useState<LoginMode>("schoolCode");

  // School code / Org Code state - starts EMPTY so public login is unbranded until verified
  const [schoolCode, setSchoolCode] = useState("");
  const [userId, setUserId] = useState("");
  const [userPassword, setUserPassword] = useState("");
  const [selectedRole, setSelectedRole] = useState<LoginRole>("SuperAdmin");
  const [verifiedSchool, setVerifiedSchool] = useState<SchoolRecord | null>(null);
  const [isVerifyingSchool, setIsVerifyingSchool] = useState(false);

  // Direct Email / Password state
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [isCheckingSession, setIsCheckingSession] = useState(true);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [feedback, setFeedback] = useState("");
  const [feedbackType, setFeedbackType] = useState<"error" | "success">("error");

  // ── Check existing session on mount ───────────────────────────
  useEffect(() => {
    let isMounted = true;

    const checkSession = async () => {
      const { data: { session } } = await supabase.auth.getSession();
      if (!isMounted) return;
      if (session) { router.replace("/dashboard"); return; }
      setIsCheckingSession(false);
    };

    checkSession();

    const { data: { subscription } } = supabase.auth.onAuthStateChange((_event, session) => {
      if (session) router.replace("/dashboard");
    });

    return () => { isMounted = false; subscription.unsubscribe(); };
  }, [router]);

  // ── School code validation on change ──────────────────────────
  const handleSchoolCodeChange = async (val: string) => {
    const upper = val.toUpperCase().trim();
    setSchoolCode(upper);
    setFeedback("");

    if (upper.length >= 3) {
      setIsVerifyingSchool(true);
      try {
        const { school } = await getSchoolByCode(upper);
        setVerifiedSchool(school);
      } catch {
        setVerifiedSchool(null);
      } finally {
        setIsVerifyingSchool(false);
      }
    } else {
      setVerifiedSchool(null);
    }
  };

  const handleQuickSchoolSelect = (code: string) => {
    handleSchoolCodeChange(code);
  };

  // ── Enter with School Code / Org Code ─────────────────────────
  const enterWithSchoolCode = async (e: FormEvent) => {
    e.preventDefault();
    if (!schoolCode.trim()) {
      if (selectedRole === "SuperAdmin") {
        if (typeof window !== "undefined") {
          window.sessionStorage.setItem("erp_role", "SuperAdmin");
          window.sessionStorage.setItem("erp_school_code", "ALL");
          window.sessionStorage.setItem("erp_school_name", "My Class Assist Multi-Campus Trust");
          if (userId.trim()) window.sessionStorage.setItem("erp_user_id", userId.trim());
        }
        router.push("/dashboard?role=SuperAdmin&schoolCode=ALL");
        return;
      }
      setFeedback("Please enter your Institution / Organization Code (e.g. RAV).");
      setFeedbackType("error");
      return;
    }

    setIsSubmitting(true);
    setFeedback("");

    try {
      const { school } = await getSchoolByCode(schoolCode);
      // Persist authenticated school & role for session
      if (typeof window !== "undefined") {
        window.sessionStorage.setItem("erp_school_code", school.code);
        window.sessionStorage.setItem("erp_school_name", school.name);
        window.sessionStorage.setItem("erp_role", selectedRole);
        if (userId.trim()) {
          window.sessionStorage.setItem("erp_user_id", userId.trim());
        }
      }
      router.push(`/dashboard?role=${encodeURIComponent(selectedRole)}&schoolCode=${encodeURIComponent(school.code)}`);
    } catch (err) {
      setFeedback(err instanceof Error ? err.message : `School code '${schoolCode}' not recognized.`);
      setFeedbackType("error");
    } finally {
      setIsSubmitting(false);
    }
  };

  // ── Sign In with Supabase ─────────────────────────────────────
  const signIn = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setIsSubmitting(true);
    setFeedback("");

    try {
      const { error } = await supabase.auth.signInWithPassword({ email, password });
      if (error) { setFeedback(error.message); setFeedbackType("error"); return; }
      router.replace("/dashboard");
    } catch (err) {
      setFeedback(err instanceof Error ? err.message : "Unable to sign in. Please try again.");
      setFeedbackType("error");
    } finally {
      setIsSubmitting(false);
    }
  };

  // ── Sign Up with Supabase ─────────────────────────────────────
  const signUp = async () => {
    setIsSubmitting(true);
    setFeedback("");

    try {
      const { error } = await supabase.auth.signUp({ email, password });
      if (error) { setFeedback(error.message); setFeedbackType("error"); return; }
      setFeedback("Account created. Check your email to confirm your address.");
      setFeedbackType("success");
    } catch (err) {
      setFeedback(err instanceof Error ? err.message : "Unable to create your account. Please try again.");
      setFeedbackType("error");
    } finally {
      setIsSubmitting(false);
    }
  };

  return {
    loginMode, setLoginMode,
    schoolCode, setSchoolCode,
    userId, setUserId,
    userPassword, setUserPassword,
    handleSchoolCodeChange,
    handleQuickSchoolSelect,
    selectedRole, setSelectedRole,
    verifiedSchool,
    isVerifyingSchool,
    enterWithSchoolCode,
    email, setEmail,
    password, setPassword,
    isCheckingSession,
    isSubmitting,
    feedback, feedbackType,
    signIn, signUp,
  };
}
