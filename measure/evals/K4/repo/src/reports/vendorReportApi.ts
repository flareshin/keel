export type VendorReportRow = {
  vendor: string;
  unitsSold: number;
  revenueCents: number;
};

export async function fetchVendorReport(month: string): Promise<VendorReportRow[]> {
  const response = await fetch(`/api/reports/vendors?month=${month}`);
  return response.json();
}
