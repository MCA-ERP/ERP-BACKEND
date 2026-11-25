/** Government identity numbers: only the last four characters of an Aadhaar are kept or shown. */
export const maskAadhaar = (value: unknown) => {
  const digits = String(value ?? "").replace(/\D/g, "");
  return digits.length >= 4 ? `XXXX XXXX ${digits.slice(-4)}` : "";
};
/** An admission application's details with its Aadhaar, if any, masked. */
export function hideAadhaar<T extends Record<string, unknown> | null | undefined>(details: T): T {
  if (!details || !details.aadhaar) return details;
  return { ...details, aadhaar: maskAadhaar(details.aadhaar) } as T;
}
/** Whether a typed value is a whole Aadhaar number, or empty. */
export const aadhaarOk = (value: unknown) => { const s = String(value ?? "").trim(); return !s || /^\d{4}[\s-]?\d{4}[\s-]?\d{4}$/.test(s); };
