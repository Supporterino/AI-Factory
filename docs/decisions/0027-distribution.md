# ADR-0027: Distribution

**Context.** The unscoped npm name `ai-factory` already belongs to an unrelated project (audit D1). The package also lacked a LICENSE file, a build before publishing, and protection against an older CLI rewriting a newer install.

**Decision.**
- **Name.** The package is `@supporterino/ai-factory` on public npmjs (`publishConfig.access: public`). The command stays `ai-factory`. `PACKAGE_NAME` in `src/version.ts` is the one place the name lives, and a test checks it against package.json.
- **Licence.** MIT, copyright Lars Roth. The vendored Ponytail LICENSE ships alongside it.
- **Build and contents.**
  - `prepack` builds `dist/cli.js` (one bundle with the templates inlined) from a dedicated entry, `src/cli/bin.ts`. `prepublishOnly` runs `bun run check`.
  - The package ships only `dist/`, the README, the CHANGELOG and the licences.
  - The runtime libraries are bundled, so they are devDependencies.
  - `engines.node` is `>=20.3`, for `AbortSignal.any`.
- **No downgrades.** `init`, `update` and `detect --apply` refuse when the lock's `factoryVersion` is newer than the running CLI. The error names how to run the matching version (`npx @supporterino/ai-factory@<version>`). `--allow-downgrade` goes back on purpose.

**Consequences.**
- **Verified:** `npm pack` produced a 6-file, 393 kB tarball. Installed globally from that tarball, it ran `--version`, `init`, `doctor` and `update --dry-run` under Node 24.
- **Not verified:**
  - Node 20.3, which isn't installed here.
  - Publishing itself, which is the owner's step (`npm login`, then `npm publish`).
- **Package name rename.** The scope belongs to the publisher's npm account, so moving the package to an organisation scope later means a rename plus a CHANGELOG note.
