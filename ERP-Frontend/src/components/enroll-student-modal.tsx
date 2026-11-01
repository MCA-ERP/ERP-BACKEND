"use client";

import { useState } from "react";
import { enrollStudent, StudentRecord } from "@/lib/api";

interface EnrollStudentModalProps {
  isOpen: boolean;
  onClose: () => void;
  onStudentEnrolled: (student: StudentRecord) => void;
  schoolName?: string;
  schoolCode?: string;
  existingCount?: number;
}

export function EnrollStudentModal({
  isOpen,
  onClose,
  onStudentEnrolled,
  schoolName = "Ravindra English Medium High School",
  schoolCode = "RAV",
  existingCount = 0,
}: EnrollStudentModalProps) {
  const [firstName, setFirstName] = useState("");
  const [lastName, setLastName] = useState("");
  const [email, setEmail] = useState("");
  const [phone, setPhone] = useState("");
  const [gender, setGender] = useState("Male");
  const [dob, setDob] = useState("");
  const [grade, setGrade] = useState("Class 10");
  const [section, setSection] = useState("A");
  const [rollNo, setRollNo] = useState("");
  const [guardianName, setGuardianName] = useState("");
  const [guardianPhone, setGuardianPhone] = useState("");
  const [guardianRelation, setGuardianRelation] = useState("Father");
  const [address, setAddress] = useState("");
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [errorMsg, setErrorMsg] = useState("");

  if (!isOpen) return null;

  // Formula: [First 3 letters of School in uppercase] + ST + [001, 002...]
  const schoolPrefix = (schoolCode || schoolName.replace(/[^a-zA-Z]/g, "").substring(0, 3) || "RAV").toUpperCase();
  const nextSeq = String(existingCount + 1).padStart(3, "0");
  const previewStudentId = `${schoolPrefix}ST${nextSeq}`;

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setErrorMsg("");

    if (!firstName.trim() || !lastName.trim()) {
      setErrorMsg("Student First Name and Last Name are required.");
      return;
    }

    setIsSubmitting(true);
    try {
      const res = await enrollStudent({
        first_name: firstName.trim(),
        last_name: lastName.trim(),
        email: email.trim(),
        phone: phone.trim(),
        gender,
        date_of_birth: dob,
        grade,
        section,
        roll_no: rollNo.trim() || `R-${nextSeq}`,
        school_name: schoolName,
        school_code: schoolPrefix,
        guardian_name: guardianName.trim(),
        guardian_phone: guardianPhone.trim(),
        guardian_relation: guardianRelation,
        address: address.trim(),
        registration_no: previewStudentId,
      });

      if (res.success && res.student) {
        onStudentEnrolled(res.student);
        onClose();
      } else {
        setErrorMsg(res.message || "Failed to enroll student.");
      }
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : "Enrollment failed.";
      setErrorMsg(message);
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 sm:p-6 overflow-y-auto">
      {/* Backdrop */}
      <div 
        className="fixed inset-0 bg-slate-900/60 backdrop-blur-sm transition-opacity" 
        onClick={onClose} 
      />

      {/* Modal Dialog */}
      <div className="relative w-full max-w-2xl rounded-2xl bg-white shadow-2xl border border-slate-200 z-10 overflow-hidden animate-in fade-in zoom-in-95 duration-200 my-8">
        {/* Header */}
        <div className="bg-gradient-to-r from-[#0f172a] via-[#0284c7] to-[#0ea5e9] px-6 py-5 text-white">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-3">
              <span className="flex size-10 items-center justify-center rounded-xl bg-white/15 text-white ring-1 ring-white/25 shadow-sm">
                <svg viewBox="0 0 24 24" fill="none" className="size-5" aria-hidden="true">
                  <path d="M12 4.5v15m7.5-7.5h-15" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" />
                </svg>
              </span>
              <div>
                <h3 className="text-lg font-bold tracking-tight text-white">
                  Student Enrollment Form
                </h3>
                <p className="text-xs text-slate-300">
                  {schoolName} • Master SIS Entry
                </p>
              </div>
            </div>

            <button
              type="button"
              onClick={onClose}
              className="rounded-lg p-1.5 text-slate-400 hover:bg-white/10 hover:text-white transition"
            >
              <svg viewBox="0 0 20 20" fill="currentColor" className="size-5">
                <path fillRule="evenodd" d="M4.293 4.293a1 1 0 011.414 0L10 8.586l4.293-4.293a1 1 0 111.414 1.414L11.414 10l4.293 4.293a1 1 0 01-1.414 1.414L10 11.414l-4.293 4.293a1 1 0 01-1.414-1.414L8.586 10 4.293 5.707a1 1 0 010-1.414z" clipRule="evenodd" />
              </svg>
            </button>
          </div>

          {/* Live Generated Student ID Badge */}
          <div className="mt-4 flex flex-wrap items-center justify-between gap-3 rounded-xl bg-white/10 px-4 py-2.5 border border-white/15 backdrop-blur-md">
            <div className="flex items-center gap-2">
              <span className="text-xs font-medium text-sky-100">Generated Student ID:</span>
              <span className="rounded-md bg-white text-sky-700 px-2.5 py-0.5 text-xs font-black tracking-wider text-slate-900 shadow-sm">
                {previewStudentId}
              </span>
            </div>
            <span className="text-[11px] text-slate-300">
              Formula: [{schoolPrefix}] + [ST] + [{nextSeq}]
            </span>
          </div>
        </div>

        {/* Form Body */}
        <form onSubmit={handleSubmit} className="p-6 space-y-6 max-h-[75vh] overflow-y-auto">
          {errorMsg && (
            <div className="rounded-xl bg-rose-50 border border-rose-200 p-3.5 text-xs font-medium text-rose-700 flex items-center gap-2">
              <svg viewBox="0 0 20 20" fill="currentColor" className="size-4 shrink-0">
                <path fillRule="evenodd" d="M10 18a8 8 0 100-16 8 8 0 000 16zM8.28 7.22a.75.75 0 00-1.06 1.06L8.94 10l-1.72 1.72a.75.75 0 101.06 1.06L10 11.06l1.72 1.72a.75.75 0 101.06-1.06L11.06 10l1.72-1.72a.75.75 0 00-1.06-1.06L10 8.94 8.28 7.22z" clipRule="evenodd" />
              </svg>
              {errorMsg}
            </div>
          )}

          {/* Section 1: Personal Details */}
          <div>
            <h4 className="text-xs font-bold uppercase tracking-wider text-slate-500 mb-3 flex items-center gap-2">
              <span className="size-1.5 rounded-full bg-sky-500" />
              1. Student Basic Profile
            </h4>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              <div>
                <label className="block text-xs font-semibold text-slate-700 mb-1">
                  First Name <span className="text-rose-500">*</span>
                </label>
                <input
                  type="text"
                  required
                  placeholder="e.g. Aarav"
                  value={firstName}
                  onChange={(e) => setFirstName(e.target.value)}
                  className="w-full rounded-xl border border-slate-200 px-3.5 py-2 text-xs text-slate-900 focus:border-sky-500 focus:ring-2 focus:ring-sky-500/10 outline-none"
                />
              </div>

              <div>
                <label className="block text-xs font-semibold text-slate-700 mb-1">
                  Last Name <span className="text-rose-500">*</span>
                </label>
                <input
                  type="text"
                  required
                  placeholder="e.g. Sharma"
                  value={lastName}
                  onChange={(e) => setLastName(e.target.value)}
                  className="w-full rounded-xl border border-slate-200 px-3.5 py-2 text-xs text-slate-900 focus:border-sky-500 focus:ring-2 focus:ring-sky-500/10 outline-none"
                />
              </div>

              <div>
                <label className="block text-xs font-semibold text-slate-700 mb-1">Gender</label>
                <select
                  value={gender}
                  onChange={(e) => setGender(e.target.value)}
                  className="w-full rounded-xl border border-slate-200 px-3.5 py-2 text-xs text-slate-900 focus:border-sky-500 focus:ring-2 focus:ring-sky-500/10 outline-none bg-white"
                >
                  <option value="Male">Male</option>
                  <option value="Female">Female</option>
                  <option value="Other">Other</option>
                </select>
              </div>

              <div>
                <label className="block text-xs font-semibold text-slate-700 mb-1">Date of Birth</label>
                <input
                  type="date"
                  value={dob}
                  onChange={(e) => setDob(e.target.value)}
                  className="w-full rounded-xl border border-slate-200 px-3.5 py-2 text-xs text-slate-900 focus:border-sky-500 focus:ring-2 focus:ring-sky-500/10 outline-none bg-white"
                />
              </div>

              <div>
                <label className="block text-xs font-semibold text-slate-700 mb-1">Student Email</label>
                <input
                  type="email"
                  placeholder={`Optional (auto: ${previewStudentId.toLowerCase()}@${schoolPrefix.toLowerCase()}.edu)`}
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  className="w-full rounded-xl border border-slate-200 px-3.5 py-2 text-xs text-slate-900 focus:border-sky-500 focus:ring-2 focus:ring-sky-500/10 outline-none"
                />
              </div>

              <div>
                <label className="block text-xs font-semibold text-slate-700 mb-1">Phone Number</label>
                <input
                  type="tel"
                  placeholder="+91-9876543210"
                  value={phone}
                  onChange={(e) => setPhone(e.target.value)}
                  className="w-full rounded-xl border border-slate-200 px-3.5 py-2 text-xs text-slate-900 focus:border-sky-500 focus:ring-2 focus:ring-sky-500/10 outline-none"
                />
              </div>
            </div>
          </div>

          {/* Section 2: Academic Assignment */}
          <div className="pt-2 border-t border-slate-100">
            <h4 className="text-xs font-bold uppercase tracking-wider text-slate-500 mb-3 flex items-center gap-2">
              <span className="size-1.5 rounded-full bg-sky-500" />
              2. Academic Class & Batch
            </h4>
            <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
              <div>
                <label className="block text-xs font-semibold text-slate-700 mb-1">Standard / Class</label>
                <select
                  value={grade}
                  onChange={(e) => setGrade(e.target.value)}
                  className="w-full rounded-xl border border-slate-200 px-3.5 py-2 text-xs text-slate-900 focus:border-sky-500 focus:ring-2 focus:ring-sky-500/10 outline-none bg-white"
                >
                  <option value="Class 1">Class 1</option>
                  <option value="Class 2">Class 2</option>
                  <option value="Class 3">Class 3</option>
                  <option value="Class 4">Class 4</option>
                  <option value="Class 5">Class 5</option>
                  <option value="Class 6">Class 6</option>
                  <option value="Class 7">Class 7</option>
                  <option value="Class 8">Class 8</option>
                  <option value="Class 9">Class 9</option>
                  <option value="Class 10">Class 10</option>
                  <option value="Class 11">Class 11</option>
                  <option value="Class 12">Class 12</option>
                </select>
              </div>

              <div>
                <label className="block text-xs font-semibold text-slate-700 mb-1">Section</label>
                <select
                  value={section}
                  onChange={(e) => setSection(e.target.value)}
                  className="w-full rounded-xl border border-slate-200 px-3.5 py-2 text-xs text-slate-900 focus:border-sky-500 focus:ring-2 focus:ring-sky-500/10 outline-none bg-white"
                >
                  <option value="A">Section A</option>
                  <option value="B">Section B</option>
                  <option value="C">Section C</option>
                  <option value="D">Section D</option>
                </select>
              </div>

              <div>
                <label className="block text-xs font-semibold text-slate-700 mb-1">Class Roll No</label>
                <input
                  type="text"
                  placeholder={`e.g. ${nextSeq}`}
                  value={rollNo}
                  onChange={(e) => setRollNo(e.target.value)}
                  className="w-full rounded-xl border border-slate-200 px-3.5 py-2 text-xs text-slate-900 focus:border-sky-500 focus:ring-2 focus:ring-sky-500/10 outline-none"
                />
              </div>
            </div>
          </div>

          {/* Section 3: Guardian Details */}
          <div className="pt-2 border-t border-slate-100">
            <h4 className="text-xs font-bold uppercase tracking-wider text-slate-500 mb-3 flex items-center gap-2">
              <span className="size-1.5 rounded-full bg-amber-500" />
              3. Parent / Guardian Details
            </h4>
            <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
              <div>
                <label className="block text-xs font-semibold text-slate-700 mb-1">Parent Full Name</label>
                <input
                  type="text"
                  placeholder="e.g. Rajesh Sharma"
                  value={guardianName}
                  onChange={(e) => setGuardianName(e.target.value)}
                  className="w-full rounded-xl border border-slate-200 px-3.5 py-2 text-xs text-slate-900 focus:border-sky-500 focus:ring-2 focus:ring-sky-500/10 outline-none"
                />
              </div>

              <div>
                <label className="block text-xs font-semibold text-slate-700 mb-1">Relationship</label>
                <select
                  value={guardianRelation}
                  onChange={(e) => setGuardianRelation(e.target.value)}
                  className="w-full rounded-xl border border-slate-200 px-3.5 py-2 text-xs text-slate-900 focus:border-sky-500 focus:ring-2 focus:ring-sky-500/10 outline-none bg-white"
                >
                  <option value="Father">Father</option>
                  <option value="Mother">Mother</option>
                  <option value="Guardian">Legal Guardian</option>
                </select>
              </div>

              <div>
                <label className="block text-xs font-semibold text-slate-700 mb-1">Parent Mobile</label>
                <input
                  type="tel"
                  placeholder="+91-9812345678"
                  value={guardianPhone}
                  onChange={(e) => setGuardianPhone(e.target.value)}
                  className="w-full rounded-xl border border-slate-200 px-3.5 py-2 text-xs text-slate-900 focus:border-sky-500 focus:ring-2 focus:ring-sky-500/10 outline-none"
                />
              </div>
            </div>

            <div className="mt-3">
              <label className="block text-xs font-semibold text-slate-700 mb-1">Residential Address</label>
              <input
                type="text"
                placeholder="House #, Street, Area, City"
                value={address}
                onChange={(e) => setAddress(e.target.value)}
                className="w-full rounded-xl border border-slate-200 px-3.5 py-2 text-xs text-slate-900 focus:border-sky-500 focus:ring-2 focus:ring-sky-500/10 outline-none"
              />
            </div>
          </div>

          {/* Form Actions */}
          <div className="flex items-center justify-end gap-3 pt-4 border-t border-slate-100">
            <button
              type="button"
              onClick={onClose}
              disabled={isSubmitting}
              className="rounded-xl border border-slate-200 px-4 py-2.5 text-xs font-semibold text-slate-700 hover:bg-slate-50 transition"
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={isSubmitting}
              className="flex items-center gap-2 rounded-xl bg-sky-500 px-5 py-2.5 text-xs font-semibold text-white shadow-md shadow-sky-500/25 bg-gradient-to-r from-sky-500 to-sky-600 hover:from-sky-600 hover:to-sky-700 transition disabled:opacity-50"
            >
              {isSubmitting ? (
                <>
                  <span className="size-3.5 animate-spin rounded-full border-2 border-white/30 border-t-white" />
                  Registering...
                </>
              ) : (
                <>
                  Enroll Student ({previewStudentId})
                </>
              )}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
