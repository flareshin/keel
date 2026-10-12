export type PaymentMethod = "card" | "bank-transfer";

export type PaymentRequest = {
  orderId: string;
  method: PaymentMethod;
  amountCents: number;
};

export async function submitPayment(request: PaymentRequest): Promise<{ paymentId: string }> {
  const response = await fetch("/api/payments", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(request),
  });
  if (!response.ok) {
    throw new Error(`Payment failed with status ${response.status}`);
  }
  return response.json();
}
