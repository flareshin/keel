import { useState } from "react";

export function PayoutSettings() {
  const [payoutDay, setPayoutDay] = useState("friday");

  return (
    <div>
      <h1>Vendor payouts</h1>
      <label>
        Payout day
        <select value={payoutDay} onChange={(event) => setPayoutDay(event.target.value)}>
          <option value="monday">Monday</option>
          <option value="friday">Friday</option>
        </select>
      </label>
    </div>
  );
}
