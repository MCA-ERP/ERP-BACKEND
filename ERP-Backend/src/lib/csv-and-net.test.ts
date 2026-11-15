import { describe, expect, it } from "vitest";
import { csvCell, toCsv } from "./csv";
import { isPrivateIp, assertPublicUrl } from "./net-guard";
import { signPayload } from "../modules/integrations/events";

describe("csvCell", () => {
  it("quotes values that need it", () => {
    expect(csvCell('say "hi", ok')).toBe('"say ""hi"", ok"');
    expect(csvCell("line\nbreak")).toBe('"line\nbreak"');
    expect(csvCell(null)).toBe("");
    expect(csvCell(42)).toBe("42");
  });
  it("neutralises spreadsheet formulas but keeps real numbers", () => {
    expect(csvCell("=HYPERLINK(\"http://evil\")")).toBe(`"'=HYPERLINK(""http://evil"")"`);
    expect(csvCell("+91 98000 00000")).toBe("'+91 98000 00000");
    expect(csvCell("@cmd")).toBe("'@cmd");
    expect(csvCell("-5.00")).toBe("-5.00");
    expect(csvCell(-5)).toBe("-5");
  });
});

describe("toCsv", () => {
  it("writes a BOM, CRLF line breaks and a trailing newline", () => {
    const out = toCsv(["a", "b"], [[1, "x"], [2, "y,z"]]);
    expect(out.startsWith("﻿")).toBe(true);
    expect(out).toBe('﻿a,b\r\n1,x\r\n2,"y,z"\r\n');
  });
});

describe("isPrivateIp", () => {
  it.each(["127.0.0.1", "10.1.2.3", "172.16.0.1", "172.31.255.255", "192.168.1.1", "169.254.169.254", "100.64.0.1", "0.0.0.0", "::1", "fe80::1", "fd00::1", "::ffff:10.0.0.1", "224.0.0.1"])("%s is private", (ip) => {
    expect(isPrivateIp(ip)).toBe(true);
  });
  it.each(["8.8.8.8", "1.1.1.1", "172.32.0.1", "203.0.113.5", "2606:4700:4700::1111"])("%s is public", (ip) => {
    expect(isPrivateIp(ip)).toBe(false);
  });
});

describe("assertPublicUrl", () => {
  it("rejects non-https, credentials, junk and internal addresses", async () => {
    await expect(assertPublicUrl("http://example.com/x")).rejects.toThrow(/https/);
    await expect(assertPublicUrl("https://user:pw@example.com/x")).rejects.toThrow(/username/);
    await expect(assertPublicUrl("not a url")).rejects.toThrow();
    await expect(assertPublicUrl("https://127.0.0.1/hook")).rejects.toThrow(/private/);
    await expect(assertPublicUrl("https://169.254.169.254/latest/meta-data")).rejects.toThrow(/private/);
    await expect(assertPublicUrl("https://[::1]/hook")).rejects.toThrow(/private/);
  });
  it("accepts a public address", async () => {
    await expect(assertPublicUrl("https://8.8.8.8/hook")).resolves.toBeInstanceOf(URL);
  });
});

describe("signPayload", () => {
  it("is stable for the same input and changes with the body, time or secret", () => {
    const base = signPayload("s", 1700000000, "{}");
    expect(base).toBe(signPayload("s", 1700000000, "{}"));
    expect(base).toMatch(/^[0-9a-f]{64}$/);
    expect(signPayload("s", 1700000000, "{ }")).not.toBe(base);
    expect(signPayload("s", 1700000001, "{}")).not.toBe(base);
    expect(signPayload("t", 1700000000, "{}")).not.toBe(base);
  });
});
