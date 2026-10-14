# VaultX

VaultX is being built from the [product requirements](./prd.md) as a private, single-owner file vault. **This repository currently contains only the Next.js foundation.** It does not yet authenticate users, encrypt files, or store private content.

## Run it on Windows

1. Install Node.js LTS from the official **Node.js** website and Git from the official **Git** website if they are missing. npm is included with Node.js.
2. In VS Code, choose **File > Open Folder...** and select `D:\VaultX`.
3. Choose **Terminal > New Terminal**. The terminal should show `D:\VaultX` as its working folder.
4. Run `npm install` if dependencies are not already installed.
5. Run `npm run dev`.
6. Open `http://localhost:3000` in your browser. Keep the terminal open while using the development server. Press **Ctrl+C** in the terminal to stop it.

If port 3000 is in use, Next.js may print another localhost address. Open the address shown after **Local:** in the terminal.

## Useful commands

| Command | Purpose |
| --- | --- |
| `npm run dev` | Start the local development server |
| `npm run lint` | Check code with ESLint |
| `npm run typecheck` | Check TypeScript types |
| `npm run build` | Create a production build |
| `npm run start` | Run an existing production build |

## Project layout

- `src/app/` contains the Next.js App Router pages, root layout, and CSS.
- `@/*` imports resolve to `src/*`.
- `.env.example` lists planned environment variable names. The current foundation does not use these services yet.

When credentials are needed later, copy `.env.example` to `.env.local` and fill in values locally. `.env.local` is ignored by Git. Never put MongoDB, Cloudinary, or auth secrets in variables beginning with `NEXT_PUBLIC_`.

## Status

The page is a placeholder that clearly states the app is not a working vault. The PRD's authentication, encryption, storage, media processing, PWA, and deletion features remain future implementation work.
