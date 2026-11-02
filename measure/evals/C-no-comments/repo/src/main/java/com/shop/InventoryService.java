package com.shop;

import java.util.HashMap;
import java.util.Map;

/**
 * Keeps the on-hand count per SKU.
 */
public class InventoryService {
    // sku -> units on hand
    private final Map<String, Integer> onHand = new HashMap<>();

    /** Adds received units to the count. */
    public void receive(String sku, int units) {
        onHand.merge(sku, units, Integer::sum); // add to the existing count
    }

    // returns zero for an unknown sku
    public int unitsOnHand(String sku) {
        return onHand.getOrDefault(sku, 0);
    }
}
