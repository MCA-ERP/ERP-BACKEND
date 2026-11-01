const { Client } = require("pg");
const dotenv = require("dotenv");
dotenv.config();

const schemaSql = `
-- ====================================================================
-- EDUCATION ERP: MASTER DATABASE INITIALIZATION
-- Multi-tier PostgreSQL Schema for Supabase (Project: MCA-ERP)
-- ====================================================================

CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

-- 1. INSTITUTIONS & CAMPUSES (Multi-Tenancy)
CREATE TABLE IF NOT EXISTS public.institutions (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    code VARCHAR(50) UNIQUE NOT NULL,
    name VARCHAR(255) NOT NULL,
    type VARCHAR(50) DEFAULT 'High School',
    website VARCHAR(255),
    contact_email VARCHAR(255),
    contact_phone VARCHAR(50),
    address TEXT,
    city VARCHAR(100),
    state VARCHAR(100),
    logo_url TEXT,
    is_active BOOLEAN DEFAULT TRUE,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS public.campuses (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    institution_id UUID NOT NULL REFERENCES public.institutions(id) ON DELETE CASCADE,
    code VARCHAR(50) NOT NULL,
    name VARCHAR(255) NOT NULL,
    address TEXT,
    city VARCHAR(100),
    state VARCHAR(100),
    postal_code VARCHAR(20),
    country VARCHAR(100) DEFAULT 'India',
    is_active BOOLEAN DEFAULT TRUE,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW(),
    CONSTRAINT uq_institution_campus_code UNIQUE (institution_id, code)
);

-- 2. RBAC: ROLES & PERMISSIONS
CREATE TABLE IF NOT EXISTS public.roles (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    name VARCHAR(50) UNIQUE NOT NULL,
    display_name VARCHAR(100) NOT NULL,
    description TEXT,
    is_system_default BOOLEAN DEFAULT FALSE,
    created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS public.permissions (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    code VARCHAR(100) UNIQUE NOT NULL,
    module VARCHAR(50) NOT NULL,
    description TEXT,
    created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS public.role_permissions (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    role_id UUID NOT NULL REFERENCES public.roles(id) ON DELETE CASCADE,
    permission_id UUID NOT NULL REFERENCES public.permissions(id) ON DELETE CASCADE,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    CONSTRAINT uq_role_permission UNIQUE (role_id, permission_id)
);

-- 3. USER PROFILES & AUDIT LOGS
CREATE TABLE IF NOT EXISTS public.user_profiles (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    auth_user_id UUID UNIQUE,
    institution_id UUID REFERENCES public.institutions(id) ON DELETE SET NULL,
    campus_id UUID REFERENCES public.campuses(id) ON DELETE SET NULL,
    role_id UUID NOT NULL REFERENCES public.roles(id),
    email VARCHAR(255) UNIQUE NOT NULL,
    first_name VARCHAR(100) NOT NULL,
    last_name VARCHAR(100) NOT NULL,
    phone VARCHAR(30),
    avatar_url TEXT,
    status VARCHAR(30) DEFAULT 'active',
    last_login_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS public.audit_logs (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    actor_id UUID REFERENCES public.user_profiles(id) ON DELETE SET NULL,
    actor_email VARCHAR(255),
    action VARCHAR(100) NOT NULL,
    entity_name VARCHAR(100) NOT NULL,
    entity_id VARCHAR(100),
    old_data JSONB,
    new_data JSONB,
    ip_address VARCHAR(50),
    user_agent TEXT,
    created_at TIMESTAMPTZ DEFAULT NOW()
);

-- 4. ACADEMICS STRUCTURE
CREATE TABLE IF NOT EXISTS public.academic_years (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    institution_id UUID NOT NULL REFERENCES public.institutions(id) ON DELETE CASCADE,
    name VARCHAR(50) NOT NULL,
    start_date DATE NOT NULL,
    end_date DATE NOT NULL,
    is_current BOOLEAN DEFAULT FALSE,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    CONSTRAINT uq_institution_academic_year UNIQUE (institution_id, name)
);

CREATE TABLE IF NOT EXISTS public.departments (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    institution_id UUID NOT NULL REFERENCES public.institutions(id) ON DELETE CASCADE,
    code VARCHAR(50) NOT NULL,
    name VARCHAR(255) NOT NULL,
    description TEXT,
    head_of_department_id UUID,
    is_active BOOLEAN DEFAULT TRUE,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    CONSTRAINT uq_institution_dept_code UNIQUE (institution_id, code)
);

CREATE TABLE IF NOT EXISTS public.programs (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    department_id UUID NOT NULL REFERENCES public.departments(id) ON DELETE CASCADE,
    code VARCHAR(50) NOT NULL,
    name VARCHAR(255) NOT NULL,
    degree_level VARCHAR(50) DEFAULT 'Undergraduate',
    duration_years INTEGER NOT NULL DEFAULT 4,
    total_semesters INTEGER NOT NULL DEFAULT 8,
    is_active BOOLEAN DEFAULT TRUE,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    CONSTRAINT uq_dept_program_code UNIQUE (department_id, code)
);

CREATE TABLE IF NOT EXISTS public.batches (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    program_id UUID NOT NULL REFERENCES public.programs(id) ON DELETE CASCADE,
    name VARCHAR(100) NOT NULL,
    start_year INTEGER NOT NULL,
    end_year INTEGER NOT NULL,
    is_active BOOLEAN DEFAULT TRUE,
    created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS public.sections (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    batch_id UUID NOT NULL REFERENCES public.batches(id) ON DELETE CASCADE,
    name VARCHAR(50) NOT NULL,
    current_semester INTEGER DEFAULT 1,
    max_capacity INTEGER DEFAULT 60,
    created_at TIMESTAMPTZ DEFAULT NOW()
);

-- 5. STUDENT INFORMATION SYSTEM (SIS)
CREATE TABLE IF NOT EXISTS public.students (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    user_profile_id UUID REFERENCES public.user_profiles(id) ON DELETE SET NULL,
    institution_id UUID NOT NULL REFERENCES public.institutions(id) ON DELETE CASCADE,
    registration_no VARCHAR(100) UNIQUE NOT NULL,
    roll_no VARCHAR(100),
    batch_id UUID REFERENCES public.batches(id) ON DELETE SET NULL,
    section_id UUID REFERENCES public.sections(id) ON DELETE SET NULL,
    admission_date DATE NOT NULL DEFAULT CURRENT_DATE,
    current_semester INTEGER DEFAULT 1,
    status VARCHAR(50) DEFAULT 'Enrolled',
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS public.student_profiles (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    student_id UUID UNIQUE NOT NULL REFERENCES public.students(id) ON DELETE CASCADE,
    date_of_birth DATE,
    gender VARCHAR(20) NOT NULL,
    blood_group VARCHAR(10),
    nationality VARCHAR(50) DEFAULT 'Indian',
    category VARCHAR(50) DEFAULT 'General',
    religion VARCHAR(50),
    permanent_address TEXT,
    current_address TEXT,
    emergency_contact_name VARCHAR(100),
    emergency_contact_phone VARCHAR(30),
    medical_notes TEXT,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS public.student_guardians (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    student_id UUID NOT NULL REFERENCES public.students(id) ON DELETE CASCADE,
    relation VARCHAR(50) NOT NULL,
    full_name VARCHAR(200) NOT NULL,
    phone VARCHAR(30) NOT NULL,
    email VARCHAR(255),
    occupation VARCHAR(100),
    annual_income NUMERIC(12, 2),
    is_primary_contact BOOLEAN DEFAULT TRUE,
    created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS public.student_documents (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    student_id UUID NOT NULL REFERENCES public.students(id) ON DELETE CASCADE,
    document_type VARCHAR(100) NOT NULL,
    document_name VARCHAR(255) NOT NULL,
    file_url TEXT NOT NULL,
    verification_status VARCHAR(50) DEFAULT 'Pending',
    verified_by UUID REFERENCES public.user_profiles(id),
    verified_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS public.student_promotions (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    student_id UUID NOT NULL REFERENCES public.students(id) ON DELETE CASCADE,
    from_semester INTEGER NOT NULL,
    to_semester INTEGER NOT NULL,
    academic_year_id UUID REFERENCES public.academic_years(id),
    promoted_on DATE DEFAULT CURRENT_DATE,
    promoted_by UUID REFERENCES public.user_profiles(id),
    remarks TEXT,
    created_at TIMESTAMPTZ DEFAULT NOW()
);

-- 6. INDEXES
CREATE INDEX IF NOT EXISTS idx_user_profiles_role ON public.user_profiles(role_id);
CREATE INDEX IF NOT EXISTS idx_user_profiles_institution ON public.user_profiles(institution_id);
CREATE INDEX IF NOT EXISTS idx_audit_logs_actor ON public.audit_logs(actor_id);
CREATE INDEX IF NOT EXISTS idx_audit_logs_created_at ON public.audit_logs(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_students_reg_no ON public.students(registration_no);
CREATE INDEX IF NOT EXISTS idx_students_institution ON public.students(institution_id);
CREATE INDEX IF NOT EXISTS idx_students_status ON public.students(status);

-- 7. INITIAL SEED DATA
INSERT INTO public.roles (name, display_name, description, is_system_default)
VALUES 
    ('SuperAdmin', 'Super Administrator', 'Full platform multi-tenant administrative privileges', TRUE),
    ('InstitutionAdmin', 'Institution Administrator', 'Full institutional control and configuration', TRUE),
    ('Principal', 'Principal / Director', 'Campus academic oversight and approvals', TRUE),
    ('Registrar', 'Registrar / Academic Office', 'Admissions, records, transcripts, promotions', TRUE),
    ('Faculty', 'Faculty / Teacher', 'Class timetable, attendance, marks entry', TRUE),
    ('Student', 'Student', 'Personal timetable, grades, attendance, fee records', TRUE),
    ('Parent', 'Parent / Guardian', 'Ward tracking, report cards, fees', TRUE),
    ('Accountant', 'Accountant / Finance Officer', 'Fee setup, offline collections, reconciliation', TRUE),
    ('HR', 'Human Resources Manager', 'Staff records, leaves, payroll', TRUE),
    ('Librarian', 'Librarian', 'Book catalog, issues, returns', TRUE)
ON CONFLICT (name) DO NOTHING;

INSERT INTO public.institutions (id, code, name, type, website, contact_email, contact_phone, address, city, state)
VALUES (
    'a0000000-0000-0000-0000-000000000001',
    'RAV',
    'Ravindra English Medium High School',
    'High School',
    'https://ravindra.edu',
    'principal@rav.edu',
    '+91-9876543210',
    'Main Campus Road, Sector 4',
    'Bangalore',
    'Karnataka'
)
ON CONFLICT (code) DO NOTHING;
`;

async function run() {
  const connectionStrings = [
    process.env.DATABASE_URL,
    process.env.DATABASE_POOLER_URL,
  ].filter(Boolean);

  let connected = false;
  let client;

  for (const connStr of connectionStrings) {
    const masked = connStr.replace(/:([^:@]+)@/, ":****@");
    console.log(`🔌 Attempting connection to: ${masked}...`);
    try {
      client = new Client({
        connectionString: connStr,
        ssl: { rejectUnauthorized: false },
        connectionTimeoutMillis: 8000,
      });
      await client.connect();
      console.log("✅ Successfully connected to Supabase PostgreSQL database!");
      connected = true;
      break;
    } catch (err) {
      console.warn(`⚠️ Connection attempt failed (${err.message}). Trying next...`);
      if (client) {
        try { await client.end(); } catch (_) {}
      }
    }
  }

  if (!connected || !client) {
    console.error("❌ Failed to connect to database with provided connection strings.");
    process.exit(1);
  }

  try {
    console.log("🚀 Executing table migrations and initial seeds...");
    await client.query(schemaSql);
    console.log("🎉 All tables, constraints, indexes, and initial seeds created successfully!");

    // Verify created tables
    const res = await client.query(`
      SELECT table_name 
      FROM information_schema.tables 
      WHERE table_schema = 'public' 
      ORDER BY table_name;
    `);
    console.log("\n📋 Verified Public Tables in Supabase:");
    res.rows.forEach((r, idx) => console.log(`   ${idx + 1}. ${r.table_name}`));
  } catch (err) {
    console.error("❌ Migration execution error:", err.message);
  } finally {
    await client.end();
    console.log("\n🔒 Database connection closed.");
  }
}

run();
