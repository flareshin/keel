import { useState } from "react";
import { RegionFilter } from "../components/RegionFilter";

const STOCK = [
  { sku: "TEA-001", region: "North", branch: "Downtown", onHand: 42 },
  { sku: "TEA-002", region: "South", branch: "Harbor", onHand: 7 },
];

export function InventoryScreen() {
  const [groupBy, setGroupBy] = useState<"region" | "branch">("branch");

  return (
    <div>
      <h1>Inventory</h1>
      <RegionFilter value={groupBy} onChange={setGroupBy} />
      <table>
        <thead>
          <tr><th>SKU</th><th>{groupBy === "branch" ? "Branch" : "Region"}</th><th>On hand</th></tr>
        </thead>
        <tbody>
          {STOCK.map((row) => (
            <tr key={row.sku}><td>{row.sku}</td><td>{row[groupBy]}</td><td>{row.onHand}</td></tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
