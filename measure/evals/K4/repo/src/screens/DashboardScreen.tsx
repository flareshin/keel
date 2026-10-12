import { useOrders } from "../hooks/useOrders";

export function DashboardScreen() {
  const { orders } = useOrders();
  const openOrders = orders.filter((order) => order.status === "open");
  const revenueCents = orders.reduce((sum, order) => sum + order.totalCents, 0);

  return (
    <div>
      <h1>Dashboard</h1>
      <div>Open orders: {openOrders.length}</div>
      <div>Revenue: {(revenueCents / 100).toFixed(2)}</div>
    </div>
  );
}
