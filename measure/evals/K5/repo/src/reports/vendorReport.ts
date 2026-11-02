export async function fetchVendorSummary(vendorId: string): Promise<any> {
  const res = await fetch(`/api/vendors/${vendorId}/summary`)
  const data = await res.json()
  return data
}

export async function fetchVendorList(): Promise<any> {
  const res = await fetch("/api/vendors")
  const result = await res.json()
  return result.items
}
