package com.shop;

/**
 * Price rules shared by the till and the web shop.
 */
public final class PriceRules {
    private PriceRules() {
    }

    // prices are stored in cents to avoid rounding errors
    public static long withTaxCents(long netCents, int taxPercent) {
        // round half up
        return Math.round(netCents * (100 + taxPercent) / 100.0);
    }
}
