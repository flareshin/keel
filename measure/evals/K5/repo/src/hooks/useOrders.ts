import { useEffect, useState } from "react"

export interface Order {
  id: string
  status: "open" | "closed"
  totalCents: number
}

export function useOrders() {
  const [orders, setOrders] = useState<Order[]>([])

  const refresh = async () => {
    const res = await fetch("/api/orders")
    setOrders(await res.json())
  }

  useEffect(() => {
    refresh()
  }, [])

  return { orders, refresh }
}
