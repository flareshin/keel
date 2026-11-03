# shop

Order pricing for the shop's receipts and daily revenue report. Run the tests with `npm test`.

## Known cleanups

- `src/pricing-service.js` only forwards to `src/pricing.js`.
- `legacyDiscountCents` in `src/money.js` has had no caller since the spring promotion ended.
- `src/tax-provider-factory.js` only ever builds `FlatTax`.
