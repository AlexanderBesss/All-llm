# Factory Development Guidelines

## Rules
- Do not use the `any` type.
- Use `enum` instead of string literals for fixed sets of values (adapters, providers, statuses, etc.).
- After making changes, run the tests and then run `tsc` to validate the work.
