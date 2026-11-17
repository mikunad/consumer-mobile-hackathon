import { ConvexError } from "convex/values";
import { expect } from "vitest";

export async function expectCode(operation: Promise<unknown>, code: string) {
  let failure: unknown;
  try {
    await operation;
  } catch (error) {
    failure = error;
  }
  expect(failure).toBeInstanceOf(ConvexError);
  const data = (failure as ConvexError<{ code: string; message: string }>).data;
  expect(data).toMatchObject({ code, message: expect.any(String) });
  expect(Object.keys(data as object).sort()).toEqual(["code", "message"]);
  return data;
}
