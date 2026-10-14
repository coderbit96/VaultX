<!-- BEGIN:nextjs-agent-rules -->

## This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` (resolved from this file's directory; in monorepos the `next` package may not be visible from the repo root) before writing any code. Heed deprecation notices.

This block is written and re-added by `next dev` — verify at `node_modules/next/dist/server/lib/generate-agent-files.js`. Removing it from a diff only re-creates the uncommitted change; committing it with your work keeps the tree clean.

<!-- END:nextjs-agent-rules -->

# VaultX engineering instructions

These instructions apply to future coding-agent work in this repository. Read `prd.md`, the affected source files, and these instructions before making changes.

## Scope and design

- Treat `prd.md` as the product specification. Do not silently weaken, omit, or rewrite a requirement. If a requested step conflicts with it or depends on an unresolved design choice, explain the conflict and obtain a decision before implementing that part. Change the PRD only when the user explicitly asks.
- Implement only the step the user requested. Keep changes small, maintainable, and consistent with the existing `src/` App Router layout and `@/*` alias. Do not add placeholder controls that imply an unfinished feature works.
- Check documentation for the **installed package version** before choosing an API. For Next.js, use the relevant guide in `node_modules/next/dist/docs/`; for other packages, use current official documentation. Confirm compatibility before installing or upgrading packages.
- Keep the README, environment template, and implementation status truthful. Never claim a feature works when its external service, credentials, security design, or verification is missing.

## Privacy, storage, and access

- Keep MongoDB, Cloudinary, authentication, and signing secrets on the server. Do not expose them through `NEXT_PUBLIC_*`, browser bundles, client logs, or committed files. Keep `.env.local` ignored by Git and `.env.example` free of live credentials.
- Never log raw filenames, file contents, credentials, encryption keys, recovery material, session tokens, or access tokens. Use minimal redacted operational identifiers and error codes when diagnostics are needed.
- Require authenticated owner authorization on every private page, API, media request, upload, and deletion operation. Check owner and resource state server-side; never trust a browser-supplied owner ID or a bare file ID. Apply CSRF and rate-limit protection where appropriate.
- Never upload plaintext personal files or media. Optimize locally, then encrypt on the client before any upload. Do not introduce a remote plaintext processing service; if a future request proposes one, surface its conflict with this rule and PRD §7.2 before changing the design.
- Enforce image `< 1,000,000` bytes and video `< 100,000,000` bytes against the **actual Cloudinary ciphertext object**, including encryption framing. Verify provider-reported size and private delivery mode on the server before marking a file `ready`; reject outputs that cannot meet the limit and quality floor.
- Keep downloads and previews authenticated, and decrypt on the owner's device. Never create public Cloudinary URLs for private assets. Use durable, retryable jobs for upload cleanup and Cloudinary plus MongoDB deletion; never report deletion complete before both active stores are confirmed clear.

## Verification and reporting

- For code changes, run `npm run lint`, `npm run typecheck`, relevant automated tests, and `npm run build`. Add meaningful tests for new behavior, especially authentication, encryption, byte limits, and failure recovery. If a test command or external service is unavailable, state that plainly; never describe an unrun check as passing.
- In every step's final answer include: **(1) what changed, (2) tests run and their results, (3) how a total beginner can verify it, (4) any manual action needed, and (5) known blockers**. Say `none` where appropriate.

## Short PRD implementation checklist

- [x] Basic Next.js App Router, TypeScript, Tailwind, and ESLint scaffold (PRD §17 Phase 1). This is a placeholder page, not a functional vault.
- [ ] Complete foundation: environment validation, MongoDB/Cloudinary setup, and installable PWA shell (PRD §§10, 13, 17 Phase 1).
- [ ] Single-owner bootstrap, password sessions, lock, authorization, and key recovery (PRD §§3, 5.1, 8; Phase 2).
- [ ] Folder tree, encrypted metadata/files, private uploads, and durable upload state (PRD §§5.2–5.3, 8–10; Phase 3).
- [ ] Local image/video optimization and verified final ciphertext byte limits (PRD §§4.2, 6–7; Phase 4).
- [ ] Authenticated gallery, playback, previews, search, and stored-byte downloads (PRD §§5.4–5.5, 12; Phase 5).
- [ ] Durable single-file and recursive folder deletion with reconciliation (PRD §§5.6, 11; Phase 6).
- [ ] Device unlock polish, accessibility, security tests, and end-to-end acceptance journeys (PRD §§15–17; Phase 7).
