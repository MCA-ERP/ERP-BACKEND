import { describe, expect, it } from "vitest";
import { clientIp, ipMatches, normalizeCidr } from "./security.service";

describe("normalizeCidr", () => {
  it("accepts single addresses and ranges", () => {
    expect(normalizeCidr(" 203.0.113.7 ")).toBe("203.0.113.7");
    expect(normalizeCidr("203.0.113.0/24")).toBe("203.0.113.0/24");
    expect(normalizeCidr("10.0.0.1/32")).toBe("10.0.0.1");
    expect(normalizeCidr("2001:DB8::1")).toBe("2001:db8::1");
  });

  it.each(["", "not an ip", "999.1.1.1", "10.0.0.0/33", "10.0.0.0/-1", "10.0.0.0/8/8", "2001:db8::/32"])("rejects %j", (bad) => {
    expect(() => normalizeCidr(bad)).toThrow();
  });
});

describe("ipMatches", () => {
  it("matches within a range and not outside it", () => {
    expect(ipMatches("203.0.113.77", "203.0.113.0/24")).toBe(true);
    expect(ipMatches("203.0.114.1", "203.0.113.0/24")).toBe(false);
    expect(ipMatches("10.1.2.3", "10.0.0.0/8")).toBe(true);
    expect(ipMatches("11.0.0.1", "10.0.0.0/8")).toBe(false);
  });
  it("handles single addresses, /0 and IPv6 exact matches", () => {
    expect(ipMatches("127.0.0.1", "127.0.0.1")).toBe(true);
    expect(ipMatches("127.0.0.2", "127.0.0.1")).toBe(false);
    expect(ipMatches("8.8.8.8", "0.0.0.0/0")).toBe(true);
    expect(ipMatches("2001:db8::1", "2001:db8::1")).toBe(true);
    expect(ipMatches("2001:db8::2", "2001:db8::1")).toBe(false);
  });
});

describe("clientIp", () => {
  const req = (ip?: string, remote?: string) => ({ ip, socket: { remoteAddress: remote } }) as never;
  it("normalises IPv4-mapped and loopback addresses", () => {
    expect(clientIp(req("::ffff:203.0.113.9"))).toBe("203.0.113.9");
    expect(clientIp(req("::1"))).toBe("127.0.0.1");
  });
  it("falls back to the socket address", () => {
    expect(clientIp(req(undefined, "198.51.100.2"))).toBe("198.51.100.2");
  });
});
