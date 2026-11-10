export type CsvValue = string | number | boolean | null | undefined;

const PLAIN_NUMBER = /^-?\d+(\.\d+)?$/;

/**
 * One CSV cell. Quotes when needed, and neutralises spreadsheet formulas: text that starts with
 * = + - @ (or a tab/CR) would otherwise run as a formula when the file is opened in Excel.
 * Real numbers, including negative ones, are left alone.
 */
export function csvCell(value: CsvValue): string {
  if (value === null || value === undefined) return "";
  let s = String(value);
  if (typeof value === "string" && /^[=+\-@\t\r]/.test(s) && !PLAIN_NUMBER.test(s)) s = `'${s}`;
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

/** Excel-friendly CSV: UTF-8 with a byte-order mark and CRLF line breaks. */
export function toCsv(headers: string[], rows: CsvValue[][]): string {
  const lines = [headers.map(csvCell).join(","), ...rows.map((r) => r.map(csvCell).join(","))];
  return "﻿" + lines.join("\r\n") + "\r\n";
}
