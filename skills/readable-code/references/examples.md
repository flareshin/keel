# Readable Code — before/after examples

Invented code from a small order-management service, written to show each rule's shape. "After" snippets are illustrative: not compiled.

## K5.1 — entry method mixes orchestration with detail
```java
// BEFORE: retry loop + transaction propagation + message-string classification in one method
public Invoice createInvoice(OrderRequest request, String userId) {
    for (int attempt = 1; attempt <= 5; attempt++) {
        try {
            TransactionTemplate tpl = new TransactionTemplate(transactionManager);
            tpl.setPropagationBehavior(TransactionDefinition.PROPAGATION_REQUIRES_NEW);
            return tpl.execute(status -> attemptCreateInvoice(request, userId));
        } catch (Exception e) {
            String msg = e.getMessage() != null ? e.getMessage().toLowerCase() : "";
            boolean isDuplicate = msg.contains("duplicate") || msg.contains("unique");
            ...
```
```java
// AFTER: one line tells the story; detail lives below
public Invoice createInvoice(OrderRequest request, String userId) {
    return retryOnInvoiceNumberCollision(attempt ->
            inNewTransaction(() -> attemptCreateInvoice(request, userId, attempt)));
}
```
Switching collision detection from message matching to exception type is a **behavior change** and belongs in a separate commit (change shape rule).

## K5.3 — fallback chain nested five levels
"Where does the shipping address come from" (request → saved default → billing address) spread across nested if/else blocks becomes one named resolver:
```java
private Address resolveShippingAddress(OrderRequest request, Customer customer) {
    if (request.hasShippingAddress()) {
        return request.getShippingAddress();
    }
    return findDefaultShippingAddress(customer.getId())
            .orElseGet(customer::getBillingAddress);
}
```

## K5.4 / K5.8 — one concept, many forms
"Is this a wholesale customer" written as `customer.getTier() == 3` in one service, `WHOLESALE_TIER = 3` redefined locally in another, and `isBulkBuyer()` in a third. Pick one predicate (`Customer.isWholesale()`), name it in the glossary, and replace the copies.

## K5.5 — name hides behavior
`processActiveOrders(...)` reprioritizes orders **and** writes audit records: name it `reprioritizeActiveOrdersAndRecordChanges(...)`. `String result = prefix + ...` that builds an invoice title: name it `invoiceTitle`.

## K5.6 — meaning in one file, literals everywhere else
```java
int channel = 2;
if (request.getChannel() == 1) { channel = 1; }
String prefix = channel == 1 ? "WEB-" : "POS-";
```
The meaning of `1` and `2` lives in one resolver's constants while two other services keep their own `DEFAULT_CHANNEL = 2`. The fix is one enum (`SalesChannel.WEB`, `SalesChannel.STORE`) used everywhere.

## K5.8 — "must stay in lockstep" comment
```java
// This rounding must stay in lockstep with InvoiceService's: a mismatch makes the
// refund exceed the charged amount.
```
The constraint is real, but the only thing guarding it is the comment: extract the shared computation.

## K5.9 — reset effect instead of remount (FE)
A drawer runs one `useEffect([userId, open])` that calls 20 setters to reset state. Any new state that misses the list leaks the previous user's data. Remount instead:
```tsx
<UserDrawer key={userId} userId={userId} open={open} />
```

## K5.10 — one variable, three meanings
`accountId` starts as the request value, becomes the parent account, then the billing account; the reader tracks which one applies for 70 lines.
```java
final String billingAccountId = resolveBillingAccountId(request.getAccountId(), parentAccount);
```

## K5.11 — untyped API data in screens (FE)
```tsx
const list = JSON.parse(await UserApi.getUsers()) as any[];
const found = list.find((u: any) => u.user_id === userId);
```
Parse once in the API layer and return typed data (`User[]`, camelCase).

## K5.12 — swallowed errors
```tsx
try { printer.enqueue(label); } catch {}
return true;   // reports success even when printing failed
```
BE: `log.warn("lookup failed {}", e.getMessage())` drops the stack trace and every identifier; log `orderId` and pass `e`.

## K5.14 — narration, history and dead references vs. a constraint
- Bad (narration): `// Save the updated order` above `orderRepository.save(order)`.
- Bad (history): "Returned all rows until last month: the filter was computed and then discarded." Belongs in the commit body and a regression test name.
- Bad (unreachable reference): `(design §15.4)` pointing at a local file no teammate can open.
- Good: `/** Not a backslash: the production DB and the test DB disagree on backslashes inside string literals. */` — one line, present tense, a constraint the next editor would break.

## K5.16 — test names as spec
```java
@Test void createInvoice_retriesWithNewNumber_whenInvoiceNumberCollides()
@Test void createInvoice_failsAfterFiveCollisions()
@Test void createInvoice_throwsImmediately_whenErrorIsNotACollision()
@Test void createInvoice_usesParentAccount_forSubAccountOrders()
```
