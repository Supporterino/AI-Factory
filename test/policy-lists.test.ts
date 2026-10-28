import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { isProtectedPath, isSecretPath } from "../src/policy/paths.ts";
import { alwaysDeny, ruleEffect } from "../src/policy/permissions.ts";
import { fence } from "../src/util/fence.ts";

/** Secret files as the plugin's parser sees them and as opencode's permission rules see them. */
const SECRETS = [
  ".env",
  "app/.env.local",
  "certs/server.pem",
  "certs/server.key",
  "certs/client.p12",
  "certs/client.pfx",
  "id_rsa",
  "home/.ssh/id_ed25519",
  "home/.ssh/config",
  "ops/kubeconfig",
  "home/.kube/config",
  "home/.kube/prod.yaml",
  "home/.aws/credentials",
  "home/.config/gcloud/credentials.db",
  "home/.azure/accessTokens.json",
  "home/.docker/config.json",
  ".netrc",
  ".npmrc",
  ".pypirc",
  ".git-credentials",
  "infra/terraform.tfstate",
  "infra/terraform.tfstate.backup",
];

describe("the secret lists agree (audit S11)", () => {
  test.each(SECRETS)("%s is secret to the parser and to opencode", (path) => {
    expect(isSecretPath(path)).toBe(true);
    const rules = alwaysDeny();
    expect(ruleEffect(rules, "read", path)).toBe("deny");
    expect(ruleEffect(rules, "edit", path)).toBe("deny");
  });

  test.each(["src/environment.ts", "docs/keys.md"])("%s is not", (path) => {
    expect(isSecretPath(path)).toBe(false);
    expect(ruleEffect(alwaysDeny(), "read", path)).not.toBe("deny");
  });

  test("example env files: the parser allows them, opencode's rules stay conservative", () => {
    // opencode's wildcard rules cannot except `.env.example` from `.env*` without re-allowing
    // reads for roles that read nothing; agents read examples through the shell instead.
    expect(isSecretPath(".env.example")).toBe(false);
    expect(ruleEffect(alwaysDeny(), "read", ".env.example")).toBe("deny");
  });
});

describe("committed records are protected", () => {
  test.each([
    "factory-records",
    "factory-records/reports/add-x.md",
    "factory-records/usage/add-x.json",
    "factory-records/approvals/add-x.json",
  ])("%s is protected from edits", (path) => {
    expect(isProtectedPath(path)).toBe(true);
    expect(ruleEffect(alwaysDeny(), "edit", path)).toBe("deny");
  });

  test("a similarly named file is not", () => {
    expect(isProtectedPath("factory-records.md")).toBe(false);
  });

  test("the plugin template carries the same rule", () => {
    const plugin = readFileSync(
      join(import.meta.dir, "..", "templates/plugin/factory-plugin.txt"),
      "utf8",
    );
    expect(plugin).toContain("/^factory-records(\\/|$)/i");
  });
});

describe("fence (audit S19)", () => {
  test("is longer than any backtick run inside", () => {
    expect(fence("plain")).toBe("```\nplain\n```");
    expect(fence("a ``` b")).toBe("````\na ``` b\n````");
    expect(fence("x ````` y")).toBe("``````\nx ````` y\n``````");
  });
});
