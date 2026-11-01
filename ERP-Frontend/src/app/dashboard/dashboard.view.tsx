"use client";

import { Suspense, useEffect } from "react";
import LogoutButton from "@/components/logout";
import { EnrollStudentModal } from "@/components/enroll-student-modal";
import { RegisterSchoolModal } from "@/components/register-school-modal";
import { ManageSchoolModal } from "@/components/manage-school-modal";
import { ModuleIcon } from "@/components/module-icon";
import { useDashboardLogic, ENTERPRISE_MODULES, EnterpriseModule } from "./dashboard.logic";
import {
  Search,
  XCircle,
  Bell,
  Moon,
  Sun,
  Clock,
  LayoutGrid,
  GraduationCap,
  ShieldCheck,
  Wrench,
  SearchX,
  Users,
  UserCheck,
  Bus,
  CreditCard,
  ArrowRight,
  ArrowUpRight,
  ChevronRight,
  TrendingUp,
  CheckCircle,
  Navigation,
  X,
  AlertTriangle,
  Building2,
  Calendar,
  BookOpen,
  FileCheck,
  Send,
} from "lucide-react";

// ── Suspense wrapper (required for useSearchParams in children) ─
export default function DashboardView() {
  return (
    <Suspense
      fallback={
        <main className="min-h-screen bg-slate-50 dark:bg-slate-950 flex items-center justify-center p-6">
          <p className="text-sm font-semibold text-slate-500 animate-pulse">
            Loading My Class Assist Enterprise Console...
          </p>
        </main>
      }
    >
      <DashboardContent />
    </Suspense>
  );
}

// ── Inner dashboard component ──────────────────────────────────
function DashboardContent() {
  const {
    activeModule, setActiveModule,
    activeRole,
    currentSchool,
    backendHealth,
    stats,
    students,
    searchTerm, setSearchTerm,
    statusFilter, setStatusFilter,
    timetable,
    isLoadingStudents,
    filteredStudents,
    schools,
    isLoadingSchools,
    setSchools,
    isEnrollModalOpen, setIsEnrollModalOpen,
    handleStudentEnrolled,
    handleSchoolRegistered,
    isRegisterSchoolModalOpen, setIsRegisterSchoolModalOpen,
    selectedSchoolToManage,
    isManageSchoolModalOpen, setIsManageSchoolModalOpen,
    openManageModal,
    handleUpdateSchool,
    handleSwitchSchool,

    // EduPulse additions
    searchQuery, setSearchQuery,
    selectedCategory, setSelectedCategory,
    isDarkMode, toggleDarkMode,
    isNotifOpen, setIsNotifOpen,
    activeDetailModule, setActiveDetailModule,
    toasts, addToast,
    currentTime, currentDate, greeting,
  } = useDashboardLogic();

  const isOnline = backendHealth.status === "healthy" || backendHealth.status === "ok";
  const isSuperAdmin = activeRole === "SuperAdmin";
  const isPrincipal = activeRole === "Principal";

  // Global keyboard shortcuts
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === "/" && document.activeElement?.tagName !== "INPUT") {
        e.preventDefault();
        document.getElementById("searchInput")?.focus();
      } else if (e.key === "Escape") {
        setActiveDetailModule(null);
        setIsNotifOpen(false);
      }
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [setActiveDetailModule, setIsNotifOpen]);

  // Filter modules by category and instant search query
  const displayedModules = ENTERPRISE_MODULES.filter((m) => {
    const matchCategory = selectedCategory === "all" || m.category === selectedCategory;
    const matchSearch =
      !searchQuery ||
      m.title.toLowerCase().includes(searchQuery.toLowerCase()) ||
      m.subtitle.toLowerCase().includes(searchQuery.toLowerCase()) ||
      m.description.toLowerCase().includes(searchQuery.toLowerCase());
    return matchCategory && matchSearch;
  });

  const handleLaunchConsole = (mod: EnterpriseModule) => {
    setActiveDetailModule(null);
    if (mod.id === "employee" || mod.id === "class") {
      setActiveModule("sis");
      addToast(`Switched to Student Lifecycle & Staff module`);
    } else if (mod.id === "organization" || mod.id === "admin") {
      setActiveModule("schools");
      addToast(`Switched to Registered Schools Directory`);
    } else if (mod.id === "fee") {
      setActiveModule("finance");
      addToast(`Switched to Fees & Financial Ledger`);
    } else if (mod.id === "campus") {
      setActiveModule("academics");
      addToast(`Switched to Academics & Live Timetable`);
    } else if (mod.id === "front-office") {
      setActiveModule("admissions");
      addToast(`Switched to Admissions & Inquiries CRM`);
    } else {
      addToast(`Launched full console for ${mod.title}`);
    }
  };

  const handleActionClick = (actionName: string) => {
    if (actionName === "Add Employee" || actionName === "Take Attendance") {
      setIsEnrollModalOpen(true);
      setActiveDetailModule(null);
    } else if (actionName === "Register School") {
      setIsRegisterSchoolModalOpen(true);
      setActiveDetailModule(null);
    } else if (actionName === "Manage Schools") {
      setActiveModule("schools");
      setActiveDetailModule(null);
    } else if (actionName === "Process Payment" || actionName === "Generate Invoice") {
      setActiveModule("finance");
      setActiveDetailModule(null);
    } else {
      addToast(`Action executed: ${actionName}`);
    }
  };

  return (
    <div className="bg-slate-50 dark:bg-slate-950 text-slate-800 dark:text-slate-100 min-h-screen flex flex-col transition-colors duration-300 relative">

      {/* ── Ambient Background Lighting ───────────────────── */}
      <div className="fixed inset-0 overflow-hidden pointer-events-none z-0">
        <div className="absolute -top-40 -left-40 w-96 h-96 bg-[#0294CE]/10 rounded-full blur-3xl" />
        <div className="absolute top-1/3 -right-20 w-96 h-96 bg-[#0EA5E9]/10 rounded-full blur-3xl" />
        <div className="absolute -bottom-40 left-1/3 w-96 h-96 bg-[#E53A35]/5 rounded-full blur-3xl" />
      </div>

      {/* ── Header Navigation (Role-Based Display After Login) ── */}
      <header className="sticky top-0 z-30 glass-panel border-b border-slate-200/60 dark:border-slate-800/80 px-4 lg:px-8 py-3">
        <div className="max-w-7xl mx-auto flex items-center justify-between gap-4">

          {/* Left Brand Area */}
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 rounded-2xl bg-gradient-to-tr from-[#0294CE] to-[#1E40AF] flex items-center justify-center text-white shadow-lg shadow-[#0294CE]/20 font-extrabold text-lg select-none shrink-0">
              {isSuperAdmin ? "🌐" : "🏫"}
            </div>
            <div>
              <div className="flex items-center gap-2">
                <span className="font-extrabold text-sm sm:text-base tracking-tight text-slate-900 dark:text-white leading-tight">
                  {isSuperAdmin ? "My Class Assist Group Administration" : currentSchool.name}
                </span>
                <span className="font-mono text-[11px] font-extrabold px-2 py-0.5 rounded-md bg-[#0294CE]/10 text-[#0294CE] dark:text-sky-300 border border-[#0294CE]/20">
                  {isSuperAdmin ? "SUPERADMIN" : currentSchool.code}
                </span>
              </div>
              <div className="text-[11px] text-slate-500 dark:text-slate-400 font-medium flex items-center gap-2 mt-0.5">
                {isSuperAdmin ? (
                  <>
                    <span>Multi-Campus Trust Network</span>
                    <span>•</span>
                    <span className="text-[#0294CE] font-semibold">{schools.length} Affiliated Institutions</span>
                  </>
                ) : (
                  <>
                    <span>Session 2024–2025</span>
                    <span>•</span>
                    <span className="text-sky-600 dark:text-sky-400 font-semibold flex items-center gap-1">
                      <span className="w-1.5 h-1.5 rounded-full bg-sky-500 animate-pulse" />
                      Active Campus Portal
                    </span>
                  </>
                )}
              </div>
            </div>
          </div>

          {/* Instant Search Bar */}
          <div className="flex-1 max-w-lg mx-2 sm:mx-6">
            <div className="relative">
              <Search className="absolute left-3.5 top-1/2 -translate-y-1/2 w-4 h-4 text-slate-400" />
              <input
                type="text"
                id="searchInput"
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                placeholder="Search modules, records, services... (Press '/' to search)"
                className="w-full pl-10 pr-10 py-2 text-sm rounded-2xl border border-slate-200 dark:border-slate-700/80 bg-white/90 dark:bg-slate-900/90 focus:outline-none focus:ring-2 focus:ring-[#0294CE] text-slate-800 dark:text-white placeholder-slate-400 transition-all shadow-sm"
              />
              {searchQuery && (
                <button
                  type="button"
                  onClick={() => setSearchQuery("")}
                  className="absolute right-3 top-1/2 -translate-y-1/2 text-slate-400 hover:text-slate-600 dark:hover:text-slate-200"
                >
                  <XCircle className="w-4 h-4" />
                </button>
              )}
            </div>
          </div>

          {/* Profile & Header Actions */}
          <div className="flex items-center gap-2 sm:gap-3 shrink-0">
            {/* Backend health status pill */}
            <div
              className={`hidden md:inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-[11px] font-semibold border ${
                isOnline
                  ? "bg-sky-50 dark:bg-sky-950/30 text-sky-700 dark:text-emerald-300 border-sky-200 dark:border-emerald-800"
                  : "bg-amber-50 dark:bg-amber-950/30 text-amber-700 dark:text-amber-300 border-amber-200 dark:border-amber-800"
              }`}
            >
              <span className={`w-2 h-2 rounded-full ${isOnline ? "bg-sky-500 animate-pulse" : "bg-amber-500"}`} />
              API: {isOnline ? "Online (Port 5000)" : "Fallback"}
            </div>

            {/* Notifications button */}
            <div className="relative">
              <button
                type="button"
                onClick={() => setIsNotifOpen((v) => !v)}
                className="p-2.5 rounded-2xl text-slate-600 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-800 transition relative"
                aria-label="Notifications"
              >
                <Bell className="w-5 h-5" />
                <span className="absolute top-2 right-2 w-2.5 h-2.5 rounded-full bg-[#E53A35] ring-2 ring-white dark:ring-slate-900" />
              </button>

              {/* Notifications Dropdown */}
              {isNotifOpen && (
                <div className="absolute right-0 mt-2 w-80 sm:w-88 glass-panel bg-white dark:bg-slate-900 rounded-2xl shadow-2xl border border-slate-200 dark:border-slate-800 z-50 p-4">
                  <div className="flex items-center justify-between pb-3 border-b border-slate-100 dark:border-slate-800">
                    <h4 className="font-bold text-sm text-slate-900 dark:text-white">Alerts & System Activity</h4>
                    <span className="text-[10px] font-bold px-2 py-0.5 rounded-full bg-[#E53A35]/10 text-[#E53A35]">
                      2 Urgent
                    </span>
                  </div>
                  <div className="py-2 space-y-2.5 max-h-64 overflow-y-auto">
                    <div className="p-2.5 rounded-xl bg-red-50/50 dark:bg-red-950/20 border border-red-100 dark:border-red-900/30 flex items-start gap-2.5">
                      <AlertTriangle className="w-4 h-4 text-[#E53A35] shrink-0 mt-0.5" />
                      <div>
                        <p className="text-xs font-semibold text-slate-800 dark:text-slate-200">Fee Payment Overdue</p>
                        <p className="text-[11px] text-slate-500 dark:text-slate-400">14 Q3 tuition invoices require follow-up.</p>
                      </div>
                    </div>
                    <div className="p-2.5 rounded-xl bg-blue-50/50 dark:bg-blue-950/20 border border-blue-100 dark:border-blue-900/30 flex items-start gap-2.5">
                      <Bus className="w-4 h-4 text-[#0294CE] shrink-0 mt-0.5" />
                      <div>
                        <p className="text-xs font-semibold text-slate-800 dark:text-slate-200">Fleet Route Route-4 Update</p>
                        <p className="text-[11px] text-slate-500 dark:text-slate-400">Bus #04 maintenance completed successfully.</p>
                      </div>
                    </div>
                  </div>
                </div>
              )}
            </div>

            {/* Dark/Light Theme Switcher */}
            <button
              type="button"
              onClick={toggleDarkMode}
              className="p-2.5 rounded-2xl text-slate-600 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-800 transition"
              aria-label="Toggle Theme"
            >
              {isDarkMode ? <Sun className="w-5 h-5 text-amber-400" /> : <Moon className="w-5 h-5" />}
            </button>

            {/* Authenticated Role Badge (Fixed from login session — no dropdown) */}
            <div className="hidden sm:flex items-center px-3 py-1 rounded-full text-xs font-bold bg-[#0294CE]/10 text-[#0294CE] dark:text-sky-400 border border-[#0294CE]/20 select-none">
              <span>{isSuperAdmin ? "Super Admin" : isPrincipal ? "School Principal" : activeRole}</span>
            </div>

            <div className="h-6 w-px bg-slate-200 dark:bg-slate-800 mx-1" />

            {/* User Profile */}
            <div className="flex items-center gap-3">
              <img
                src="https://images.unsplash.com/photo-1534528741775-53994a69daeb?auto=format&fit=crop&q=80&w=120"
                alt="Profile Avatar"
                className="w-9 h-9 rounded-2xl object-cover ring-2 ring-[#0294CE]/40"
              />
              <div className="hidden sm:block text-left">
                <div className="text-sm font-bold text-slate-900 dark:text-slate-100 leading-none">
                  {isPrincipal ? "Dr. R. K. Sharma" : "Super Administrator"}
                </div>
                <div className="text-[11px] font-semibold text-[#0294CE] dark:text-sky-400 mt-1">
                  {isPrincipal ? "Principal Desk" : "Group Super Admin"}
                </div>
              </div>
            </div>

            <LogoutButton />
          </div>

        </div>
      </header>

      {/* ── Role-Specific Sub-Navigation Bar ─────────────────── */}
      <div className="max-w-7xl mx-auto px-4 lg:px-8 pt-4 pb-0 flex items-center justify-between gap-2 overflow-x-auto no-scrollbar">
        <div className="flex items-center gap-2">
          {isSuperAdmin ? (
            /* SuperAdmin Sub-Navigation */
            <>
              <button
                type="button"
                onClick={() => setActiveModule("dashboard")}
                className={`px-4 py-2 rounded-xl text-xs font-bold transition flex items-center gap-1.5 ${
                  activeModule === "dashboard"
                    ? "bg-slate-900 dark:bg-white text-white dark:text-slate-900 shadow-md"
                    : "bg-white dark:bg-slate-900 text-slate-600 dark:text-slate-300 border border-slate-200 dark:border-slate-800 hover:bg-slate-100"
                }`}
              >
                <LayoutGrid className="w-3.5 h-3.5" /> Group Command Center
              </button>
              <button
                type="button"
                onClick={() => setActiveModule("schools")}
                className={`px-4 py-2 rounded-xl text-xs font-bold transition flex items-center gap-1.5 ${
                  activeModule === "schools"
                    ? "bg-[#0294CE] text-white shadow-md shadow-[#0294CE]/20"
                    : "bg-white dark:bg-slate-900 text-slate-600 dark:text-slate-300 border border-slate-200 dark:border-slate-800 hover:bg-slate-100"
                }`}
              >
                🏫 Registered Schools Directory ({schools.length})
              </button>
              <button
                type="button"
                onClick={() => setActiveModule("finance")}
                className={`px-4 py-2 rounded-xl text-xs font-bold transition flex items-center gap-1.5 ${
                  activeModule === "finance"
                    ? "bg-[#E53A35] text-white shadow-md shadow-[#E53A35]/20"
                    : "bg-white dark:bg-slate-900 text-slate-600 dark:text-slate-300 border border-slate-200 dark:border-slate-800 hover:bg-slate-100"
                }`}
              >
                <CreditCard className="w-3.5 h-3.5" /> Multi-Campus Fee Ledger
              </button>
            </>
          ) : (
            /* Principal Sub-Navigation */
            <>
              <button
                type="button"
                onClick={() => setActiveModule("dashboard")}
                className={`px-4 py-2 rounded-xl text-xs font-bold transition flex items-center gap-1.5 ${
                  activeModule === "dashboard"
                    ? "bg-[#0294CE] text-white shadow-md shadow-[#0294CE]/20"
                    : "bg-white dark:bg-slate-900 text-slate-600 dark:text-slate-300 border border-slate-200 dark:border-slate-800 hover:bg-slate-100"
                }`}
              >
                <Building2 className="w-3.5 h-3.5" /> Principal Overview
              </button>
              <button
                type="button"
                onClick={() => setActiveModule("sis")}
                className={`px-4 py-2 rounded-xl text-xs font-bold transition flex items-center gap-1.5 ${
                  activeModule === "sis"
                    ? "bg-[#0EA5E9] text-white shadow-md shadow-[#0EA5E9]/20"
                    : "bg-white dark:bg-slate-900 text-slate-600 dark:text-slate-300 border border-slate-200 dark:border-slate-800 hover:bg-slate-100"
                }`}
              >
                <GraduationCap className="w-3.5 h-3.5" /> Student SIS ({students.length})
              </button>
              <button
                type="button"
                onClick={() => setActiveModule("academics")}
                className={`px-4 py-2 rounded-xl text-xs font-bold transition flex items-center gap-1.5 ${
                  activeModule === "academics"
                    ? "bg-[#2563eb] text-white shadow-md shadow-[#2563eb]/20"
                    : "bg-white dark:bg-slate-900 text-slate-600 dark:text-slate-300 border border-slate-200 dark:border-slate-800 hover:bg-slate-100"
                }`}
              >
                <Calendar className="w-3.5 h-3.5" /> Timetable & Faculty Rosters
              </button>
              <button
                type="button"
                onClick={() => setActiveModule("finance")}
                className={`px-4 py-2 rounded-xl text-xs font-bold transition flex items-center gap-1.5 ${
                  activeModule === "finance"
                    ? "bg-[#E53A35] text-white shadow-md shadow-[#E53A35]/20"
                    : "bg-white dark:bg-slate-900 text-slate-600 dark:text-slate-300 border border-slate-200 dark:border-slate-800 hover:bg-slate-100"
                }`}
              >
                <CreditCard className="w-3.5 h-3.5" /> Campus Fee Collection
              </button>
            </>
          )}
        </div>

        {/* Role-Specific Quick Actions */}
        <div className="flex items-center gap-2 shrink-0">
          {isSuperAdmin && (
            <button
              type="button"
              onClick={() => setIsRegisterSchoolModalOpen(true)}
              className="px-3.5 py-1.5 rounded-xl bg-[#0294CE] hover:bg-sky-600 text-white font-bold text-xs shadow-sm flex items-center gap-1.5 transition"
            >
              🏫 Register New School
            </button>
          )}
          {isPrincipal && (
            <>
              <button
                type="button"
                onClick={() => setIsEnrollModalOpen(true)}
                className="px-3.5 py-1.5 rounded-xl bg-[#0EA5E9] hover:bg-sky-600 text-white font-bold text-xs shadow-sm flex items-center gap-1.5 transition"
              >
                + Enroll Student ({currentSchool.code}ST)
              </button>
              <button
                type="button"
                onClick={() => addToast(`Circular sent to all parents of ${currentSchool.name}`)}
                className="px-3.5 py-1.5 rounded-xl bg-[#2563eb] hover:bg-blue-700 text-white font-bold text-xs shadow-sm flex items-center gap-1.5 transition"
              >
                <Send className="w-3 h-3" /> Send Circular
              </button>
            </>
          )}
        </div>
      </div>

      {/* ── Main Content Shell ────────────────────────────── */}
      <main className="relative z-10 max-w-7xl mx-auto px-4 lg:px-8 py-6 space-y-8 flex-1 w-full">

        {/* ── DASHBOARD VIEW (Differentiated by Role) ─────────── */}
        {activeModule === "dashboard" && (
          <>
            {/* Welcome Banner with Dynamic Clock */}
            <section className="glass-panel rounded-3xl p-6 sm:p-8 relative overflow-hidden shadow-glass border border-white/80 dark:border-slate-800">
              <div className="relative z-10 flex flex-col md:flex-row md:items-center justify-between gap-6">
                <div>
                  <div className="inline-flex items-center gap-2 px-3 py-1 rounded-full bg-[#0294CE]/10 text-[#0294CE] dark:text-sky-400 text-xs font-bold mb-3">
                    <span className="w-2 h-2 rounded-full bg-[#0294CE] animate-ping" />
                    {isSuperAdmin ? "Group Trust Administration Active" : `Principal Console Active: ${currentSchool.name}`}
                  </div>
                  <h1 className="text-2xl sm:text-4xl font-extrabold tracking-tight text-slate-900 dark:text-white">
                    {greeting}
                  </h1>
                  <p className="text-slate-500 dark:text-slate-400 mt-1.5 text-sm sm:text-base max-w-xl">
                    {isSuperAdmin
                      ? "Multi-Campus Trust Command Center. Monitor registered schools, audit global fee revenues, and configure group governance."
                      : `Welcome to the Executive Principal Console for ${currentSchool.name}. Monitor daily student attendance, faculty duty rosters, live timetable schedules, and campus collections.`}
                  </p>
                </div>

                {/* Live Clock & Date Badge */}
                <div className="bg-white/80 dark:bg-slate-900/80 rounded-2xl p-4 sm:p-5 border border-slate-200/80 dark:border-slate-700/80 shadow-sm flex items-center gap-4 shrink-0">
                  <div className="p-3 rounded-2xl bg-[#0294CE]/10 text-[#0294CE]">
                    <Clock className="w-6 h-6" />
                  </div>
                  <div>
                    <div className="text-2xl font-extrabold text-slate-900 dark:text-white tracking-tight font-mono">
                      {currentTime}
                    </div>
                    <div className="text-xs font-semibold text-[#0294CE] dark:text-sky-400 mt-0.5">
                      {currentDate}
                    </div>
                  </div>
                </div>
              </div>
            </section>

            {/* PRINCIPAL-SPECIFIC: Executive Daily Briefing Bar */}
            {isPrincipal && (
              <section className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
                <div className="glass-panel p-4 rounded-2xl border border-sky-200 dark:border-emerald-900/40 bg-sky-50/40 dark:bg-sky-950/20">
                  <span className="text-[11px] font-bold uppercase text-sky-700 dark:text-emerald-300">Today&apos;s Attendance</span>
                  <div className="text-2xl font-extrabold text-sky-800 dark:text-emerald-200 mt-0.5">96.4%</div>
                  <p className="text-xs text-sky-600 mt-0.5">1,205 Present • 45 Absent</p>
                </div>
                <div className="glass-panel p-4 rounded-2xl border border-sky-200 dark:border-sky-900/40 bg-sky-50/40 dark:bg-sky-950/20">
                  <span className="text-[11px] font-bold uppercase text-sky-700 dark:text-sky-300">Faculty On-Duty</span>
                  <div className="text-2xl font-extrabold text-sky-800 dark:text-sky-200 mt-0.5">42 / 46</div>
                  <p className="text-xs text-sky-600 mt-0.5">4 On Leave • 2 Substitutions Set</p>
                </div>
                <div className="glass-panel p-4 rounded-2xl border border-blue-200 dark:border-blue-900/40 bg-blue-50/40 dark:bg-blue-950/20">
                  <span className="text-[11px] font-bold uppercase text-blue-700 dark:text-blue-300">Today&apos;s Collections</span>
                  <div className="text-2xl font-extrabold text-blue-800 dark:text-blue-200 mt-0.5">₹ 1.84 L</div>
                  <p className="text-xs text-blue-600 mt-0.5">Counter & Online Fee Inflows</p>
                </div>
                <div className="glass-panel p-4 rounded-2xl border border-purple-200 dark:border-purple-900/40 bg-purple-50/40 dark:bg-purple-950/20">
                  <span className="text-[11px] font-bold uppercase text-purple-700 dark:text-purple-300">Class Schedule</span>
                  <div className="text-2xl font-extrabold text-purple-800 dark:text-purple-200 mt-0.5">Period 4</div>
                  <p className="text-xs text-purple-600 mt-0.5">Science & Computer Lab Active</p>
                </div>
              </section>
            )}

            {/* SUPERADMIN-SPECIFIC: Network Multi-Campus Directory Widget */}
            {isSuperAdmin && (
              <section className="glass-panel rounded-3xl p-6 shadow-glass border border-white/80 dark:border-slate-800 space-y-4">
                <div className="flex items-center justify-between pb-3 border-b border-slate-100 dark:border-slate-800">
                  <div>
                    <h3 className="text-lg font-extrabold text-slate-900 dark:text-white">
                      Affiliated Educational Institutions ({schools.length})
                    </h3>
                    <p className="text-xs text-slate-500">Each campus has an independent database partition and Org Code.</p>
                  </div>
                  <button
                    type="button"
                    onClick={() => setIsRegisterSchoolModalOpen(true)}
                    className="px-4 py-2 rounded-xl bg-[#0294CE] hover:bg-sky-600 text-white font-bold text-xs shadow-sm transition"
                  >
                    + Add Campus
                  </button>
                </div>

                <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
                  {schools.map((school) => (
                    <div key={school.id} className="p-4 rounded-2xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 flex flex-col justify-between">
                      <div className="flex items-center justify-between">
                        <div>
                          <h4 className="font-bold text-sm text-slate-900 dark:text-white">{school.name}</h4>
                          <span className="text-xs text-slate-400">{school.city || "Bangalore"} • {school.type || "High School"}</span>
                        </div>
                        <span className="px-2.5 py-1 rounded-md bg-teal-50 dark:bg-teal-950/40 text-teal-700 dark:text-teal-300 font-mono font-extrabold text-xs">
                          {school.code}
                        </span>
                      </div>
                      <div className="mt-4 pt-3 border-t border-slate-100 dark:border-slate-800 flex items-center justify-between">
                        <button
                          type="button"
                          onClick={() => openManageModal(school)}
                          className="text-xs font-bold text-[#0294CE] hover:underline"
                        >
                          Manage Credentials
                        </button>
                        <button
                          type="button"
                          onClick={() => handleSwitchSchool(school)}
                          className="px-3 py-1 rounded-lg bg-slate-100 dark:bg-slate-800 text-xs font-bold hover:bg-slate-200"
                        >
                          Inspect Campus →
                        </button>
                      </div>
                    </div>
                  ))}
                </div>
              </section>
            )}

            {/* Category Tab Navigation */}
            <div className="flex items-center gap-2 overflow-x-auto pb-1 no-scrollbar">
              <button
                type="button"
                onClick={() => setSelectedCategory("all")}
                className={`category-tab px-5 py-2.5 rounded-2xl text-xs font-bold transition flex items-center gap-2 ${
                  selectedCategory === "all"
                    ? "bg-[#0294CE] text-white shadow-lg shadow-[#0294CE]/25"
                    : "bg-white dark:bg-slate-900 text-slate-600 dark:text-slate-300 hover:bg-slate-100 border border-slate-200 dark:border-slate-800"
                }`}
              >
                <LayoutGrid className="w-3.5 h-3.5" /> All Modules ({ENTERPRISE_MODULES.length})
              </button>
              <button
                type="button"
                onClick={() => setSelectedCategory("Academic")}
                className={`category-tab px-5 py-2.5 rounded-2xl text-xs font-bold transition flex items-center gap-2 ${
                  selectedCategory === "Academic"
                    ? "bg-[#0294CE] text-white shadow-lg shadow-[#0294CE]/25"
                    : "bg-white dark:bg-slate-900 text-slate-600 dark:text-slate-300 hover:bg-slate-100 border border-slate-200 dark:border-slate-800"
                }`}
              >
                <GraduationCap className="w-3.5 h-3.5 text-[#0EA5E9]" /> Academic & Life
              </button>
              <button
                type="button"
                onClick={() => setSelectedCategory("Operations")}
                className={`category-tab px-5 py-2.5 rounded-2xl text-xs font-bold transition flex items-center gap-2 ${
                  selectedCategory === "Operations"
                    ? "bg-[#0294CE] text-white shadow-lg shadow-[#0294CE]/25"
                    : "bg-white dark:bg-slate-900 text-slate-600 dark:text-slate-300 hover:bg-slate-100 border border-slate-200 dark:border-slate-800"
                }`}
              >
                <ShieldCheck className="w-3.5 h-3.5 text-[#0294CE]" /> Operations
              </button>
              <button
                type="button"
                onClick={() => setSelectedCategory("Services")}
                className={`category-tab px-5 py-2.5 rounded-2xl text-xs font-bold transition flex items-center gap-2 ${
                  selectedCategory === "Services"
                    ? "bg-[#0294CE] text-white shadow-lg shadow-[#0294CE]/25"
                    : "bg-white dark:bg-slate-900 text-slate-600 dark:text-slate-300 hover:bg-slate-100 border border-slate-200 dark:border-slate-800"
                }`}
              >
                <Wrench className="w-3.5 h-3.5 text-[#E53A35]" /> Services & Logistics
              </button>
            </div>

            {/* Module Cards Grid */}
            <section>
              {displayedModules.length === 0 ? (
                <div className="text-center py-16 glass-panel rounded-3xl">
                  <SearchX className="w-12 h-12 text-slate-400 mx-auto mb-3" />
                  <h3 className="text-base font-bold text-slate-800 dark:text-slate-200">No matching modules found</h3>
                  <p className="text-xs text-slate-500 mt-1">Try searching for terms like &quot;Fee&quot;, &quot;Class&quot;, &quot;Fleet&quot;, or &quot;Library&quot;</p>
                  <button
                    type="button"
                    onClick={() => {
                      setSearchQuery("");
                      setSelectedCategory("all");
                    }}
                    className="mt-4 px-4 py-2 bg-[#0294CE] text-white font-semibold text-xs rounded-xl shadow-md"
                  >
                    Reset Search
                  </button>
                </div>
              ) : (
                <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5 gap-4 sm:gap-5">
                  {displayedModules.map((mod) => {
                    const isRedBadge = mod.badgeType === "red";
                    const badgeBg = isRedBadge
                      ? "bg-[#E53A35]/10 text-[#E53A35]"
                      : "bg-[#0EA5E9]/10 text-[#0EA5E9] dark:text-sky-400";

                    return (
                      <div
                        key={mod.id}
                        onClick={() => setActiveDetailModule(mod)}
                        className={`glass-panel card-top-indicator ${
                          isRedBadge ? "alert-card" : ""
                        } rounded-2xl p-5 flex flex-col justify-between cursor-pointer group hover:-translate-y-1.5 transition-all duration-300 shadow-glass hover:shadow-glass-hover border border-white/80 dark:border-slate-800/80 relative`}
                      >
                        <div>
                          {/* Top Row: Badge & Arrow */}
                          <div className="flex items-center justify-between gap-2 mb-3">
                            <span className={`text-[10px] font-extrabold px-2.5 py-0.5 rounded-full ${badgeBg} truncate`}>
                              {mod.badge}
                            </span>
                            <ArrowUpRight className="w-4 h-4 text-slate-300 dark:text-slate-600 group-hover:text-[#0294CE] transition-colors" />
                          </div>

                          {/* Center Icon */}
                          <div
                            className="w-12 h-12 rounded-2xl flex items-center justify-center my-2 transition-all duration-300 group-hover:scale-110 shadow-sm"
                            style={{
                              backgroundColor: isRedBadge ? "#E53A3515" : "#0294CE15",
                              color: isRedBadge ? "#E53A35" : "#0294CE",
                            }}
                          >
                            <ModuleIcon name={mod.icon} className="w-6 h-6" />
                          </div>

                          {/* Card Titles */}
                          <h3 className="font-bold text-slate-900 dark:text-slate-100 text-base group-hover:text-[#0294CE] transition-colors">
                            {mod.title}
                          </h3>
                          <p className="text-xs font-semibold text-slate-400 dark:text-slate-500 mb-2">
                            {mod.subtitle}
                          </p>

                          {/* Description Snippet */}
                          <p className="text-xs text-slate-500 dark:text-slate-400 line-clamp-2 leading-relaxed">
                            {mod.description}
                          </p>
                        </div>

                        {/* Bottom Action Link */}
                        <div className="mt-4 pt-3 border-t border-slate-100 dark:border-slate-800/80 flex items-center justify-between text-xs font-bold text-[#0294CE]">
                          <span>Access Portal</span>
                          <ChevronRight className="w-3.5 h-3.5 group-hover:translate-x-1 transition-transform" />
                        </div>
                      </div>
                    );
                  })}
                </div>
              )}
            </section>

            {/* Quick Stats Widgets Row */}
            <section className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-5">
              {/* Active Students Stat */}
              <div className="glass-panel rounded-2xl p-5 shadow-glass relative overflow-hidden flex items-center gap-4">
                <div className="w-12 h-12 rounded-2xl bg-[#0EA5E9]/10 text-[#0EA5E9] dark:text-sky-400 flex items-center justify-center shrink-0">
                  <Users className="w-6 h-6" />
                </div>
                <div>
                  <div className="text-xs font-bold uppercase tracking-wider text-slate-400">
                    {isPrincipal ? "Enrolled Students" : "Total Network Students"}
                  </div>
                  <div className="text-2xl font-extrabold text-slate-900 dark:text-white mt-0.5">
                    {stats.totalStudents ? stats.totalStudents.toLocaleString() : "1,250"}
                  </div>
                  <span className="inline-flex items-center gap-1 text-[11px] font-bold text-[#0EA5E9] dark:text-sky-400">
                    <TrendingUp className="w-3 h-3" /> {stats.attendanceRate || "96.4%"} Attendance
                  </span>
                </div>
              </div>

              {/* Staff Present Stat */}
              <div className="glass-panel rounded-2xl p-5 shadow-glass relative overflow-hidden flex items-center gap-4">
                <div className="w-12 h-12 rounded-2xl bg-[#0294CE]/10 text-[#0294CE] flex items-center justify-center shrink-0">
                  <UserCheck className="w-6 h-6" />
                </div>
                <div>
                  <div className="text-xs font-bold uppercase tracking-wider text-slate-400">Faculty Present</div>
                  <div className="text-2xl font-extrabold text-slate-900 dark:text-white mt-0.5">
                    {stats.totalFaculty ? `${stats.totalFaculty} Teachers` : "42 / 46"}
                  </div>
                  <span className="inline-flex items-center gap-1 text-[11px] font-bold text-[#0294CE]">
                    <CheckCircle className="w-3 h-3" /> 96.8% Duty Rate
                  </span>
                </div>
              </div>

              {/* Transport Fleet Status Stat */}
              <div className="glass-panel rounded-2xl p-5 shadow-glass relative overflow-hidden flex items-center gap-4">
                <div className="w-12 h-12 rounded-2xl bg-[#0294CE]/10 text-[#0294CE] flex items-center justify-center shrink-0">
                  <Bus className="w-6 h-6" />
                </div>
                <div>
                  <div className="text-xs font-bold uppercase tracking-wider text-slate-400">Fleet Active</div>
                  <div className="text-2xl font-extrabold text-slate-900 dark:text-white mt-0.5">18 Routes</div>
                  <span className="inline-flex items-center gap-1 text-[11px] font-bold text-[#0EA5E9] dark:text-sky-400">
                    <Navigation className="w-3 h-3" /> Live GPS Tracking
                  </span>
                </div>
              </div>

              {/* Fee Pending Alert Stat */}
              <div className="glass-panel rounded-2xl p-5 shadow-glass relative overflow-hidden flex items-center gap-4 border-l-4 border-l-[#E53A35]">
                <div className="w-12 h-12 rounded-2xl bg-[#E53A35]/10 text-[#E53A35] flex items-center justify-center shrink-0">
                  <CreditCard className="w-6 h-6" />
                </div>
                <div>
                  <div className="text-xs font-bold uppercase tracking-wider text-slate-400">Pending Fees</div>
                  <div className="text-2xl font-extrabold text-[#E53A35] mt-0.5">14 Overdue</div>
                  <button
                    type="button"
                    onClick={() => {
                      const feeMod = ENTERPRISE_MODULES.find((m) => m.id === "fee");
                      if (feeMod) setActiveDetailModule(feeMod);
                    }}
                    className="text-[11px] font-bold text-[#0294CE] hover:underline flex items-center gap-0.5 mt-0.5"
                  >
                    Resolve Invoices <ArrowRight className="w-3 h-3" />
                  </button>
                </div>
              </div>
            </section>
          </>
        )}

        {/* ── SECTION B: REGISTERED SCHOOLS (SuperAdmin Only) ─── */}
        {activeModule === "schools" && isSuperAdmin && (
          <div className="space-y-6">
            <div className="glass-panel rounded-3xl p-6 sm:p-8 shadow-glass border border-white/80 dark:border-slate-800">
              <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 pb-6 border-b border-slate-100 dark:border-slate-800">
                <div>
                  <h2 className="text-xl sm:text-2xl font-extrabold text-slate-900 dark:text-white">
                    Registered Schools Network (SuperAdmin Directory)
                  </h2>
                  <p className="text-xs sm:text-sm text-slate-500 dark:text-slate-400 mt-1">
                    Every school registered is saved to the database. Principals and staff login using their unique School Code.
                  </p>
                </div>
                <button
                  type="button"
                  onClick={() => setIsRegisterSchoolModalOpen(true)}
                  className="px-5 py-2.5 rounded-2xl bg-[#0294CE] hover:bg-sky-600 text-white font-bold text-xs shadow-md transition shrink-0"
                >
                  + Register New School
                </button>
              </div>

              {isLoadingSchools ? (
                <div className="py-16 text-center text-slate-400 text-sm">
                  Fetching registered schools from database...
                </div>
              ) : schools.length === 0 ? (
                <div className="py-16 text-center">
                  <div className="text-3xl mb-2">🏫</div>
                  <h3 className="font-bold text-slate-800 dark:text-slate-200 text-sm">No schools registered yet</h3>
                  <p className="text-xs text-slate-400 mt-1">Click &quot;+ Register New School&quot; to add an institution to the database.</p>
                </div>
              ) : (
                <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-5 mt-6">
                  {schools.map((school) => (
                    <div
                      key={school.id}
                      className="bg-white dark:bg-slate-900 rounded-2xl border border-slate-200 dark:border-slate-800 shadow-sm overflow-hidden flex flex-col justify-between"
                    >
                      {/* Top banner */}
                      <div className="bg-gradient-to-r from-slate-900 to-slate-800 text-white p-4 flex items-center justify-between">
                        <div className="flex items-center gap-3">
                          <div className="w-10 h-10 rounded-xl bg-white/10 flex items-center justify-center text-lg">
                            🏫
                          </div>
                          <div>
                            <h4 className="font-bold text-sm text-white leading-tight">{school.name}</h4>
                            <span className="text-[11px] text-slate-400">{school.type || "High School"}</span>
                          </div>
                        </div>
                        <span className="px-2.5 py-1 rounded-lg bg-teal-400 text-slate-950 font-mono font-extrabold text-xs">
                          {school.code}
                        </span>
                      </div>

                      {/* Body metrics */}
                      <div className="p-4 space-y-4">
                        <div className="grid grid-cols-3 gap-2 text-center">
                          <div className="p-2 rounded-xl bg-sky-50 dark:bg-sky-950/20">
                            <div className="text-base font-extrabold text-sky-700 dark:text-emerald-300">
                              {school.student_count ?? "1,250"}
                            </div>
                            <div className="text-[10px] font-bold uppercase text-sky-600">Students</div>
                          </div>
                          <div className="p-2 rounded-xl bg-sky-50 dark:bg-sky-950/20">
                            <div className="text-base font-extrabold text-sky-700 dark:text-sky-300">
                              {school.faculty_count ?? "48"}
                            </div>
                            <div className="text-[10px] font-bold uppercase text-sky-600">Faculty</div>
                          </div>
                          <div className="p-2 rounded-xl bg-slate-50 dark:bg-slate-800">
                            <div className="text-xs font-extrabold text-sky-600 mt-0.5">
                              {school.is_active !== false ? "Active" : "Inactive"}
                            </div>
                            <div className="text-[10px] font-bold uppercase text-slate-400">Status</div>
                          </div>
                        </div>

                        {/* Contact */}
                        <div className="text-xs text-slate-500 dark:text-slate-400 space-y-1">
                          {school.contact_email && <p>✉️ {school.contact_email}</p>}
                          {school.contact_phone && <p>📞 {school.contact_phone}</p>}
                          {(school.city || school.state) && (
                            <p>📍 {[school.city, school.state].filter(Boolean).join(", ")}</p>
                          )}
                        </div>

                        {/* Actions */}
                        <div className="pt-3 border-t border-slate-100 dark:border-slate-800 flex gap-2">
                          <button
                            type="button"
                            onClick={() => openManageModal(school)}
                            className="flex-1 py-2 rounded-xl bg-slate-100 dark:bg-slate-800 hover:bg-slate-200 dark:hover:bg-slate-700 text-slate-800 dark:text-slate-200 text-xs font-bold transition"
                          >
                            Manage
                          </button>
                          <button
                            type="button"
                            onClick={() => handleSwitchSchool(school)}
                            className="px-3 py-2 rounded-xl bg-[#0294CE] hover:bg-sky-600 text-white text-xs font-bold transition"
                            title="Set as active campus"
                          >
                            Inspect
                          </button>
                          <button
                            type="button"
                            onClick={() => {
                              setSchools((prev) => prev.filter((s) => s.id !== school.id));
                              addToast(`Removed school: ${school.name}`);
                            }}
                            className="px-3 py-2 rounded-xl bg-red-50 hover:bg-red-100 text-red-600 text-xs font-bold transition"
                          >
                            Remove
                          </button>
                        </div>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>
        )}

        {/* ── SECTION C: SIS (STUDENT INFORMATION SYSTEM) ───── */}
        {activeModule === "sis" && (
          <div className="space-y-6">
            <div className="glass-panel rounded-3xl p-6 sm:p-8 shadow-glass border border-white/80 dark:border-slate-800">
              <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 pb-6 border-b border-slate-100 dark:border-slate-800">
                <div>
                  <h2 className="text-xl sm:text-2xl font-extrabold text-slate-900 dark:text-white">
                    {isPrincipal ? `${currentSchool.name} • Student Register` : "Student Lifecycle & Master Records"}
                  </h2>
                  <p className="text-xs sm:text-sm text-slate-500 dark:text-slate-400 mt-1">
                    Institution: <strong>{currentSchool.name}</strong> • Auto-ID Formula: <strong>{currentSchool.code}ST[001...]</strong>
                  </p>
                </div>
                <div className="flex items-center gap-3">
                  <input
                    type="text"
                    value={searchTerm}
                    onChange={(e) => setSearchTerm(e.target.value)}
                    placeholder="Search student or ID..."
                    className="px-4 py-2 rounded-xl border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 text-xs text-slate-800 dark:text-white"
                  />
                  <select
                    value={statusFilter}
                    onChange={(e) => setStatusFilter(e.target.value)}
                    className="px-3 py-2 rounded-xl border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 text-xs font-semibold"
                  >
                    <option value="">All Statuses</option>
                    <option value="Enrolled">Enrolled</option>
                    <option value="Graduating">Graduating</option>
                    <option value="Transferred">Transferred</option>
                  </select>
                  <button
                    type="button"
                    onClick={() => setIsEnrollModalOpen(true)}
                    className="px-4 py-2 rounded-xl bg-[#0EA5E9] hover:bg-sky-600 text-white font-bold text-xs shrink-0 shadow-sm"
                  >
                    + Enroll Student
                  </button>
                </div>
              </div>

              {/* Student Table */}
              <div className="overflow-x-auto mt-4">
                <table className="w-full text-left text-xs">
                  <thead className="text-slate-400 border-b border-slate-200 dark:border-slate-800">
                    <tr>
                      <th className="py-3 px-2">Student Name</th>
                      <th className="py-3 px-2">Registration ID</th>
                      <th className="py-3 px-2">Program / Class</th>
                      <th className="py-3 px-2">Semester / Standard</th>
                      <th className="py-3 px-2">Attendance</th>
                      <th className="py-3 px-2">Status</th>
                      <th className="py-3 px-2 text-right">Actions</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-100 dark:divide-slate-800">
                    {isLoadingStudents ? (
                      <tr>
                        <td colSpan={7} className="py-8 text-center text-slate-400">Loading student records from database...</td>
                      </tr>
                    ) : filteredStudents.length === 0 ? (
                      <tr>
                        <td colSpan={7} className="py-8 text-center text-slate-400">No student records found.</td>
                      </tr>
                    ) : (
                      filteredStudents.map((st) => (
                        <tr key={st.id} className="hover:bg-slate-50/50 dark:hover:bg-slate-900/50">
                          <td className="py-3 px-2">
                            <div className="font-bold text-slate-900 dark:text-white">{st.name}</div>
                            <div className="text-[11px] text-slate-400">{st.email}</div>
                          </td>
                          <td className="py-3 px-2 font-mono font-bold text-[#0294CE]">{st.registration_no}</td>
                          <td className="py-3 px-2 font-semibold">{st.program}</td>
                          <td className="py-3 px-2">Sem / Std {st.semester}</td>
                          <td className="py-3 px-2">
                            <span className="px-2 py-0.5 rounded-full bg-sky-50 text-sky-700 font-bold text-[10px]">
                              {st.attendance || "96%"}
                            </span>
                          </td>
                          <td className="py-3 px-2">
                            <span className="px-2 py-0.5 rounded-full bg-blue-50 text-blue-700 font-bold text-[10px]">
                              {st.status}
                            </span>
                          </td>
                          <td className="py-3 px-2 text-right">
                            <button
                              type="button"
                              onClick={() => addToast(`Viewing 360 profile for ${st.name}`)}
                              className="px-2.5 py-1 rounded-lg bg-slate-100 dark:bg-slate-800 font-bold text-slate-700 dark:text-slate-300 hover:bg-[#0294CE] hover:text-white transition"
                            >
                              Profile
                            </button>
                          </td>
                        </tr>
                      ))
                    )}
                  </tbody>
                </table>
              </div>
            </div>
          </div>
        )}

        {/* ── SECTION D: FINANCE LEDGER ─────────────────────── */}
        {activeModule === "finance" && (
          <div className="glass-panel rounded-3xl p-6 sm:p-8 shadow-glass border border-white/80 dark:border-slate-800 space-y-6">
            <h2 className="text-xl sm:text-2xl font-extrabold text-slate-900 dark:text-white">
              {isPrincipal ? `${currentSchool.name} • Fees & Financial Ledger` : "Multi-Campus Fees & Financial Ledger"}
            </h2>
            <div className="grid grid-cols-1 md:grid-cols-3 gap-5">
              <div className="p-5 rounded-2xl bg-sky-50 dark:bg-sky-950/20 border border-sky-200 dark:border-emerald-900/40">
                <span className="text-xs font-bold text-sky-600 uppercase">Total Collected</span>
                <div className="text-2xl font-extrabold text-sky-700 dark:text-emerald-300 mt-1">₹ 4.82 Cr</div>
                <p className="text-xs text-sky-600 mt-1">87.5% recovery rate across batches</p>
              </div>
              <div className="p-5 rounded-2xl bg-amber-50 dark:bg-amber-950/20 border border-amber-200 dark:border-amber-900/40">
                <span className="text-xs font-bold text-amber-600 uppercase">Pending Dues</span>
                <div className="text-2xl font-extrabold text-amber-700 dark:text-amber-300 mt-1">₹ 68.4 Lakhs</div>
                <p className="text-xs text-amber-600 mt-1">14 overdue invoices requiring follow-up</p>
              </div>
              <div className="p-5 rounded-2xl bg-purple-50 dark:bg-purple-950/20 border border-purple-200 dark:border-purple-900/40">
                <span className="text-xs font-bold text-purple-600 uppercase">Scholarships & Concessions</span>
                <div className="text-2xl font-extrabold text-purple-700 dark:text-purple-300 mt-1">₹ 35.0 Lakhs</div>
                <p className="text-xs text-purple-600 mt-1">Merit & category concessions credited</p>
              </div>
            </div>
          </div>
        )}

      </main>

      {/* ── Detail Popup / Modal Component ─────────────────── */}
      {activeDetailModule && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-slate-950/60 backdrop-blur-md transition-opacity duration-200"
          onClick={(e) => {
            if (e.target === e.currentTarget) setActiveDetailModule(null);
          }}
        >
          <div className="glass-panel bg-white dark:bg-slate-900 rounded-3xl max-w-xl w-full p-6 sm:p-8 shadow-2xl border border-white/60 dark:border-slate-800 transition-all duration-300 animate-in fade-in zoom-in-95">
            {/* Modal Header */}
            <div className="flex items-start justify-between border-b border-slate-100 dark:border-slate-800 pb-5">
              <div className="flex items-center gap-4">
                <div
                  className="w-12 h-12 rounded-2xl flex items-center justify-center text-white shadow-md shrink-0"
                  style={{
                    backgroundColor: activeDetailModule.badgeType === "red" ? "#E53A35" : "#0294CE",
                  }}
                >
                  <ModuleIcon name={activeDetailModule.icon} className="w-6 h-6 text-white" />
                </div>
                <div>
                  <div className="flex items-center gap-2">
                    <h3 className="text-xl font-extrabold text-slate-900 dark:text-white">
                      {activeDetailModule.title}
                    </h3>
                    <span
                      className={`text-[10px] font-extrabold px-2 py-0.5 rounded-full ${
                        activeDetailModule.badgeType === "red"
                          ? "bg-[#E53A35]/10 text-[#E53A35]"
                          : "bg-[#0EA5E9]/10 text-[#0EA5E9] dark:text-sky-400"
                      }`}
                    >
                      {activeDetailModule.badge}
                    </span>
                  </div>
                  <p className="text-xs font-bold text-[#0294CE] uppercase tracking-wider mt-0.5">
                    {activeDetailModule.category} Module
                  </p>
                </div>
              </div>
              <button
                type="button"
                onClick={() => setActiveDetailModule(null)}
                className="p-2 rounded-2xl text-slate-400 hover:text-slate-600 dark:hover:text-slate-200 hover:bg-slate-100 dark:hover:bg-slate-800 transition"
              >
                <X className="w-5 h-5" />
              </button>
            </div>

            {/* Modal Content */}
            <div className="py-5 space-y-4">
              <p className="text-sm text-slate-600 dark:text-slate-300 leading-relaxed">
                {activeDetailModule.description}
              </p>

              {/* Dynamic Metrics Box */}
              <div className="bg-slate-50 dark:bg-slate-800/60 rounded-2xl p-4 border border-slate-200/60 dark:border-slate-700/60">
                <h4 className="text-xs font-bold text-slate-400 uppercase tracking-wider mb-2">Live Status & Statistics</h4>
                <div className="grid grid-cols-2 gap-3 text-xs">
                  {activeDetailModule.metrics.map((metric, idx) => (
                    <div key={idx} className="p-2.5 rounded-xl bg-white dark:bg-slate-900 border border-slate-100 dark:border-slate-800">
                      <span className="text-slate-400 text-[10px] font-semibold block">{metric.label}</span>
                      <span className="text-sm font-extrabold text-slate-800 dark:text-slate-100 mt-0.5 block">{metric.val}</span>
                    </div>
                  ))}
                </div>
              </div>

              {/* Quick Actions Grid */}
              <div>
                <h4 className="text-xs font-bold text-slate-400 uppercase tracking-wider mb-2.5">Quick Actions</h4>
                <div className="grid grid-cols-2 gap-2">
                  {activeDetailModule.actions.map((act, idx) => (
                    <button
                      key={idx}
                      type="button"
                      onClick={() => handleActionClick(act)}
                      className="p-2.5 rounded-xl bg-white dark:bg-slate-900 hover:bg-[#0294CE]/10 border border-slate-200 dark:border-slate-700/80 text-left text-xs font-bold text-slate-700 dark:text-slate-200 hover:text-[#0294CE] transition flex items-center justify-between group"
                    >
                      <span>{act}</span>
                      <ChevronRight className="w-3.5 h-3.5 text-slate-300 group-hover:text-[#0294CE]" />
                    </button>
                  ))}
                </div>
              </div>
            </div>

            {/* Modal Footer */}
            <div className="flex items-center justify-end gap-3 pt-3 border-t border-slate-100 dark:border-slate-800">
              <button
                type="button"
                onClick={() => setActiveDetailModule(null)}
                className="px-5 py-2.5 rounded-2xl text-xs font-bold text-slate-600 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-800 transition"
              >
                Dismiss
              </button>
              <button
                type="button"
                onClick={() => handleLaunchConsole(activeDetailModule)}
                className="px-5 py-2.5 rounded-2xl text-xs font-bold bg-[#0294CE] hover:bg-[#027aab] text-white shadow-lg shadow-[#0294CE]/30 transition flex items-center gap-2"
              >
                Launch Full Console <ArrowRight className="w-3.5 h-3.5" />
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ── Toast Notifications ───────────────────────────── */}
      <div className="fixed bottom-5 right-5 z-50 space-y-2 pointer-events-none">
        {toasts.map((toast) => (
          <div
            key={toast.id}
            className="toast-enter pointer-events-auto p-4 rounded-2xl bg-slate-900 dark:bg-white text-white dark:text-slate-900 text-xs font-bold shadow-2xl flex items-center gap-3 border border-slate-700 dark:border-slate-200 min-w-[260px]"
          >
            <div className="w-2 h-2 rounded-full bg-[#0EA5E9] shrink-0" />
            <span>{toast.msg}</span>
          </div>
        ))}
      </div>

      {/* ── Integration Modals (Persist directly to DB) ─────── */}
      <EnrollStudentModal
        isOpen={isEnrollModalOpen}
        onClose={() => setIsEnrollModalOpen(false)}
        schoolName={currentSchool.name}
        schoolCode={currentSchool.code}
        existingCount={students.length}
        onStudentEnrolled={handleStudentEnrolled}
      />

      <RegisterSchoolModal
        isOpen={isRegisterSchoolModalOpen}
        onClose={() => setIsRegisterSchoolModalOpen(false)}
        onSchoolRegistered={handleSchoolRegistered}
      />

      <ManageSchoolModal
        isOpen={isManageSchoolModalOpen}
        onClose={() => setIsManageSchoolModalOpen(false)}
        school={selectedSchoolToManage}
        onUpdateSchool={handleUpdateSchool}
        onSwitchSchool={handleSwitchSchool}
      />

    </div>
  );
}
