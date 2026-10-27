---
"@supporterino/ai-factory": patch
---

Detect Swift projects that are not SwiftPM packages. `Package.swift`, XcodeGen's `project.yml` and any `*.xcodeproj` bundle are now detected as Swift, and their gates fall back to `xcodegen generate` plus `xcodebuild build`/`test` (the scheme defaults to the project name). `testAffected` therefore resolves for Xcode projects instead of failing as a missing gate. Workspace scans also skip `.build`.
