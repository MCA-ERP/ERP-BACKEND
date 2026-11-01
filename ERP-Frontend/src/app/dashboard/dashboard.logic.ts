"use client";

import { useEffect, useState } from "react";
import { useSearchParams } from "next/navigation";
import {
  checkBackendHealth,
  getSisStats,
  getStudents,
  getTimetable,
  getAllSchools,
  getSchoolByCode,
  BackendHealth,
  SisStats,
  StudentRecord,
  TimetableSlot,
  SchoolRecord,
} from "@/lib/api";

export type RoleType = "SuperAdmin" | "Principal" | "Registrar" | "Faculty" | "Student" | "Parent";
export type ActiveModule = "dashboard" | "sis" | "admissions" | "academics" | "exams" | "finance" | "schools";

export interface EnterpriseModule {
  id: string;
  title: string;
  subtitle: string;
  category: "Academic" | "Operations" | "Services";
  icon: string;
  badge: string;
  badgeType: "green" | "red";
  description: string;
  metrics: { label: string; val: string }[];
  actions: string[];
}

export const ENTERPRISE_MODULES: EnterpriseModule[] = [
  {
    id: "employee",
    title: "Employee",
    subtitle: "Staff & Faculty",
    category: "Operations",
    icon: "users",
    badge: "190 Active Staff",
    badgeType: "green",
    description: "Centralized personnel management for professors, administrative staff, payroll records, and daily duty rosters.",
    metrics: [
      { label: "Faculty On Duty", val: "142 / 148" },
      { label: "On Leave", val: "6 Staff" },
    ],
    actions: ["View Directory", "Process Payroll", "Attendance Log", "Add Employee"],
  },
  {
    id: "organization",
    title: "Organization",
    subtitle: "Structure & Hierarchy",
    category: "Operations",
    icon: "sitemap",
    badge: "Institutional Active",
    badgeType: "green",
    description: "Configure multi-campus departments, organizational charts, governance rules, and access control policies.",
    metrics: [
      { label: "Departments", val: "12 Divisions" },
      { label: "Active Roles", val: "34 Policy Sets" },
    ],
    actions: ["Manage Roles", "Dept Chart", "System Rules", "Audit Log"],
  },
  {
    id: "campus",
    title: "Campus",
    subtitle: "Facilities & Life",
    category: "Academic",
    icon: "building-2",
    badge: "3 Campuses",
    badgeType: "green",
    description: "Monitor campus infrastructure, safety compliance, auditorium bookings, and sports facilities.",
    metrics: [
      { label: "Reservations", val: "8 Active" },
      { label: "Facility Status", val: "Optimal" },
    ],
    actions: ["Book Facility", "Campus Map", "Safety Alert", "Event Roster"],
  },
  {
    id: "class",
    title: "Class",
    subtitle: "Schedules & Attendance",
    category: "Academic",
    icon: "graduation-cap",
    badge: "42 In Progress",
    badgeType: "green",
    description: "Oversee real-time classroom lecture schedules, digital attendance records, teacher substitutions, and syllabus progress.",
    metrics: [
      { label: "Current Class", val: "Period 5" },
      { label: "Attendance Rate", val: "94.8%" },
    ],
    actions: ["Take Attendance", "Class Schedule", "Substitutions", "Syllabus Tracker"],
  },
  {
    id: "front-office",
    title: "Front Office",
    subtitle: "Inquiries & Visitors",
    category: "Operations",
    icon: "user-check",
    badge: "24 Visitors Today",
    badgeType: "green",
    description: "Manage reception visitor passes, general admission inquiries, phone logs, and appointment calendars.",
    metrics: [
      { label: "Pending Guests", val: "3 In Lobby" },
      { label: "Today Inquiries", val: "48 Calls" },
    ],
    actions: ["New Visitor Pass", "Inquiry Log", "Schedule Meeting", "Dispatch Mail"],
  },
  {
    id: "fee",
    title: "Fee",
    subtitle: "Financials & Payments",
    category: "Services",
    icon: "credit-card",
    badge: "14 Overdue Pending",
    badgeType: "red",
    description: "Comprehensive financial suite for student tuition collection, invoice dispatch, scholarship credits, and balance statements.",
    metrics: [
      { label: "Q3 Collection", val: "88.4%" },
      { label: "Overdue Total", val: "$12,450" },
    ],
    actions: ["Send Reminders", "Process Payment", "Generate Invoice", "Fee Waiver"],
  },
  {
    id: "fleet",
    title: "Fleet",
    subtitle: "Transport & Live Tracking",
    category: "Services",
    icon: "bus",
    badge: "18 Buses Active",
    badgeType: "green",
    description: "Real-time GPS tracking for student buses, route optimization, driver assignments, and vehicle health monitoring.",
    metrics: [
      { label: "Active Routes", val: "18 Routes" },
      { label: "Speed Compliance", val: "100%" },
    ],
    actions: ["Live GPS Map", "Driver Roster", "Route Delay Alert", "Fuel Logs"],
  },
  {
    id: "cafeteria",
    title: "Cafeteria",
    subtitle: "Menu & Meal Services",
    category: "Services",
    icon: "utensils",
    badge: "Lunch Service",
    badgeType: "green",
    description: "Digital meal voucher management, daily nutritional menus, cafeteria inventory, and POS counter syncing.",
    metrics: [
      { label: "Meals Served Today", val: "1,840" },
      { label: "Special Diets", val: "62 Registered" },
    ],
    actions: ["Update Menu", "POS Terminal", "Meal Vouchers", "Stock Check"],
  },
  {
    id: "inventory",
    title: "Inventory",
    subtitle: "Assets & Stock",
    category: "Services",
    icon: "boxes",
    badge: "Stock Level OK",
    badgeType: "green",
    description: "Track physical institutional equipment, lab materials, IT hardware assets, and automated restock orders.",
    metrics: [
      { label: "Total Assets", val: "4,210 Items" },
      { label: "Low Stock Items", val: "2 Items" },
    ],
    actions: ["Scan Asset Barcode", "Reorder Supplies", "Audit Stock", "Issue Equipment"],
  },
  {
    id: "library",
    title: "Library",
    subtitle: "Catalog & Search",
    category: "Academic",
    icon: "book-open",
    badge: "24,000 Volumes",
    badgeType: "green",
    description: "Digital search portal for physical and electronic books, student circulation desk, and quiet study pod bookings.",
    metrics: [
      { label: "Books Issued", val: "1,120 Active" },
      { label: "Overdue Books", val: "8 Return Pending" },
    ],
    actions: ["Book Search", "Issue / Return", "Pod Booking", "E-Journal Portal"],
  },
  {
    id: "hostel",
    title: "Hostel",
    subtitle: "Residence Halls",
    category: "Academic",
    icon: "bed",
    badge: "92% Occupancy",
    badgeType: "green",
    description: "Manage room allotments for resident students, warden duty logs, leave permissions, and hall maintenance.",
    metrics: [
      { label: "Residents In", val: "842 Students" },
      { label: "Late Night Passes", val: "12 Approved" },
    ],
    actions: ["Room Allocation", "Issue Gate Pass", "Warden Log", "Maintenance"],
  },
  {
    id: "admin",
    title: "Admin",
    subtitle: "System & Settings",
    category: "Operations",
    icon: "shield-check",
    badge: "System Super",
    badgeType: "green",
    description: "Master administrative panel for security configurations, API integration settings, database backups, and school network management.",
    metrics: [
      { label: "Server Uptime", val: "99.98%" },
      { label: "Security Backup", val: "Today 03:00" },
    ],
    actions: ["Manage Schools", "Register School", "API Keys", "System Audit"],
  },
  {
    id: "communication",
    title: "Communication",
    subtitle: "Inbox & Broadcasts",
    category: "Services",
    icon: "message-square",
    badge: "3 Broadcasts Today",
    badgeType: "green",
    description: "Multi-channel broadcast engine for SMS alerts, push notifications, parent newsletters, and emergency announcements.",
    metrics: [
      { label: "SMS Credits", val: "45,000 Remaining" },
      { label: "Delivery Rate", val: "99.4%" },
    ],
    actions: ["Compose Broadcast", "SMS Blast", "Parent Portal Msg", "Alert History"],
  },
];

export function useDashboardLogic() {
  const searchParams = useSearchParams();

  const [activeModule, setActiveModule] = useState<ActiveModule>("dashboard");
  const [activeRole, setActiveRole] = useState<RoleType>("SuperAdmin");
  const [currentSchool, setCurrentSchool] = useState({
    name: "Ravindra English Medium High School",
    code: "RAV",
  });

  // EduPulse UI States
  const [searchQuery, setSearchQuery] = useState("");
  const [selectedCategory, setSelectedCategory] = useState<"all" | "Academic" | "Operations" | "Services">("all");
  const [isDarkMode, setIsDarkMode] = useState(false);
  const [isNotifOpen, setIsNotifOpen] = useState(false);
  const [activeDetailModule, setActiveDetailModule] = useState<EnterpriseModule | null>(null);
  const [toasts, setToasts] = useState<{ id: number; msg: string }[]>([]);

  // Clock
  const [currentTime, setCurrentTime] = useState("--:--:-- --");
  const [currentDate, setCurrentDate] = useState("Loading date...");
  const [greeting, setGreeting] = useState("Good Afternoon");

  // Backend Health & Data
  const [backendHealth, setBackendHealth] = useState<BackendHealth>({ status: "checking" });
  const [stats, setStats] = useState<SisStats>({
    totalStudents: 0,
    totalFaculty: 0,
    totalDepartments: 0,
    totalPrograms: 0,
    activeBatches: 0,
    attendanceRate: "0.0%",
  });
  const [students, setStudents] = useState<StudentRecord[]>([]);
  const [searchTerm, setSearchTerm] = useState("");
  const [statusFilter, setStatusFilter] = useState("");
  const [timetable, setTimetable] = useState<TimetableSlot[]>([]);
  const [isLoadingStudents, setIsLoadingStudents] = useState(false);

  // Schools directory (SuperAdmin)
  const [schools, setSchools] = useState<SchoolRecord[]>([]);
  const [isLoadingSchools, setIsLoadingSchools] = useState(false);

  // Modal visibility
  const [isEnrollModalOpen, setIsEnrollModalOpen] = useState(false);
  const [isRegisterSchoolModalOpen, setIsRegisterSchoolModalOpen] = useState(false);
  const [selectedSchoolToManage, setSelectedSchoolToManage] = useState<SchoolRecord | null>(null);
  const [isManageSchoolModalOpen, setIsManageSchoolModalOpen] = useState(false);

  // ── Sync URL / Session params on mount ────────────────────────
  useEffect(() => {
    const roleParam = searchParams.get("role");
    const validRoles = ["SuperAdmin", "Principal", "Registrar", "Faculty", "Student", "Parent"];
    if (roleParam && validRoles.includes(roleParam)) {
      setActiveRole(roleParam as RoleType);
    } else if (typeof window !== "undefined") {
      const storedRole = window.sessionStorage.getItem("erp_role");
      if (storedRole && validRoles.includes(storedRole)) {
        setActiveRole(storedRole as RoleType);
      }
    }

    const schoolCodeParam = searchParams.get("schoolCode");
    const targetCode = schoolCodeParam || (typeof window !== "undefined" ? window.sessionStorage.getItem("erp_school_code") : null);

    if (targetCode) {
      getSchoolByCode(targetCode)
        .then(({ school }) => {
          setCurrentSchool({
            name: school.name,
            code: school.code,
          });
        })
        .catch(() => {});
    }
  }, [searchParams]);

  // ── Live Clock Tick ──────────────────────────────────────────
  useEffect(() => {
    const updateTime = () => {
      const now = new Date();
      setCurrentTime(now.toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit", second: "2-digit" }));
      setCurrentDate(now.toLocaleDateString("en-US", { weekday: "long", month: "short", day: "numeric", year: "numeric" }));

      const hour = now.getHours();
      const timeOfDay = hour < 12 ? "Good Morning" : hour < 17 ? "Good Afternoon" : "Good Evening";
      if (activeRole === "Principal") {
        setGreeting(`${timeOfDay}, Principal`);
      } else if (activeRole === "SuperAdmin") {
        setGreeting(`${timeOfDay}, Super Administrator`);
      } else {
        setGreeting(`${timeOfDay}, ${activeRole}`);
      }
    };

    updateTime();
    const interval = setInterval(updateTime, 1000);
    return () => clearInterval(interval);
  }, [activeRole]);

  // ── Initial data load ─────────────────────────────────────────
  useEffect(() => {
    let mounted = true;

    const loadInitialData = async () => {
      const health = await checkBackendHealth();
      if (!mounted) return;
      setBackendHealth(health);

      const sisStats = await getSisStats();
      if (!mounted) return;
      setStats(sisStats);

      const schedule = await getTimetable();
      if (!mounted) return;
      setTimetable(schedule);

      const schoolsRes = await getAllSchools();
      if (mounted) setSchools(schoolsRes.schools);
    };

    loadInitialData();
    return () => { mounted = false; };
  }, []);

  // ── Load schools when activeModule is schools ──────────────────
  useEffect(() => {
    if (activeModule !== "schools") return;
    let mounted = true;
    setIsLoadingSchools(true);
    getAllSchools().then(({ schools: list }) => {
      if (mounted) {
        setSchools(list);
        setIsLoadingSchools(false);
      }
    });
    return () => { mounted = false; };
  }, [activeModule]);

  // ── Student search / filter (Role-based) ─────────────────────
  useEffect(() => {
    let mounted = true;
    setIsLoadingStudents(true);

    const schoolFilter = activeRole === "SuperAdmin" ? "" : currentSchool.code;

    getStudents(searchTerm, statusFilter, schoolFilter).then((res) => {
      if (mounted) {
        setStudents(res.students);
        setIsLoadingStudents(false);
      }
    });

    return () => { mounted = false; };
  }, [searchTerm, statusFilter, currentSchool.code, activeRole]);

  // ── Client-side filter (search + status) ─────────────────────
  const filteredStudents = students.filter((s) => {
    const matchesSearch =
      s.name.toLowerCase().includes(searchTerm.toLowerCase()) ||
      s.registration_no.toLowerCase().includes(searchTerm.toLowerCase()) ||
      s.roll_no.toLowerCase().includes(searchTerm.toLowerCase());
    const matchesStatus = !statusFilter || s.status === statusFilter;
    return matchesSearch && matchesStatus;
  });

  // ── Toast helper ─────────────────────────────────────────────
  const addToast = (msg: string) => {
    const id = Date.now();
    setToasts((prev) => [...prev, { id, msg }]);
    setTimeout(() => {
      setToasts((prev) => prev.filter((t) => t.id !== id));
    }, 3200);
  };

  // ── Dark mode toggle ─────────────────────────────────────────
  const toggleDarkMode = () => {
    setIsDarkMode((prev) => {
      const next = !prev;
      if (typeof document !== "undefined") {
        if (next) document.documentElement.classList.add("dark");
        else document.documentElement.classList.remove("dark");
      }
      return next;
    });
  };

  // ── Callbacks ────────────────────────────────────────────────
  const handleStudentEnrolled = (newStudent: StudentRecord) => {
    setStudents((prev) => [newStudent, ...prev]);
    setStats((prev) => ({ ...prev, totalStudents: prev.totalStudents + 1 }));
    setIsEnrollModalOpen(false);
    addToast(`Student enrolled successfully: ${newStudent.registration_no}`);
  };

  const handleSchoolRegistered = (newSchool: SchoolRecord) => {
    setSchools((prev) => [newSchool, ...prev]);
    setIsRegisterSchoolModalOpen(false);
    addToast(`Institution registered successfully: ${newSchool.name} (${newSchool.code})`);
  };

  const openManageModal = (school: SchoolRecord) => {
    setSelectedSchoolToManage(school);
    setIsManageSchoolModalOpen(true);
  };

  const handleUpdateSchool = (updated: SchoolRecord) => {
    setSchools((prev) => prev.map((s) => (s.id === updated.id ? updated : s)));
    if (currentSchool.code === updated.code || currentSchool.name === updated.name) {
      setCurrentSchool({ name: updated.name, code: updated.code });
    }
    addToast(`Updated school details: ${updated.name}`);
  };

  const handleSwitchSchool = (school: SchoolRecord) => {
    setCurrentSchool({ name: school.name, code: school.code });
    if (typeof window !== "undefined") {
      window.sessionStorage.setItem("erp_school_code", school.code);
      window.sessionStorage.setItem("erp_school_name", school.name);
    }
    setActiveModule("sis");
    addToast(`Active campus switched to: ${school.name} (${school.code})`);
  };

  return {
    activeModule, setActiveModule,
    activeRole, setActiveRole,
    currentSchool, setCurrentSchool,
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
    isRegisterSchoolModalOpen, setIsRegisterSchoolModalOpen,
    selectedSchoolToManage,
    isManageSchoolModalOpen, setIsManageSchoolModalOpen,
    openManageModal,
    handleUpdateSchool,
    handleSwitchSchool,
    handleStudentEnrolled,
    handleSchoolRegistered,

    // EduPulse additions
    searchQuery, setSearchQuery,
    selectedCategory, setSelectedCategory,
    isDarkMode, toggleDarkMode,
    isNotifOpen, setIsNotifOpen,
    activeDetailModule, setActiveDetailModule,
    toasts, addToast,
    currentTime, currentDate, greeting,
  };
}
