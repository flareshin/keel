import { useState } from "react";

export type CartLineItem = {
  sku: string;
  quantity: number;
  unitPriceCents: number;
};

export function useCart() {
  const [lineItems, setLineItems] = useState<CartLineItem[]>([]);
  const grandTotalCents = lineItems.reduce((sum, item) => sum + item.quantity * item.unitPriceCents, 0);

  function addItem(item: CartLineItem) {
    setLineItems((current) => [...current, item]);
  }

  return { lineItems, grandTotalCents, addItem };
}
