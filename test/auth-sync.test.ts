import { describe, expect, test } from "bun:test";
import {
  type CredentialApi,
  parseCredentialExport,
  type StoredCredential,
  scopeCredentials,
  syncCredentials,
} from "../src/runtime/auth.ts";

const key = (
  id: string,
  integrationID: string,
  value: string,
  active = true,
): StoredCredential => ({
  id,
  integrationID,
  label: value,
  active,
  value: { type: "key", key: value },
});

const oauth = (
  id: string,
  integrationID: string,
  expires: number,
  active = true,
): StoredCredential => ({
  id,
  integrationID,
  label: `${integrationID}-oauth`,
  active,
  value: { type: "oauth", methodID: "device", refresh: "r", access: "a", expires },
});

class FakeApi implements CredentialApi {
  entries: StoredCredential[] = [];
  calls: string[] = [];
  failGet = false;

  async request<T>(
    method: string,
    path: string,
    body?: unknown,
  ): Promise<{ status: number; data: T }> {
    this.calls.push(`${method} ${path}`);
    if (method === "GET" && path === "/api/credential") {
      if (this.failGet) return { status: 404, data: [] as T };
      return { status: 200, data: structuredClone(this.entries) as T };
    }
    if (method === "DELETE" && path.startsWith("/api/credential/")) {
      const id = decodeURIComponent(path.slice("/api/credential/".length));
      this.entries = this.entries.filter((entry) => entry.id !== id);
      return { status: 204, data: undefined as T };
    }
    if (method === "POST" && path.startsWith("/api/credential/") && path.endsWith("/activate")) {
      const id = decodeURIComponent(
        path.slice("/api/credential/".length, path.length - "/activate".length),
      );
      const target = this.entries.find((entry) => entry.id === id);
      if (target === undefined) return { status: 404, data: undefined as T };
      for (const entry of this.entries)
        if (entry.integrationID === target.integrationID)
          this.entries[this.entries.indexOf(entry)] = { ...entry, active: entry.id === id };
      return { status: 204, data: undefined as T };
    }
    if (method === "POST" && path === "/api/credential") {
      const input = body as {
        id: string;
        integrationID: string;
        label: string;
        activate: boolean;
        value: StoredCredential["value"];
      };
      if (this.entries.some((entry) => entry.id === input.id))
        return { status: 409, data: undefined as T };
      const hasActive = this.entries.some(
        (entry) => entry.integrationID === input.integrationID && entry.active,
      );
      const active = input.activate || !hasActive;
      if (input.activate)
        this.entries = this.entries.map((entry) =>
          entry.integrationID === input.integrationID ? { ...entry, active: false } : entry,
        );
      this.entries.push({
        id: input.id,
        integrationID: input.integrationID,
        label: input.label,
        active,
        value: input.value,
      });
      return { status: 200, data: undefined as T };
    }
    return { status: 404, data: undefined as T };
  }
}

describe("parseCredentialExport", () => {
  test("keeps valid key, oauth and external entries", () => {
    const parsed = parseCredentialExport(
      JSON.stringify([
        {
          id: "a",
          integrationID: "deepseek",
          label: "key",
          active: true,
          value: { type: "key", key: "k" },
        },
        oauth("b", "opencode", 123),
        {
          id: "c",
          integrationID: "gitlab",
          label: "ext",
          active: false,
          value: { type: "external", methodID: "m" },
        },
      ]),
    );
    expect(parsed?.map((entry) => entry.id)).toEqual(["a", "b", "c"]);
    expect(parsed?.[1]?.value).toMatchObject({ type: "oauth", expires: 123 });
  });

  test("returns undefined for a failed or malformed export", () => {
    expect(parseCredentialExport("not json")).toBeUndefined();
    expect(parseCredentialExport("{}")).toBeUndefined();
  });
});

describe("scopeCredentials", () => {
  test("only the configured providers are visible to the private server", () => {
    const entries = [
      key("a", "deepseek", "k"),
      key("b", "gitlab", "t"),
      key("c", "opencode-go", "o"),
    ];
    expect(scopeCredentials(entries, ["deepseek", "opencode-go"]).map((e) => e.id)).toEqual([
      "a",
      "c",
    ]);
  });
});

describe("syncCredentials", () => {
  test("creates missing credentials and activates the user's active account", async () => {
    const api = new FakeApi();
    const summary = await syncCredentials(api, [
      key("a", "deepseek", "new", true),
      key("b", "deepseek", "backup", false),
    ]);
    expect(summary).toEqual({
      created: 2,
      updated: 0,
      removed: 0,
      activated: 1,
      skipped: 0,
      failed: 0,
    });
    expect(api.entries.find((entry) => entry.id === "a")?.active).toBe(true);
    expect(api.entries.find((entry) => entry.id === "b")?.active).toBe(false);
  });

  test("removes logged-out credentials and providers no longer configured", async () => {
    const api = new FakeApi();
    api.entries = [key("keep", "deepseek", "k"), key("gone", "gitlab", "t")];
    const summary = await syncCredentials(api, [key("keep", "deepseek", "k")]);
    expect(summary.removed).toBe(1);
    expect(api.entries.map((entry) => entry.id)).toEqual(["keep"]);
  });

  test("updates a rotated API key but keeps a refreshed OAuth token", async () => {
    const api = new FakeApi();
    api.entries = [key("k", "deepseek", "old"), oauth("o", "opencode", Date.now() + 60_000)];
    const summary = await syncCredentials(api, [
      key("k", "deepseek", "new"),
      oauth("o", "opencode", Date.now() + 30_000),
    ]);
    expect(summary.updated).toBe(1);
    expect(summary.skipped).toBe(1);
    expect(api.entries.find((entry) => entry.id === "k")?.value).toMatchObject({ key: "new" });
    expect(api.entries.find((entry) => entry.id === "o")?.value).toMatchObject({
      expires: Date.now() + 60_000,
    });
  });

  test("replaces an expired OAuth token when the user's copy is newer", async () => {
    const api = new FakeApi();
    api.entries = [oauth("o", "opencode", Date.now() - 1_000)];
    const summary = await syncCredentials(api, [oauth("o", "opencode", Date.now() + 60_000)]);
    expect(summary.updated).toBe(1);
    expect(api.entries.find((entry) => entry.id === "o")?.value).toMatchObject({
      expires: Date.now() + 60_000,
    });
  });

  test("an exported empty list removes every private credential", async () => {
    const api = new FakeApi();
    api.entries = [key("a", "deepseek", "k")];
    const summary = await syncCredentials(api, []);
    expect(summary.removed).toBe(1);
    expect(api.entries).toEqual([]);
  });

  test("a server without the credential API fails instead of silently keeping stale keys", async () => {
    const api = new FakeApi();
    api.failGet = true;
    await expect(syncCredentials(api, [])).rejects.toThrow("/api/credential");
  });
});
