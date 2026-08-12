# Changelog

All notable changes to this project are documented here. This project follows
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

Because the emission table in the README *is* the contract, a change to any row
in it — what gets emitted for a given half-arrived token — is a breaking change,
even though no type signature moves.

## [0.1.2] — 2026-08-12

No changes to the library. `src/` is byte-for-byte identical to 0.1.1; this
release exists to refresh the README that ships in the package and to exercise
the automated release path end to end.

### Changed

- Releasing is now a version bump. Changing `version` in `package.json` and
  pushing to `main` publishes to npm and creates the tag and GitHub Release,
  with notes taken from this file. Re-running a release is a no-op rather than
  a failure.
- The mutation job runs in about four minutes instead of twenty-six, by scaling
  down fast-check iterations under Stryker only. The score is unchanged —
  identical mutants killed and survived.

## [0.1.1] — 2026-08-12

### Added

- `package.json` is now reachable through the `exports` map. Tooling that
  reads `json-so-far/package.json` for version detection previously hit
  `ERR_PACKAGE_PATH_NOT_EXPORTED`.

### Changed

- Releases now authenticate with npm Trusted Publishing (OIDC) instead of a
  long-lived automation token. No publishing credential is stored in the
  repository.

## [0.1.0] — 2026-08-12

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
