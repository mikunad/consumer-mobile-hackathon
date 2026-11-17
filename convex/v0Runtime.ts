import { query } from "./_generated/server";
import { contractVersion } from "./v0Contract";

export const attestation = query({
  args: {},
  handler: async () => ({
    app: "called-it",
    contractVersion,
    schemaVersion: "v0.2",
    environment: ["local", "staging", "production"].includes(process.env.V0_ENVIRONMENT ?? "")
      ? process.env.V0_ENVIRONMENT
      : "unconfigured",
    sourceSha: process.env.V0_SOURCE_SHA ?? null,
    deploymentId: process.env.V0_DEPLOYMENT_ID ?? null,
    configVersion: process.env.V0_CONFIG_VERSION ?? null,
    testAdapters: false,
  }),
});
