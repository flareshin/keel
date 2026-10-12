import { afterEach, describe, expect, it, vi } from "vitest";
import { submitPayment } from "./paymentApi";

describe("submitPayment", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("returns the payment id when the server accepts", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true, json: async () => ({ paymentId: "p-1" }) }));
    await expect(submitPayment({ orderId: "o-1", method: "card", amountCents: 1200 })).resolves.toEqual({ paymentId: "p-1" });
  });

  it("throws when the server rejects", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: false, status: 402 }));
    await expect(submitPayment({ orderId: "o-1", method: "card", amountCents: 1200 })).rejects.toThrow("402");
  });
});
