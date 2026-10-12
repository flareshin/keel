import { useState } from "react";
import { StatusFilterBar } from "../components/StatusFilterBar";
import { useOrders, type OrderStatus } from "../hooks/useOrders";

export function OrdersScreen() {
  const { orders } = useOrders();
  const [status, setStatus] = useState<OrderStatus | "all">("all");
  const [channel, setChannel] = useState<"all" | "branch" | "online">("all");
  const visibleOrders = orders.filter(
    (order) => (status === "all" || order.status === status) && (channel === "all" || order.channel === channel),
  );

  return (
    <div>
      <h1>Orders</h1>
      <StatusFilterBar status={status} channel={channel} onStatusChange={setStatus} onChannelChange={setChannel} />
      <ul>
        {visibleOrders.map((order) => (
          <li key={order.id}>{order.id} · {order.status} · {(order.totalCents / 100).toFixed(2)}</li>
        ))}
      </ul>
    </div>
  );
}
