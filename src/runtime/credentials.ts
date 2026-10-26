import { agentGitEnv } from "../git/hooks.ts";

/** Credential variables per provider id; only providers named in `models` get theirs. */
export const PROVIDER_ENV: Readonly<Record<string, readonly string[]>> = {
  anthropic: ["ANTHROPIC_API_KEY", "ANTHROPIC_BASE_URL"],
  openai: ["OPENAI_API_KEY", "OPENAI_BASE_URL", "OPENAI_ORG_ID"],
  google: ["GOOGLE_GENERATIVE_AI_API_KEY", "GEMINI_API_KEY"],
  "google-vertex": [
    "GOOGLE_APPLICATION_CREDENTIALS",
    "GOOGLE_CLOUD_PROJECT",
    "GOOGLE_CLOUD_LOCATION",
    "VERTEX_LOCATION",
  ],
  "amazon-bedrock": [
    "AWS_ACCESS_KEY_ID",
    "AWS_SECRET_ACCESS_KEY",
    "AWS_SESSION_TOKEN",
    "AWS_REGION",
    "AWS_PROFILE",
    "AWS_BEARER_TOKEN_BEDROCK",
  ],
  azure: ["AZURE_API_KEY", "AZURE_RESOURCE_NAME", "AZURE_OPENAI_API_KEY", "AZURE_OPENAI_ENDPOINT"],
  openrouter: ["OPENROUTER_API_KEY"],
  mistral: ["MISTRAL_API_KEY"],
  groq: ["GROQ_API_KEY"],
  xai: ["XAI_API_KEY"],
  deepseek: ["DEEPSEEK_API_KEY"],
  gitlab: ["GITLAB_TOKEN", "GITLAB_INSTANCE_URL"],
};

/** Tokens that let a program push or act on a forge (git credential helpers read some of them). */
const FORGE_TOKENS = ["GH_TOKEN", "GITHUB_TOKEN", "GITLAB_TOKEN", "GL_TOKEN", "BITBUCKET_TOKEN"];

/** Variables no agent shell, gate or install may see: model keys, the server password, forge tokens. */
export function scrubList(): string[] {
  return [
    ...new Set([
      "OPENCODE_PASSWORD",
      "OPENCODE_SERVER_PASSWORD",
      ...Object.values(PROVIDER_ENV).flat(),
      ...FORGE_TOKENS,
    ]),
  ];
}

/**
 * The environment for programs the agents control (gates, installs): the user's environment
 * without credentials, plus the factory's push block (ADR-0003).
 */
export function agentProcessEnv(base: NodeJS.ProcessEnv = process.env): Record<string, string> {
  const drop = new Set(scrubList());
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(base)) {
    if (v !== undefined && !drop.has(k) && !k.startsWith("OPENCODE_")) env[k] = v;
  }
  return { ...env, ...agentGitEnv(base) };
}
