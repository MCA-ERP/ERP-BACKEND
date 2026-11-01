"use client";

import { useState, useEffect } from "react";
import { SchoolRecord } from "@/lib/api";

interface ManageSchoolModalProps {
  isOpen: boolean;
  onClose: () => void;
  school: SchoolRecord | null;
  onUpdateSchool: (updated: SchoolRecord) => void;
  onSwitchSchool: (school: SchoolRecord) => void;
}

export function ManageSchoolModal({
  isOpen,
  onClose,
  school,
  onUpdateSchool,
  onSwitchSchool,
}: ManageSchoolModalProps) {
  const [name, setName] = useState("");
  const [code, setCode] = useState("");
  const [type, setType] = useState("High School");
  const [contactEmail, setContactEmail] = useState("");
  const [contactPhone, setContactPhone] = useState("");
  const [city, setCity] = useState("");
  const [state, setState] = useState("");
  const [address, setAddress] = useState("");
  const [isActive, setIsActive] = useState(true);
  const [copiedCode, setCopiedCode] = useState(false);
  const [saveSuccess, setSaveSuccess] = useState(false);

  useEffect(() => {
    if (school) {
      setName(school.name || "");
      setCode(school.code || "");
      setType(school.type || "High School");
      setContactEmail(school.contact_email || "");
      setContactPhone(school.contact_phone || "");
      setCity(school.city || "");
      setState(school.state || "");
      setAddress(school.address || "");
      setIsActive(school.is_active !== false);
      setSaveSuccess(false);
    }
  }, [school]);

  if (!isOpen || !school) return null;

  const handleCopyCode = () => {
    if (typeof navigator !== "undefined" && navigator.clipboard) {
      navigator.clipboard.writeText(code);
      setCopiedCode(true);
      setTimeout(() => setCopiedCode(false), 2000);
    }
  };

  const handleSave = (e: React.FormEvent) => {
    e.preventDefault();
    const updated: SchoolRecord = {
      ...school,
      name: name.trim(),
      code: code.trim().toUpperCase(),
      type,
      contact_email: contactEmail.trim(),
      contact_phone: contactPhone.trim(),
      city: city.trim(),
      state: state.trim(),
      address: address.trim(),
      is_active: isActive,
    };
    onUpdateSchool(updated);
    setSaveSuccess(true);
    setTimeout(() => {
      setSaveSuccess(false);
      onClose();
    }, 900);
  };

  const handleSwitchAndGo = () => {
    onSwitchSchool(school);
    onClose();
  };

  return (
    <div
      style={{
        position: "fixed",
        inset: 0,
        zIndex: 9999,
        background: "rgba(15, 23, 42, 0.65)",
        backdropFilter: "blur(6px)",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        padding: "1rem",
        animation: "fadeIn 150ms ease-out",
      }}
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        style={{
          background: "#fff",
          borderRadius: "1.25rem",
          boxShadow: "0 25px 60px -15px rgba(15, 23, 42, 0.35)",
          width: "100%",
          maxWidth: "36rem",
          maxHeight: "92vh",
          overflowY: "auto",
          border: "1px solid #e2e8f0",
        }}
      >
        {/* Header banner */}
        <div
          style={{
            background: "linear-gradient(135deg, #0f172a 0%, #1e3a5f 100%)",
            color: "#fff",
            padding: "1.25rem 1.5rem",
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
          }}
        >
          <div style={{ display: "flex", alignItems: "center", gap: "0.875rem" }}>
            <div
              style={{
                width: "2.75rem",
                height: "2.75rem",
                borderRadius: "0.75rem",
                background: "rgba(255,255,255,0.15)",
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                fontSize: "1.35rem",
              }}
            >
              🏫
            </div>
            <div>
              <h2 style={{ fontSize: "1.1rem", fontWeight: 700, margin: 0, color: "#fff" }}>
                Manage Institution
              </h2>
              <p style={{ fontSize: "0.75rem", color: "#94a3b8", margin: 0 }}>
                Credentials, portal configuration & institution details
              </p>
            </div>
          </div>
          <button
            onClick={onClose}
            style={{
              background: "rgba(255,255,255,0.12)",
              border: "none",
              color: "#fff",
              width: "2rem",
              height: "2rem",
              borderRadius: "0.5rem",
              fontSize: "1.2rem",
              cursor: "pointer",
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
            }}
          >
            ×
          </button>
        </div>

        {/* Portal Access Callout Box */}
        <div style={{ padding: "1.25rem 1.5rem 0.5rem" }}>
          <div
            style={{
              background: "#f0fdfa",
              border: "1px solid #99f6e4",
              borderRadius: "0.75rem",
              padding: "1rem 1.125rem",
              display: "flex",
              flexDirection: "column",
              gap: "0.625rem",
            }}
          >
            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
              <div>
                <span style={{ fontSize: "0.7rem", fontWeight: 700, textTransform: "uppercase", letterSpacing: "0.08em", color: "#0f766e" }}>
                  Principal & Staff Login Code
                </span>
                <div style={{ display: "flex", alignItems: "center", gap: "0.625rem", marginTop: "0.25rem" }}>
                  <span
                    style={{
                      fontFamily: "monospace",
                      fontWeight: 800,
                      fontSize: "1.25rem",
                      letterSpacing: "0.12em",
                      color: "#0f172a",
                      background: "#fff",
                      padding: "0.25rem 0.625rem",
                      borderRadius: "0.375rem",
                      border: "1px solid #ccfbf1",
                    }}
                  >
                    {code}
                  </span>
                  <button
                    type="button"
                    onClick={handleCopyCode}
                    style={{
                      padding: "0.35rem 0.75rem",
                      borderRadius: "0.375rem",
                      border: "1px solid #0d9488",
                      background: copiedCode ? "#0d9488" : "#14b8a6",
                      color: "#fff",
                      fontSize: "0.75rem",
                      fontWeight: 600,
                      cursor: "pointer",
                    }}
                  >
                    {copiedCode ? "✓ Copied!" : "Copy Code"}
                  </button>
                </div>
              </div>

              {/* Switch active institution button */}
              <button
                type="button"
                onClick={handleSwitchAndGo}
                style={{
                  padding: "0.5rem 0.875rem",
                  borderRadius: "0.5rem",
                  border: "1px solid #0284c7",
                  background: "#0284c7",
                  color: "#fff",
                  fontSize: "0.75rem",
                  fontWeight: 700,
                  cursor: "pointer",
                  display: "flex",
                  alignItems: "center",
                  gap: "0.35rem",
                  boxShadow: "0 2px 4px rgba(2, 132, 199, 0.2)",
                }}
              >
                <span>⚡</span> Set as Active School
              </button>
            </div>

            <p style={{ fontSize: "0.72rem", color: "#0f766e", margin: 0, lineHeight: 1.4 }}>
              Principals, teachers, students, and parents can use code <strong>{code}</strong> at the{" "}
              <strong>Login Page</strong> to enter this school&apos;s campus portal.
            </p>
          </div>
        </div>

        {/* Edit Form */}
        <form onSubmit={handleSave} style={{ padding: "1rem 1.5rem 1.5rem" }}>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "0.875rem" }}>
            {/* School Name */}
            <div style={{ gridColumn: "span 2" }}>
              <label style={{ display: "block", fontSize: "0.75rem", fontWeight: 600, color: "#334155", marginBottom: "0.3rem" }}>
                Institution Name
              </label>
              <input
                type="text"
                value={name}
                onChange={(e) => setName(e.target.value)}
                required
                style={{
                  width: "100%",
                  padding: "0.6rem 0.75rem",
                  borderRadius: "0.5rem",
                  border: "1px solid #cbd5e1",
                  fontSize: "0.85rem",
                  fontWeight: 600,
                  color: "#0f172a",
                }}
              />
            </div>

            {/* School Code */}
            <div>
              <label style={{ display: "block", fontSize: "0.75rem", fontWeight: 600, color: "#334155", marginBottom: "0.3rem" }}>
                School Short Code (3 letters)
              </label>
              <input
                type="text"
                value={code}
                onChange={(e) => setCode(e.target.value.toUpperCase())}
                required
                maxLength={6}
                style={{
                  width: "100%",
                  padding: "0.6rem 0.75rem",
                  borderRadius: "0.5rem",
                  border: "1px solid #cbd5e1",
                  fontSize: "0.85rem",
                  fontFamily: "monospace",
                  fontWeight: 800,
                  letterSpacing: "0.08em",
                }}
              />
            </div>

            {/* Type */}
            <div>
              <label style={{ display: "block", fontSize: "0.75rem", fontWeight: 600, color: "#334155", marginBottom: "0.3rem" }}>
                Institution Type
              </label>
              <select
                value={type}
                onChange={(e) => setType(e.target.value)}
                style={{
                  width: "100%",
                  padding: "0.6rem 0.75rem",
                  borderRadius: "0.5rem",
                  border: "1px solid #cbd5e1",
                  fontSize: "0.85rem",
                }}
              >
                <option value="High School">High School</option>
                <option value="Junior College">Junior College</option>
                <option value="K-12 Academy">K-12 Academy</option>
                <option value="University">University / College</option>
                <option value="International School">International School</option>
              </select>
            </div>

            {/* Contact Email */}
            <div>
              <label style={{ display: "block", fontSize: "0.75rem", fontWeight: 600, color: "#334155", marginBottom: "0.3rem" }}>
                Contact / Principal Email
              </label>
              <input
                type="email"
                value={contactEmail}
                onChange={(e) => setContactEmail(e.target.value)}
                style={{
                  width: "100%",
                  padding: "0.6rem 0.75rem",
                  borderRadius: "0.5rem",
                  border: "1px solid #cbd5e1",
                  fontSize: "0.85rem",
                }}
              />
            </div>

            {/* Contact Phone */}
            <div>
              <label style={{ display: "block", fontSize: "0.75rem", fontWeight: 600, color: "#334155", marginBottom: "0.3rem" }}>
                Contact Phone
              </label>
              <input
                type="text"
                value={contactPhone}
                onChange={(e) => setContactPhone(e.target.value)}
                style={{
                  width: "100%",
                  padding: "0.6rem 0.75rem",
                  borderRadius: "0.5rem",
                  border: "1px solid #cbd5e1",
                  fontSize: "0.85rem",
                }}
              />
            </div>

            {/* City */}
            <div>
              <label style={{ display: "block", fontSize: "0.75rem", fontWeight: 600, color: "#334155", marginBottom: "0.3rem" }}>
                City
              </label>
              <input
                type="text"
                value={city}
                onChange={(e) => setCity(e.target.value)}
                style={{
                  width: "100%",
                  padding: "0.6rem 0.75rem",
                  borderRadius: "0.5rem",
                  border: "1px solid #cbd5e1",
                  fontSize: "0.85rem",
                }}
              />
            </div>

            {/* State */}
            <div>
              <label style={{ display: "block", fontSize: "0.75rem", fontWeight: 600, color: "#334155", marginBottom: "0.3rem" }}>
                State
              </label>
              <input
                type="text"
                value={state}
                onChange={(e) => setState(e.target.value)}
                style={{
                  width: "100%",
                  padding: "0.6rem 0.75rem",
                  borderRadius: "0.5rem",
                  border: "1px solid #cbd5e1",
                  fontSize: "0.85rem",
                }}
              />
            </div>

            {/* Status Switch */}
            <div style={{ gridColumn: "span 2", display: "flex", alignItems: "center", gap: "0.75rem", marginTop: "0.25rem" }}>
              <input
                id="is-active-chk"
                type="checkbox"
                checked={isActive}
                onChange={(e) => setIsActive(e.target.checked)}
                style={{ width: "1.1rem", height: "1.1rem", cursor: "pointer", accentColor: "#059669" }}
              />
              <label htmlFor="is-active-chk" style={{ fontSize: "0.8rem", fontWeight: 600, color: "#1e293b", cursor: "pointer" }}>
                School Status: <span style={{ color: isActive ? "#15803d" : "#dc2626" }}>{isActive ? "Active (Online)" : "Inactive"}</span>
              </label>
            </div>
          </div>

          {saveSuccess && (
            <p style={{ marginTop: "1rem", color: "#15803d", fontSize: "0.8rem", fontWeight: 600, textAlign: "center" }}>
              ✓ Changes saved successfully!
            </p>
          )}

          {/* Form Actions */}
          <div style={{ display: "flex", gap: "0.75rem", justifyContent: "flex-end", marginTop: "1.25rem", borderTop: "1px solid #f1f5f9", paddingTop: "1rem" }}>
            <button
              type="button"
              onClick={onClose}
              style={{
                padding: "0.6rem 1.125rem",
                borderRadius: "0.5rem",
                border: "1px solid #cbd5e1",
                background: "#fff",
                fontSize: "0.8rem",
                fontWeight: 600,
                color: "#475569",
                cursor: "pointer",
              }}
            >
              Cancel
            </button>
            <button
              type="submit"
              style={{
                padding: "0.6rem 1.25rem",
                borderRadius: "0.5rem",
                border: "none",
                background: "#0f172a",
                fontSize: "0.8rem",
                fontWeight: 700,
                color: "#fff",
                cursor: "pointer",
              }}
            >
              Save Changes
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
