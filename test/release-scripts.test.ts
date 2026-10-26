import { describe, expect, test } from "bun:test";
import { changelogSection } from "../scripts/changelog-section.ts";
import { syncVersionText } from "../scripts/sync-version.ts";

const CHANGELOG = `# Changelog

## 0.3.0

### Minor Changes

- Add a thing.

## 0.2.0

### Added

- Older thing.
`;

describe("release scripts", () => {
  test("changelogSection returns the section without its heading", () => {
    expect(changelogSection(CHANGELOG, "0.3.0")).toBe("### Minor Changes\n\n- Add a thing.");
    expect(changelogSection(CHANGELOG, "0.2.0")).toBe("### Added\n\n- Older thing.");
  });

  test("changelogSection rejects missing and empty sections", () => {
    expect(() => changelogSection(CHANGELOG, "9.9.9")).toThrow("no section");
    expect(() => changelogSection("## 1.0.0\n\n## 0.9.0\n", "1.0.0")).toThrow("is empty");
  });

  test("syncVersionText rewrites only FACTORY_VERSION", () => {
    const source = `/** Version. */\nexport const FACTORY_VERSION = "0.2.0";\nexport const NAME = "0.2.0";\n`;
    expect(syncVersionText(source, "0.3.0")).toBe(
      `/** Version. */\nexport const FACTORY_VERSION = "0.3.0";\nexport const NAME = "0.2.0";\n`,
    );
    expect(() => syncVersionText("export const NAME = 'x';", "1.0.0")).toThrow(
      "no FACTORY_VERSION",
    );
  });
});
