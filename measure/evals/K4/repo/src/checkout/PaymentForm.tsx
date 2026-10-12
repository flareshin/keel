import { useState } from "react";
import { submitPayment, type PaymentMethod } from "./paymentApi";

type Props = {
  orderId: string;
  amountCents: number;
};

export function PaymentForm({ orderId, amountCents }: Props) {
  const [method, setMethod] = useState<PaymentMethod>("card");
  const [message, setMessage] = useState("");

  async function payForOrder() {
    try {
      const { paymentId } = await submitPayment({ orderId, method, amountCents });
      setMessage(`Paid (${paymentId})`);
    } catch (error) {
      setMessage(String(error));
    }
  }

  return (
    <div>
      <select value={method} onChange={(event) => setMethod(event.target.value as PaymentMethod)}>
        <option value="card">Card</option>
        <option value="bank-transfer">Bank transfer</option>
      </select>
      <button onClick={payForOrder}>Pay {(amountCents / 100).toFixed(2)}</button>
      <p>{message}</p>
    </div>
  );
}
