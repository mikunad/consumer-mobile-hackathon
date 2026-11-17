import { expect } from "vitest";

export function noPrivateValues(value: unknown, sentinels: string[]) {
  const serialized = JSON.stringify(value) ?? "null";
  for (const sentinel of sentinels) expect(serialized).not.toContain(sentinel);
  expect(serialized).not.toMatch(/synthetic_.*(?:session|token)/i);
}

export async function deniedOrNeutral(operation: () => Promise<unknown>, sentinels: string[]) {
  let value: unknown;
  try {
    value = await operation();
  } catch (error) {
    noPrivateValues(String(error), sentinels);
    expect(String(error)).not.toMatch(/(?:TypeError|ReferenceError|Could not find|ArgumentValidationError)/);
    return;
  }
  noPrivateValues(value, sentinels);
}
