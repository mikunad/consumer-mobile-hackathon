export type BootstrapOptions = {
  root: string;
  directory: string;
  binary: string;
  expectedBinarySHA256: string;
  runID: string;
  fixtureSetID: string;
  backendRevision: string;
  configVersion: string;
  verifyIsolation: () => Promise<void>;
  path?: string;
  rejectFirstCertificate?: boolean;
  processGroupMode?: "independent" | "supervised";
};

export type FixtureCatalog = {
  runID: string;
  fixtureSetID: string;
  actors: Record<"friend" | "outsider" | "subject" | "creator", string>;
  groups: string[];
  betId: string;
  locator: string;
  unavailableBetId: string;
  unavailableLocator: string;
};

export type BootstrapDiagnostics = { backendLog: string; cliLogs: { name: string; text: string }[] };

export declare function bootOfficialBackend(options: BootstrapOptions): Promise<{
  origin: "http://127.0.0.1:3210";
  provider: {
    stats: { connects: number; deniedConnects: number; starts: number; checks: number; invalidCodes: number; tlsErrors: string[]; unexpectedRequests: number };
    proxyOrigin: string;
    caSHA256: string;
    caPath: string;
    trustFixtureCertificate(): void;
  };
  markSensitive(value: string): void;
  redact(input: unknown): string;
  seedFreshFixture(runID: string, fixtureSetID: string): Promise<FixtureCatalog>;
  inspectFixture(): Promise<{ accounts: number; sessions: number; memberships: number; bets: number; picks: number; ledger: number }>;
  close(): Promise<BootstrapDiagnostics>;
}>;
