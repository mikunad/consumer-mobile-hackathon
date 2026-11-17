export const qaBundles = {
  host: "com.mikunad.calledit.qa.host",
  extension: "com.mikunad.calledit.qa.host.messages",
  coreTests: "com.mikunad.calledit.qa.coretests",
  uiTests: "com.mikunad.calledit.qa.uitests",
} as const;

export function requireFixtureTarget(target: { runId: string; mode: string; endpoint?: string; bundleId?: string; fixtureMode: boolean; candidateSha: string }) {
  if (!/^e2e_[a-f0-9]{32}$/.test(target.runId)) throw new Error("Invalid synthetic run namespace");
  if (!/^[a-f0-9]{40}$/.test(target.candidateSha)) throw new Error("Candidate SHA required");
  if (!target.fixtureMode) throw new Error("Fixture attestation required");
  if (target.mode === "memory") {
    if (target.endpoint || target.bundleId) throw new Error("In-memory lane must not have a deployment target");
    return;
  }
  if (target.mode !== "native-simulator") throw new Error("Unsupported target mode");
  if (!Object.values(qaBundles).some((id) => id === target.bundleId)) throw new Error("Bundle is not a dedicated QA target");
  const endpoint = new URL(target.endpoint ?? "");
  if (endpoint.protocol !== "http:" || !["127.0.0.1", "[::1]", "localhost"].includes(endpoint.hostname) || endpoint.username || endpoint.password || !endpoint.port || endpoint.search || endpoint.hash || endpoint.pathname !== "/") {
    throw new Error("QA endpoint must be an explicit loopback origin");
  }
}
