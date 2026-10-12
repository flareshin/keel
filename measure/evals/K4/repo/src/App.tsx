import { useState } from "react";
import { DashboardScreen } from "./screens/DashboardScreen";
import { InventoryScreen } from "./screens/InventoryScreen";
import { OrdersScreen } from "./screens/OrdersScreen";
import { PayoutSettings } from "./settings/PayoutSettings";

const SCREENS = {
  dashboard: DashboardScreen,
  orders: OrdersScreen,
  inventory: InventoryScreen,
  payouts: PayoutSettings,
} as const;

type ScreenName = keyof typeof SCREENS;

export function App() {
  const [screen, setScreen] = useState<ScreenName>("dashboard");
  const Screen = SCREENS[screen];

  return (
    <div>
      <nav>
        {(Object.keys(SCREENS) as ScreenName[]).map((name) => (
          <button key={name} onClick={() => setScreen(name)}>{name}</button>
        ))}
      </nav>
      <Screen />
    </div>
  );
}
