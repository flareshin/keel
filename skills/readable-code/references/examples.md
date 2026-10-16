# Readable Code — before/after examples

Invented code from a small order-management service, written to show each rule's shape. "After" snippets are illustrative: not compiled.

## K5.1 — entry method mixes orchestration with detail
```java
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

## K5.14 — remove comments and verify the behavior
- Remove narration such as `// Save the updated order`, change history, banners, internal-invariant explanations and TODOs even when they have a ticket. Put the meaning in names/types, the task in the tracker, and the history in the commit body.
- A comment says a missing key is allowed, but the implementation rejects it. Trace callers and the actual contract; write a failing test for the required behavior, then fix the executable branch. Editing that comment alone does not fix the bug.
- A comment says two databases disagree on escaping. That claim alone does not qualify for retention. Verify the deployed versions' documented behavior or a reproducible query, cite that evidence in the reading guide, and encode the supported behavior in code/tests. Keep a short comment only for the external constraint code cannot express.
- Preserve a required copyright/license notice verbatim. Preserve a necessary shebang, encoding declaration or tool-consumed annotation in its required syntax; tool syntax is not permission to disable checks forbidden by another rule.
- For intentional error handling, use a name such as `deleteTemporaryFileIfPresent` and test the already-absent case. A why comment does not justify an empty catch.

## K5.16 — test names as spec
```java
@Test void createInvoice_retriesWithNewNumber_whenInvoiceNumberCollides()
@Test void createInvoice_failsAfterFiveCollisions()
@Test void createInvoice_throwsImmediately_whenErrorIsNotACollision()
@Test void createInvoice_usesParentAccount_forSubAccountOrders()
```
