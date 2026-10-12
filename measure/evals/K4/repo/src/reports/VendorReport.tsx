import { useEffect, useState } from "react";
import { fetchVendorReport, type VendorReportRow } from "./vendorReportApi";

export function VendorReport({ month }: { month: string }) {
  const [rows, setRows] = useState<VendorReportRow[]>([]);

  useEffect(() => {
    fetchVendorReport(month).then(setRows);
  }, [month]);

  return (
    <table>
      <thead>
        <tr><th>Vendor</th><th>Units</th><th>Revenue</th></tr>
      </thead>
      <tbody>
        {rows.map((row) => (
          <tr key={row.vendor}><td>{row.vendor}</td><td>{row.unitsSold}</td><td>{(row.revenueCents / 100).toFixed(2)}</td></tr>
        ))}
      </tbody>
    </table>
  );
}
