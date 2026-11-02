export type Bin = { aisle: string; shelf: number; sku: string | null }

// a bin is free when nothing is stored in it
export function isFree(bin: Bin): boolean {
  return bin.sku === null
}

/** Formats a bin as A-03. */
export function binLabel(bin: Bin): string {
  // pad the shelf to two digits
  return `${bin.aisle}-${String(bin.shelf).padStart(2, "0")}`
}
