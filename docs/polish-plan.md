# Nexora polish plan (reviewable diffs)

## Goals
- Clean, consistent JS (no full TypeScript migration — keep risk low)
- Performance, security, a11y, SEO improvements
- Remove dead code / unused deps
- Standardize lint / smoke tests
- **Preserve all existing features**

## Diffs shipped in this pass

| # | Area | Change |
|---|------|--------|
| 1 | Backend deps | Remove unused mongoose/mongo/nedb/crypto; add `compression` |
| 2 | Backend auth | Block inactive users; safer JWT verify |
| 3 | Backend server | `trust proxy`, compression, clearer errors |
| 4 | Frontend routes | `React.lazy` code-splitting + Suspense |
| 5 | SEO / a11y | Meta tags, skip link, main landmark, page titles |
| 6 | Tooling | Root lint/build/smoke scripts; server smoke test |
| 7 | Dead models | Remove unused Mongoose `server/models/*` |

## Out of scope (later PRs)
- Full TypeScript conversion
- UI redesign
- Payment provider live wiring
- E2E Playwright suite
- Deleting `ui-reference/` (kept as design archive)

## Verification
See `docs/polish-checklist.md`
