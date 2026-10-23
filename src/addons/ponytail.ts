import reviewCommand from "../../templates/addons/ponytail/.opencode/command/ponytail-review.md" with {
  type: "text",
};
import agentsMd from "../../templates/addons/ponytail/AGENTS.md" with { type: "text" };
import license from "../../templates/addons/ponytail/LICENSE" with { type: "text" };
import skill from "../../templates/addons/ponytail/skills/ponytail/SKILL.md" with { type: "text" };
import reviewSkill from "../../templates/addons/ponytail/skills/ponytail-review/SKILL.md" with {
  type: "text",
};
import precedenceTemplate from "../../templates/addons/ponytail-precedence.md" with {
  type: "text",
};
import type { FactoryConfig } from "../config/schema.ts";
import { PreconditionError } from "../errors.ts";
import { PONYTAIL } from "../versions.ts";
import { contentHash, isText } from "./hash.ts";

/**
 * The Ponytail add-on (§12, ADR-0008): the pinned release ships inside the factory package
 * (scripts/vendor-ponytail.ts), is verified against the pinned content hash before every
 * use, and is injected as static prompt text into the configured roles only.
 */

export const PONYTAIL_DIR = ".opencode/addons/ponytail";
export const PONYTAIL_REF = `${PONYTAIL.tag}@${PONYTAIL.commit}`;

const VENDORED: Readonly<Record<string, string>> = {
  ".opencode/command/ponytail-review.md": reviewCommand,
  "AGENTS.md": agentsMd,
  LICENSE: license,
  "skills/ponytail-review/SKILL.md": reviewSkill,
  "skills/ponytail/SKILL.md": skill,
};

export function vendoredFiles(): { path: string; content: string }[] {
  return Object.entries(VENDORED).map(([path, content]) => ({ path, content }));
}

/** Refuses a tampered or binary vendored copy. */
export function verifyVendored(
  files: readonly { path: string; content: string }[],
  expected = PONYTAIL.contentSha256,
): void {
  const encoder = new TextEncoder();
  for (const f of files) {
    if (!isText(encoder.encode(f.content)))
      throw new PreconditionError(`Ponytail file ${f.path} is not text; refusing binaries`);
  }
  const names = files.map((f) => f.path).sort();
  if (names.join("\n") !== [...PONYTAIL.files].sort().join("\n")) {
    throw new PreconditionError("the vendored Ponytail file set differs from the pin", names);
  }
  const hash = contentHash(files);
  if (hash !== expected) {
    throw new PreconditionError(`Ponytail content hash mismatch: ${hash} ≠ pinned ${expected}`, [
      "the vendored add-on was modified; reinstall the factory package or disable addons.ponytail",
    ]);
  }
}

/** The configured ref must be the one this factory version vendors. */
export function checkPonytailConfig(config: FactoryConfig): void {
  const addon = config.addons.ponytail;
  if (!addon.enabled) return;
  if (addon.ref !== PONYTAIL_REF) {
    throw new PreconditionError(
      `addons.ponytail.ref ${addon.ref} is not the release this factory vendors`,
      [`set it to "${PONYTAIL_REF}" or update the factory (ai-factory update)`],
    );
  }
  verifyVendored(vendoredFiles());
}

/** The compact form: AGENTS.md without its closing aside about the Ponytail repo itself. */
function compactRules(): string {
  return agentsMd
    .split("\n")
    .filter((line) => !line.startsWith("(Yes, this file also applies"))
    .join("\n")
    .trimEnd();
}

/** The row for `level` from SKILL.md's Levels table (the only level-specific text). */
export function levelRow(level: FactoryConfig["addons"]["ponytail"]["level"]): string {
  const row = skill.split("\n").find((l) => l.startsWith(`| **${level}** |`));
  const text = row?.split("|")[2]?.trim() ?? "";
  return `Level: ${level}. ${text}`;
}

/** The review checklist: the review skill's body without frontmatter. */
function reviewChecklist(): string {
  return reviewSkill.replace(/^---\n[\s\S]*?\n---\n/, "").trim();
}

export function precedence(config: FactoryConfig): string {
  const forbid = config.addons.ponytail.shortcutComments === "forbid";
  const shortcuts = forbid
    ? "Do not add `shortcut:` comments: in this workspace a gate rejects them. Finish the work instead, or report the limit under `risks`."
    : "A shortcut with a known limit gets a `shortcut: <the limit>, <when to upgrade>` comment; the factory collects them into the change report.";
  return precedenceTemplate.replace("{{shortcuts}}", shortcuts).trimEnd();
}

const REVIEWER_MAPPING = `### Reviewer output
Do not write Ponytail's Markdown review format. Report each finding in the handoff \`findings\`: Must fix → severity "must", Should fix → "should", Nice to have → "nice"; "What this is" → \`what\`, "Problem" → \`problem\`, "Fix" → \`fix\`, "If we skip it" → \`impact\`, file:lines → \`file\` and \`line\`. Put "Not checked" items into \`risks\` and the "Lean: -N lines possible." note into \`decisions\`. A \`shortcut:\` comment is a decision, not a finding.`;

/** The prompt section for one role, or undefined when the add-on does not apply to it. */
export function ponytailSection(
  config: FactoryConfig,
  role: "implementer" | "reviewer",
): string | undefined {
  const addon = config.addons.ponytail;
  if (!addon.enabled || !addon.roles.includes(role)) return undefined;
  const header = `# Add-on: Ponytail ${PONYTAIL.tag} (MIT, © DietrichGebert; vendored in ${PONYTAIL_DIR})`;
  const parts = [header, compactRules(), levelRow(addon.level)];
  if (role === "reviewer")
    parts.push(`## Review checklist\n\n${reviewChecklist()}`, REVIEWER_MAPPING);
  parts.push(precedence(config));
  return parts.join("\n\n");
}
