import { useEffect, useState } from "react";

export type OrderStatus = "open" | "shipped" | "cancelled";

export type Order = {
  id: string;
  status: OrderStatus;
  channel: "branch" | "online";
  totalCents: number;
};

export function useOrders() {
  const [orders, setOrders] = useState<Order[]>([]);

  useEffect(() => {
    fetch("/api/orders")
      .then((response) => response.json())
      .then((body: Order[]) => setOrders(body));
  }, []);

  return { orders };
}
