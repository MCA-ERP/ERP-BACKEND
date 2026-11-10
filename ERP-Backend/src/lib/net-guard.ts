import dns from "dns";
import net from "net";
import { HttpError } from "./http-error";

/** True for addresses a server must never call on a user's behalf: loopback, private, link-local, etc. */
export function isPrivateIp(ip: string): boolean {
  if (net.isIPv6(ip)) {
    const v = ip.toLowerCase();
    if (v.startsWith("::ffff:")) return isPrivateIp(v.slice(7)); // IPv4-mapped
    return v === "::1" || v === "::" || /^f[cd]/.test(v) || /^fe[89ab]/.test(v) || v.startsWith("ff");
  }
  if (!net.isIPv4(ip)) return true;
  const [a, b] = ip.split(".").map(Number);
  return (
    a === 0 || a === 10 || a === 127 ||
    (a === 100 && b >= 64 && b <= 127) || // carrier-grade NAT
    (a === 169 && b === 254) || // link-local, incl. cloud metadata
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    (a === 192 && b === 0) ||
    (a === 198 && (b === 18 || b === 19)) ||
    a >= 224 // multicast and reserved
  );
}

/**
 * Validates a URL a user asked us to call (webhooks). It must be https, carry no credentials,
 * and resolve only to public addresses, so it cannot be used to reach internal services.
 * Local http targets are allowed only when ALLOW_PRIVATE_WEBHOOKS=true outside production.
 */
export async function assertPublicUrl(raw: string): Promise<URL> {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new HttpError(400, "Enter a full address, for example https://example.com/hook.");
  }
  const relaxed = process.env.ALLOW_PRIVATE_WEBHOOKS === "true" && process.env.NODE_ENV !== "production";

  if (url.protocol !== "https:" && !(relaxed && url.protocol === "http:")) throw new HttpError(400, "The address must start with https://.");
  if (url.username || url.password) throw new HttpError(400, "The address must not contain a username or password.");
  if (relaxed) return url;

  const host = url.hostname.replace(/^\[|\]$/g, "");
  let addresses: string[];
  if (net.isIP(host)) addresses = [host];
  else {
    try {
      addresses = (await dns.promises.lookup(host, { all: true })).map((a) => a.address);
    } catch {
      throw new HttpError(400, `The host "${host}" could not be found.`);
    }
  }
  if (!addresses.length || addresses.some(isPrivateIp)) throw new HttpError(400, "The address points to a private or internal network, which is not allowed.");
  return url;
}
