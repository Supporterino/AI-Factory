/** Must equal "version" in package.json (checked by a test). */
export const FACTORY_VERSION = "0.7.0";

/** Must equal "name" in package.json (checked by a test). The CLI command is `ai-factory`. */
export const PACKAGE_NAME = "@supporterino/ai-factory";

/** How to run a given version of the factory without installing it. */
export const runVersion = (version: string): string => `npx ${PACKAGE_NAME}@${version}`;
