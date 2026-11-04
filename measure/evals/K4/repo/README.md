# shop-admin

Admin console for a small online shop: orders, inventory, checkout and vendor reports.

- `src/screens/` holds the main screens
- `src/components/` holds shared UI pieces
- `src/checkout/` holds the payment form and its API client
- `src/reports/` holds the vendor report
- `src/user/` holds the user service (Java) behind the admin login

Run `npm run dev` to start the UI.

Operations work handed to a Claude subagent starts as a brief in `briefs/<slug>.md`; `scripts/dispatch.sh briefs/<slug>.md` hands it to an agent.

- `data/` holds raw exports: `orders.csv`, `refunds.csv`, `customers.csv`
- `logs/app.log` is the raw application log
- `reports/weekly-summary.md` is the digest the team reads each Monday
