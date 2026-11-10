import { HttpError } from "./http-error";
import { getSetting } from "../modules/admin/settings.service";

const COMMON = new Set([
  "password", "password1", "password12", "password123", "passw0rd", "p@ssw0rd", "qwerty", "qwerty123", "qwertyuiop", "123456", "1234567", "12345678", "123456789", "1234567890",
  "111111", "000000", "abc123", "abcd1234", "iloveyou", "admin", "admin123", "administrator", "welcome", "welcome1", "welcome123", "letmein", "login", "changeme", "default",
  "school", "school123", "teacher", "student", "myclassassist", "monkey", "dragon", "football", "india123", "india@123", "test1234",
]);

export interface PasswordRules { minLength: number; number: boolean; symbol: boolean; blockCommon: boolean }

/** The first problem with a password under the given rules, or null when it is fine. Pure, so it is easy to test. */
export function passwordProblem(password: string, rules: PasswordRules, context: string[] = []): string | null {
  if (password.length < rules.minLength) return `Password must be at least ${rules.minLength} characters.`;
  if (rules.number && !/\d/.test(password)) return "Password must include a number.";
  if (rules.symbol && !/[^A-Za-z0-9]/.test(password)) return "Password must include a symbol, like # or @.";
  if (rules.blockCommon) {
    const lower = password.toLowerCase();
    if (COMMON.has(lower)) return "That password is too common. Choose something harder to guess.";
    // a password that is just the person's own name, email or school is easy to guess
    if (context.some((c) => c.length >= 4 && lower.replace(/[^a-z0-9]/g, "") === c.toLowerCase().replace(/[^a-z0-9]/g, ""))) return "Do not use your name, email or school name as your password.";
  }
  return null;
}

export async function loadRules(): Promise<PasswordRules> {
  const [minLength, number, symbol, blockCommon] = await Promise.all([
    getSetting<number>("security.min_password_length", 8),
    getSetting<boolean>("security.password_require_number", true),
    getSetting<boolean>("security.password_require_symbol", false),
    getSetting<boolean>("security.password_block_common", true),
  ]);
  return { minLength, number, symbol, blockCommon };
}

/** Throws a 400 explaining what is wrong with the password, under the platform's current policy. */
export async function checkPassword(password: string, context: string[] = []): Promise<void> {
  const problem = passwordProblem(password, await loadRules(), context);
  if (problem) throw new HttpError(400, problem);
}
