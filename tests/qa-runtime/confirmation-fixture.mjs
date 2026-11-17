import assert from "node:assert/strict";
import { cpSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

export function confirmationSourceRoot(root, directory) {
  const source = resolve(directory, "source");
  mkdirSync(resolve(source, "tests/qa-runtime"), { recursive: true, mode: 0o700 });
  cpSync(resolve(root, "convex"), resolve(source, "convex"), { recursive: true });
  symlinkSync(resolve(root, "node_modules"), resolve(source, "node_modules"), "dir");
  const base = readFileSync(resolve(root, "tests/qa-runtime/fixture.ts.txt"), "utf8");
  const marker = "return { runID, fixtureSetID: args.fixtureSetID, actors: ids, groups, betId, locator, unavailableBetId, unavailableLocator };";
  assert.equal(base.split(marker).length, 2, "The isolated fixture seed contract changed");
  const extended = base.replace(marker, `
    const confirmationScenarios = {};
    for (const name of ["sameRequestSamePayload", "sameRequestDifferentPayload", "newRequestSamePayload", "voidReplay", "memberReplay", "revealAdmission", "blockReplay"]) {
      const groupId = groups[name === "blockReplay" ? 1 : 0];
      const subjectId = name === "blockReplay" ? ids.outsider : ids.subject;
      const revealAt = now + (name === "revealAdmission" ? 45000 : 1200000);
      const locator = await hash(runID + ":confirmation:" + name);
      const betId = await ctx.db.insert("v0Bets", { groupId, creatorId: ids.creator, subjectId, createdAt: now - 30000, cutoffAt: revealAt, revealAt, question: "SYNTHETIC_CONFIRM_" + name + "_" + runID, contextLine: "Private synthetic confirmation fixture", format: "yes_no", options: ["Yes", "No"], source: "manual", state: "open", locator });
      confirmationScenarios[name] = { betId, locator, groupId, revealAt };
    }
    return { runID, fixtureSetID: args.fixtureSetID, actors: ids, groups, betId, locator, unavailableBetId, unavailableLocator, confirmationScenarios };
  `);
  writeFileSync(resolve(source, "tests/qa-runtime/fixture.ts.txt"), extended, { mode: 0o600 });
  return source;
}
