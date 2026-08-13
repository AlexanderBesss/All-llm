# Factory Development Guidelines

## Rules
- Do not use the `any` type.
- Use `enum` instead of string literals for fixed sets of values (adapters, providers, statuses, etc.).
- Do not create single-line re-export wrapper files; import from the implementation module directly.
- After making changes, run the tests and then run `tsc` to validate the work.
