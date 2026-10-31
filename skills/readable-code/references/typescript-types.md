# TypeScript types — writing reference

Distilled from pstack `typescript-best-practices` (with its `references/patterns.md`) and `principle-type-system-discipline` in [cursor/plugins](https://github.com/cursor/plugins) (at 4dd1d05, MIT). Each bullet names the upstream section in parentheses; the before/after examples are in `patterns.md` there.

Read before declaring a type, a function signature or a parse function in a `.ts` or `.tsx` file. These are writing rules; a review blocks only on the items its own lenses name.

Two `/readable-code` rules already cover part of this ground and are not repeated: K5.11 (no new `any`, `as any`, `@ts-ignore` or `@ts-expect-error`; the API layer parses JSON once) and K5.13 (validate external values once where they enter).

## Shape

- **Variants are a discriminated union, not a bag of optional fields** (Discriminated unions). Each variant carries a literal `kind` and only its own fields, so a value that is both `loading` and `error` cannot be written.
- **A `switch` over a union ends in a `never` check** (Exhaustiveness). The `default` arm assigns the value to a `never`-typed constant, so adding a variant fails the compile at every switch that misses it.
- **Build the shape so the illegal value cannot be constructed** (Constructive modeling). `[T, ...T[]]` for a non-empty list, `start` plus `duration` for a range, a union of literals for a closed set; a runtime guard is the fallback, not the first choice.
- **Keep the simplest type that stays total** (Simplest total type). Stay with `T[]` while every operation on it is total; strengthen to a non-empty type only where the loose one forces `!`, a cast or an unreachable throw.
- **Derive types from the source that owns the shape** (Schema-derived types; Derive types from authoritative schemas). Reach for `Pick`, `Omit`, `Parameters`, `ReturnType`, `Awaited`, `typeof` or a type generated from the OpenAPI, GraphQL or database schema before declaring a parallel interface.

## Identity

- **Brand primitives that mean different things** (Branded types; Brand semantic primitives). `OrderId` and `UserId` are both strings; `type OrderId = string & { readonly __brand: "OrderId" }` stops one being passed for the other. When two parameters share a primitive type but not a meaning, brand them.
- **A brand comes only from a check that verifies it** (Branded types; Type guards). A parse function or an `isOrderId(value): value is OrderId` guard creates the brand once at the boundary; `as OrderId` never does. A guard checks every property it claims and is named `isX` or `hasX`; a guard that lies is worse than a cast.

## Narrowing

- **External data is `unknown` until parsed** (`unknown` over `any`; External data is untyped until parsed). Payloads, JSON, messages, CLI arguments, config, environment variables and database rows go through a parse function into a named domain type; `Record<string, unknown>` stops at that parse.
- **Use the repository's schema library before a hand-written guard** (Schemas before hand-rolled guards). Define the schema and infer the type from it (`z.infer<typeof Order>`), so the runtime check and the type cannot drift.
- **Narrow in this order** (Narrowing hierarchy; No `as` casts). Discriminant `switch`, then `in`, then `typeof` or `instanceof`, then a type guard; `as` only after validation has already proven the type.
- **`satisfies` checks a value without widening it** (`satisfies` over `as`). Use it for config objects and lookup tables, so the literal keys and values stay precise.

## Calls

- **Pass an object when two or more parameters could be swapped** (Object args). Named fields make the call site read without the signature. Keep positional parameters on hot paths (per-frame render, tokenizers, parsers).
