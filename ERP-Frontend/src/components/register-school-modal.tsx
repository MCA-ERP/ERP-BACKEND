"use client";

import { useState } from "react";
import { registerSchool, SchoolRecord } from "@/lib/api";

interface RegisterSchoolModalProps {
  isOpen: boolean;
  onClose: () => void;
  onSchoolRegistered: (school: SchoolRecord) => void;
}

export function RegisterSchoolModal({
  isOpen,
  onClose,
  onSchoolRegistered,
}: RegisterSchoolModalProps) {
  const [name, setName] = useState("");
  const [code, setCode] = useState("");
  const [type, setType] = useState("High School");
  const [principalEmail, setPrincipalEmail] = useState("");
  const [contactPhone, setContactPhone] = useState("");
  const [city, setCity] = useState("");
  const [state, setState] = useState("Karnataka");
  const [address, setAddress] = useState("");
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [errorMsg, setErrorMsg] = useState("");

  if (!isOpen) return null;

  // Auto-generate 3-letter school code from name if user hasn't typed a custom one
  const autoCode = name.replace(/[^a-zA-Z]/g, "").substring(0, 3).toUpperCase();
  const effectiveCode = (code.trim() || autoCode || "SCH").toUpperCase();

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setErrorMsg("");

    if (!name.trim()) {
      setErrorMsg("School name is required.");
      return;
    }

    setIsSubmitting(true);
    try {
      const res = await registerSchool({
        name: name.trim(),
        code: effectiveCode,
        type,
        contact_email: principalEmail.trim() || `principal@${effectiveCode.toLowerCase()}.edu`,
        contact_phone: contactPhone.trim(),
        city: city.trim(),
        state,
        address: address.trim(),
      });

      if (res.success && res.school) {
        onSchoolRegistered(res.school);
        onClose();
      } else {
        setErrorMsg("Failed to register school.");
      }
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : "Registration failed.";
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
      <div className="relative w-full max-w-xl rounded-2xl bg-white shadow-2xl border border-sky-100 z-10 overflow-hidden animate-in fade-in zoom-in-95 duration-200 my-8">
        {/* Header - Modern Sky Blue Gradient */}
        <div className="bg-gradient-to-r from-[#0f172a] via-[#0284c7] to-[#0ea5e9] px-6 py-5 text-white">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-3">
              <span className="flex size-10 items-center justify-center rounded-xl bg-white/15 text-white ring-1 ring-white/25 shadow-sm">
                <svg viewBox="0 0 24 24" fill="none" className="size-5" aria-hidden="true">
                  <path d="M12 21v-8.25M15.75 21v-8.25M8.25 21v-8.25M3 9l9-6 9 6m-1.5 12V10.333M4.5 21V10.333" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
                </svg>
              </span>
              <div>
                <h3 className="text-lg font-bold tracking-tight text-white">
                  Register New School (SuperAdmin)
                </h3>
                <p className="text-xs text-sky-100">
                  Provision new institution node with unique School Code
                </p>
              </div>
            </div>

            <button
              type="button"
              onClick={onClose}
              className="rounded-lg p-1.5 text-sky-100 hover:bg-white/10 hover:text-white transition"
            >
              <svg viewBox="0 0 20 20" fill="currentColor" className="size-5">
                <path fillRule="evenodd" d="M4.293 4.293a1 1 0 011.414 0L10 8.586l4.293-4.293a1 1 0 111.414 1.414L11.414 10l4.293 4.293a1 1 0 01-1.414 1.414L10 11.414l-4.293 4.293a1 1 0 01-1.414-1.414L8.586 10 4.293 5.707a1 1 0 010-1.414z" clipRule="evenodd" />
              </svg>
            </button>
          </div>

          <div className="mt-4 flex items-center justify-between rounded-xl bg-white/10 px-4 py-2 border border-white/15">
            <span className="text-xs font-medium text-sky-100">Assigned School Code:</span>
            <span className="rounded-md bg-white px-2.5 py-0.5 text-xs font-black tracking-wider text-sky-700 shadow-sm">
              {effectiveCode}
            </span>
          </div>
        </div>

        {/* Form Body */}
        <form onSubmit={handleSubmit} className="p-6 space-y-4">
          {errorMsg && (
            <div className="rounded-xl bg-rose-50 border border-rose-200 p-3 text-xs font-medium text-rose-700">
              {errorMsg}
            </div>
          )}

          <div>
            <label className="block text-xs font-semibold text-slate-700 mb-1">
              School Full Name <span className="text-rose-500">*</span>
            </label>
            <input
              type="text"
              required
              placeholder="e.g. Ravindra English Medium High School"
              value={name}
              onChange={(e) => setName(e.target.value)}
              className="w-full rounded-xl border border-slate-200 px-3.5 py-2 text-xs text-slate-900 focus:border-sky-500 focus:ring-2 focus:ring-sky-500/10 outline-none"
            />
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <div>
              <label className="block text-xs font-semibold text-slate-700 mb-1">
                School Code (3-4 Letters)
              </label>
              <input
                type="text"
                maxLength={6}
                placeholder={`Auto: ${autoCode || "RAV"}`}
                value={code}
                onChange={(e) => setCode(e.target.value.toUpperCase())}
                className="w-full rounded-xl border border-slate-200 px-3.5 py-2 text-xs font-mono uppercase text-slate-900 focus:border-sky-500 focus:ring-2 focus:ring-sky-500/10 outline-none"
              />
              <p className="mt-1 text-[11px] text-slate-400">Used for student IDs (e.g. {effectiveCode}ST001)</p>
            </div>

            <div>
              <label className="block text-xs font-semibold text-slate-700 mb-1">Institution Type</label>
              <select
                value={type}
                onChange={(e) => setType(e.target.value)}
                className="w-full rounded-xl border border-slate-200 px-3.5 py-2 text-xs text-slate-900 focus:border-sky-500 focus:ring-2 focus:ring-sky-500/10 outline-none bg-white"
              >
                <option value="High School">High School</option>
                <option value="Primary School">Primary School</option>
                <option value="Higher Secondary (10+2)">Higher Secondary (10+2)</option>
                <option value="College">College</option>
                <option value="University">University</option>
              </select>
            </div>
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <div>
              <label className="block text-xs font-semibold text-slate-700 mb-1">Principal / Admin Email</label>
              <input
                type="email"
                placeholder="principal@school.edu"
                value={principalEmail}
                onChange={(e) => setPrincipalEmail(e.target.value)}
                className="w-full rounded-xl border border-slate-200 px-3.5 py-2 text-xs text-slate-900 focus:border-sky-500 focus:ring-2 focus:ring-sky-500/10 outline-none"
              />
            </div>

            <div>
              <label className="block text-xs font-semibold text-slate-700 mb-1">Contact Phone</label>
              <input
                type="tel"
                placeholder="+91-9876543210"
                value={contactPhone}
                onChange={(e) => setContactPhone(e.target.value)}
                className="w-full rounded-xl border border-slate-200 px-3.5 py-2 text-xs text-slate-900 focus:border-sky-500 focus:ring-2 focus:ring-sky-500/10 outline-none"
              />
            </div>
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <div>
              <label className="block text-xs font-semibold text-slate-700 mb-1">City</label>
              <input
                type="text"
                placeholder="e.g. Bangalore"
                value={city}
                onChange={(e) => setCity(e.target.value)}
                className="w-full rounded-xl border border-slate-200 px-3.5 py-2 text-xs text-slate-900 focus:border-sky-500 focus:ring-2 focus:ring-sky-500/10 outline-none"
              />
            </div>

            <div>
              <label className="block text-xs font-semibold text-slate-700 mb-1">State</label>
              <input
                type="text"
                placeholder="e.g. Karnataka"
                value={state}
                onChange={(e) => setState(e.target.value)}
                className="w-full rounded-xl border border-slate-200 px-3.5 py-2 text-xs text-slate-900 focus:border-sky-500 focus:ring-2 focus:ring-sky-500/10 outline-none"
              />
            </div>
          </div>

          <div>
            <label className="block text-xs font-semibold text-slate-700 mb-1">Campus Address</label>
            <input
              type="text"
              placeholder="Main Campus Road, Sector..."
              value={address}
              onChange={(e) => setAddress(e.target.value)}
              className="w-full rounded-xl border border-slate-200 px-3.5 py-2 text-xs text-slate-900 focus:border-sky-500 focus:ring-2 focus:ring-sky-500/10 outline-none"
            />
          </div>

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
              className="flex items-center gap-2 rounded-xl bg-gradient-to-r from-sky-500 to-sky-600 hover:from-sky-600 hover:to-sky-700 px-5 py-2.5 text-xs font-semibold text-white shadow-md shadow-sky-500/25 transition disabled:opacity-50"
            >
              {isSubmitting ? (
                <>
                  <span className="size-3.5 animate-spin rounded-full border-2 border-white/30 border-t-white" />
                  Creating School...
                </>
              ) : (
                <>Register School ({effectiveCode})</>
              )}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
