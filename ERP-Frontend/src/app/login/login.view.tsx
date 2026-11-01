"use client";

import Link from "next/link";
import styles from "./login.module.scss";
import { useLoginLogic, LoginRole } from "./login.logic";

/**
 * Login View — pure JSX/HTML.
 * Blue & White Enterprise Theme (Reference: MyClassBoard MCB & Edmatix ERP).
 * On login page: Generic Enterprise Portal.
 * School details appear AFTER login on the dashboard.
 */
export default function LoginView() {
  const {
    loginMode, setLoginMode,
    schoolCode,
    userId, setUserId,
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
  } = useLoginLogic();

  if (isCheckingSession) {
    return (
      <div className={styles.loading}>
        <div className={styles.spinner}>
          <span className={styles.spinIcon} />
          Checking secure session...
        </div>
      </div>
    );
  }

  return (
    <main className={styles.root}>

      {/* ── Left Hero Panel (Blue & White Enterprise Branding) ────── */}
      <section className={styles.hero}>
        <span className={`${styles.glow} ${styles.glowBottom}`} />
        <span className={`${styles.glow} ${styles.glowTop}`} />

        <Link href="/login" className={styles.brand}>
          <div className={styles.brandLogo}>
            M
          </div>
          <div>
            <span className={styles.brandName}>My Class Assist</span>
            <span className={styles.brandSub}>Enterprise Campus Cloud</span>
          </div>
        </Link>

        <div className={styles.heroContent}>
          <div className={styles.heroBadge}>
            <span />
            SECURE CAMPUS CLOUD ERP
          </div>
          <h1 className={styles.heroTitle}>
            Empowering modern
            <span>campus operations.</span>
          </h1>
          <p className={styles.heroDesc}>
            Unified academic administration, admissions CRM, fee ledgers, and student tracking in one intelligent platform.
          </p>

          <div className={styles.avatarRow}>
            <div className={styles.avatars}>
              {["P", "F", "S", "A"].map((initial) => (
                <span key={initial}>{initial}</span>
              ))}
            </div>
            <p className={styles.avatarText}>
              <strong>Multi-Campus Management</strong>
              <br />
              Principals • Faculty • Students • Parents
            </p>
          </div>
        </div>

        <p className={styles.heroFooter}>
          © {new Date().getFullYear()} My Class Assist Enterprise Portal. All rights reserved.
        </p>
      </section>

      {/* ── Right Form Panel (Crisp White Card & Blue Accents) ────── */}
      <section className={styles.formPanel}>
        <div className={styles.formWrap}>

          {/* Mobile brand */}
          <div className={styles.mobileBrand}>
            <Link href="/login" style={{ display: "inline-flex", alignItems: "center", gap: "0.75rem", textDecoration: "none" }}>
              <div style={{
                width: "2.75rem", height: "2.75rem", borderRadius: "0.75rem",
                background: "linear-gradient(135deg, #2563eb, #38bdf8)",
                display: "flex", alignItems: "center", justifyContent: "center",
                color: "#fff", fontWeight: 800, fontSize: "1.25rem",
              }}>
                M
              </div>
              <div>
                <span style={{ display: "block", fontWeight: 800, fontSize: "1.1rem", color: "#0f172a", lineHeight: 1.2 }}>
                  My Class Assist
                </span>
                <span style={{ display: "block", fontSize: "0.72rem", color: "#2563eb", fontWeight: 600 }}>
                  Campus Cloud Portal
                </span>
              </div>
            </Link>
          </div>

          <div className={styles.card}>
            {/* Header */}
            <div className={styles.cardHeader}>
              <p>Institutional Portal</p>
              <h2>Sign in to Campus ERP</h2>
              <small>
                Enter your institution&apos;s Organization Code or sign in with your account credentials.
              </small>
            </div>

            {/* Login Mode Switcher */}
            <div className={styles.loginTabs}>
              <button
                type="button"
                className={`${styles.tabBtn} ${loginMode === "schoolCode" ? styles.tabBtnActive : ""}`}
                onClick={() => setLoginMode("schoolCode")}
              >
                🏢 Org / School Code Access
              </button>
              <button
                type="button"
                className={`${styles.tabBtn} ${loginMode === "credentials" ? styles.tabBtnActive : ""}`}
                onClick={() => setLoginMode("credentials")}
              >
                ✉️ Email Sign-In
              </button>
            </div>

            {/* TAB 1: School Code / Org Code Access (Edmatix & MCB pattern) */}
            {loginMode === "schoolCode" && (
              <form onSubmit={enterWithSchoolCode} className={styles.form}>
                <div className={styles.field}>
                  <label htmlFor="login-school-code">
                    Institution / Organization Code (Org Code)
                    <span style={{ fontSize: "0.75rem", fontWeight: 400, color: "#64748b", marginLeft: "0.35rem" }}>
                      {selectedRole === "SuperAdmin" ? "— Optional for Multi-Campus Admin" : "— e.g. RAV for Ravindra High School"}
                    </span>
                  </label>
                  <input
                    id="login-school-code"
                    type="text"
                    placeholder={selectedRole === "SuperAdmin" ? "Optional: Enter Org Code or leave blank for all campuses" : "Enter Org Code (e.g. RAV)"}
                    value={schoolCode}
                    onChange={(e) => handleSchoolCodeChange(e.target.value)}
                    required={selectedRole !== "SuperAdmin"}
                    maxLength={10}
                    className={`${styles.input} ${styles.schoolCodeInput}`}
                  />
                  <div className={styles.quickSelectRow}>
                    <span style={{ fontSize: "0.72rem", color: "#64748b" }}>Quick demo:</span>
                    <button
                      type="button"
                      onClick={() => handleQuickSchoolSelect("RAV")}
                      className={styles.quickPill}
                    >
                      🏫 Fill &apos;RAV&apos; (Ravindra High School)
                    </button>
                  </div>
                </div>

                {isVerifyingSchool && (
                  <p style={{ fontSize: "0.75rem", color: "#2563eb", fontWeight: 600 }}>Verifying institution code...</p>
                )}

                {/* Institution Verified Box in Blue & White */}
                {verifiedSchool && (
                  <div className={styles.verifiedBadge}>
                    <span style={{ fontSize: "1rem" }}>✓</span>
                    <div>
                      <strong style={{ display: "block", color: "#1e40af" }}>{verifiedSchool.name}</strong>
                      <span style={{ display: "block", fontSize: "0.72rem", color: "#2563eb" }}>
                        Verified Org Code: {verifiedSchool.code} • {verifiedSchool.type || "High School"}
                      </span>
                    </div>
                  </div>
                )}

                {/* User ID / Roll Number (Edmatix / MCB style) */}
                <div className={styles.field}>
                  <label htmlFor="login-user-id">User ID / Admission No (Optional)</label>
                  <input
                    id="login-user-id"
                    type="text"
                    placeholder="e.g. RAVST001 or Employee ID"
                    value={userId}
                    onChange={(e) => setUserId(e.target.value)}
                    className={styles.input}
                  />
                </div>

                {/* Role Selection */}
                <div className={styles.field}>
                  <label htmlFor="login-role-select">Access Portal As</label>
                  <select
                    id="login-role-select"
                    value={selectedRole}
                    onChange={(e) => setSelectedRole(e.target.value as LoginRole)}
                    className={styles.input}
                    style={{ fontWeight: 600, color: "#1e293b" }}
                  >
                    <option value="Principal">School Principal (Campus Head)</option>
                    <option value="SuperAdmin">Trust Super Admin (Multi-Campus Group)</option>
                    <option value="Registrar">Registrar / Administrative Officer</option>
                    <option value="Faculty">Teacher / Faculty</option>
                    <option value="Student">Student Portal</option>
                    <option value="Parent">Parent Portal</option>
                  </select>
                </div>

                {feedback && (
                  <p
                    role="status"
                    aria-live="polite"
                    className={`${styles.feedback} ${feedbackType === "error" ? styles.error : styles.success}`}
                  >
                    {feedback}
                  </p>
                )}

                <button type="submit" disabled={isSubmitting} className={styles.submitBtn}>
                  {isSubmitting
                    ? "Validating & Authenticating..."
                    : `Access Portal as ${
                        selectedRole === "SuperAdmin"
                          ? "Trust Super Admin"
                          : selectedRole === "Principal"
                          ? "School Principal"
                          : selectedRole
                      }`}
                  {!isSubmitting && (
                    <svg viewBox="0 0 20 20" fill="none" style={{ width: "1.1rem", height: "1.1rem" }} aria-hidden="true">
                      <path d="M4 10h12m-5-5 5 5-5 5" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
                    </svg>
                  )}
                </button>
              </form>
            )}

            {/* TAB 2: Email & Password */}
            {loginMode === "credentials" && (
              <>
                <form onSubmit={signIn} className={styles.form}>
                  <div className={styles.field}>
                    <label htmlFor="login-email">Email address</label>
                    <input
                      id="login-email"
                      type="email"
                      autoComplete="email"
                      placeholder="you@school.edu"
                      value={email}
                      onChange={(e) => setEmail(e.target.value)}
                      required
                      className={styles.input}
                    />
                  </div>

                  <div className={styles.field}>
                    <label htmlFor="login-password">Password</label>
                    <input
                      id="login-password"
                      type="password"
                      autoComplete="current-password"
                      placeholder="Enter your password"
                      value={password}
                      onChange={(e) => setPassword(e.target.value)}
                      required
                      className={styles.input}
                    />
                  </div>

                  {feedback && (
                    <p
                      role="status"
                      aria-live="polite"
                      className={`${styles.feedback} ${feedbackType === "error" ? styles.error : styles.success}`}
                    >
                      {feedback}
                    </p>
                  )}

                  <button type="submit" disabled={isSubmitting} className={styles.submitBtn}>
                    {isSubmitting ? "Signing in..." : "Sign in to Console"}
                    {!isSubmitting && (
                      <svg viewBox="0 0 20 20" fill="none" style={{ width: "1.1rem", height: "1.1rem" }} aria-hidden="true">
                        <path d="M4 10h12m-5-5 5 5-5 5" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
                      </svg>
                    )}
                  </button>
                </form>

                {/* Divider + Sign-up */}
                <div className={styles.divider}>
                  <span />
                  <p>New to Campus ERP?</p>
                  <span />
                </div>

                <button
                  type="button"
                  onClick={signUp}
                  disabled={isSubmitting || !email || !password}
                  className={styles.secondaryBtn}
                >
                  {isSubmitting ? "Please wait..." : "Create an Account"}
                </button>
              </>
            )}

            <p className={styles.legalText}>
              By continuing, you agree to your educational group&apos;s terms of service and privacy policy.
            </p>
          </div>
        </div>
      </section>

    </main>
  );
}
