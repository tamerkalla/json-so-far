# Changelog

All notable changes to this project are documented here. This project follows
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

Because the emission table in the README *is* the contract, a change to any row
in it — what gets emitted for a given half-arrived token — is a breaking change,
even though no type signature moves.

## [0.1.0] — Unreleased

Initial release.

### Added

- `parsePartial(text, options?)` — best-effort value from incomplete JSON.
  Never throws, for any input.
- `parsePartialResult(text, options?)` — same, plus a `complete` flag
  distinguishing "the document closed" from "the stream has not caught up".
- Options: `partialStrings` (default `true`), `partialNumbers` (default
  `false`), `streaming` (default `true`).
- Prototype-pollution safety: `__proto__` keys become own properties with the
  same descriptor `JSON.parse` produces, rather than reaching the prototype.
- Property-based test suite asserting five invariants at every truncation index
  of generated documents.
- Mutation testing via Stryker, enforced in CI.
