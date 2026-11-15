import { describe, expect, it } from "vitest";
import { normalizePhone } from "../../lib/sms";
import { render, toHtml } from "./messaging.service";

describe("normalizePhone", () => {
  it("adds the Indian country code to a 10-digit mobile number", () => {
    expect(normalizePhone("98765 43210")).toBe("919876543210");
    expect(normalizePhone("+91-98765-43210")).toBe("919876543210");
    expect(normalizePhone("0091 9876543210")).toBe("919876543210");
    expect(normalizePhone("919876543210")).toBe("919876543210");
  });
  it("accepts other international numbers", () => {
    expect(normalizePhone("+44 7911 123456")).toBe("447911123456");
  });
  it.each(["", "abc", "12345", "5876543210", "91 5876543210", "+91 98765", "98765432101234567"])("rejects %j", (bad) => {
    expect(normalizePhone(bad)).toBeNull();
  });
});

describe("render", () => {
  it("fills known placeholders and blanks unknown ones", () => {
    expect(render("Hi {{name}}, due {{ date }} {{missing}}!", { name: "Asha", date: "1 Jan" })).toBe("Hi Asha, due 1 Jan !");
  });
  it("does not interpret values as templates", () => {
    expect(render("{{a}}", { a: "{{b}}", b: "secret" })).toBe("{{b}}");
  });
});

describe("toHtml", () => {
  it("escapes markup so message content cannot inject HTML", () => {
    const html = toHtml('Hello <script>alert(1)</script> & "friends"');
    expect(html).not.toContain("<script>");
    expect(html).toContain("&lt;script&gt;");
    expect(html).toContain("&amp;");
  });
  it("turns paragraphs, line breaks and links into HTML", () => {
    const html = toHtml("Line one\nLine two\n\nPay at https://example.com/pay now");
    expect(html.match(/<p /g)).toHaveLength(2);
    expect(html).toContain("<br>");
    expect(html).toContain('<a href="https://example.com/pay">https://example.com/pay</a>');
  });
});

describe("placeholderOrder", () => {
  it("lists placeholders in the order of a template's numbered slots, once each", async () => {
    const { placeholderOrder } = await import("../../lib/whatsapp");
    expect(placeholderOrder("{{platform_name}}: {{message}} - {{ platform_name }} {{admin_name}}")).toEqual(["platform_name", "message", "admin_name"]);
  });
});
