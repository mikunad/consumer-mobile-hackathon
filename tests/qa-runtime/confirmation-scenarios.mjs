import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { ConvexHttpClient } from "convex/browser";
import { makeFunctionReference } from "convex/server";
import { ConvexError } from "convex/values";

export async function confirmationScenarios({ origin, fixture, sessions, actors, check, local, verifyIsolation, markSensitive, evidence }) {
  const requests = [];
  const observedFetch = async (input, init) => {
    const request = new Request(input, init);
    const url = new URL(request.url);
    assert.equal(url.origin, origin);
    assert.ok(["/api/query", "/api/mutation", "/api/action"].includes(url.pathname));
    assert.equal(request.headers.has("authorization"), false);
    await verifyIsolation();
    const body = JSON.parse(await request.clone().text());
    const trace = url.pathname === "/api/mutation" && body.path === "v0Bets:pick" ? { requestId: body.args[0].requestId, startedAtMs: performance.now() } : undefined;
    if (trace) requests.push(trace);
    try {
      const response = await fetch(request, { redirect: "error", signal: AbortSignal.timeout(15000) });
      if (trace) {
        const envelope = await response.clone().json();
        trace.httpStatus = response.status;
        trace.udfStatus = envelope.status;
        if (envelope.status === "error" && typeof envelope.errorData?.code === "string") trace.code = envelope.errorData.code;
      }
      return response;
    } finally { if (trace) trace.finishedAtMs = performance.now(); }
  };
  const client = new ConvexHttpClient(origin, { logger: false, skipConvexDeploymentUrlCheck: true, fetch: observedFetch });
  const mutation = (path, args) => client.mutation(makeFunctionReference(path), args, { skipQueue: true });
  const query = (path, args) => client.query(makeFunctionReference(path), args);
  const action = (path, args) => client.action(makeFunctionReference(path), args);
  const args = (betId, overrides = {}) => ({ token: sessions.friend.token, betId, option: 0, confidence: 0.25, requestId: randomUUID(), ...overrides });
  const get = (bet, token = sessions.friend.token) => query("v0Bets:get", { token, locator: bet.locator });
  const unchangedCode = (operation, code) => assert.rejects(operation, (error) => error instanceof ConvexError && error.data?.code === code && typeof error.data.message === "string");
  const receipt = (value, choice) => {
    assert.deepEqual(Object.keys(value).sort(), ["confidence", "option", "saved", "updatedAt"]);
    assert.deepEqual({ saved: value.saved, option: value.option, confidence: value.confidence }, { saved: true, option: choice.option, confidence: choice.confidence });
    assert.ok(Number.isFinite(value.updatedAt));
    return value;
  };
  const balances = async () => {
    const groups = [];
    for (const groupId of fixture.groups) {
      const board = await query("v0Groups:board", { token: sessions.creator.token, groupId });
      groups.push(board.rows.map(({ accountId, points, streak }) => ({ accountId, points, streak })));
    }
    return groups;
  };
  const count = async () => {
    const state = await local.inspectFixture();
    assert.equal(state.ledger, 0);
    return state.picks;
  };
  const selection = (view, expected) => {
    assert.equal(view.view, "bet");
    assert.deepEqual(view.myPick, { option: expected.option, confidence: expected.confidence });
    assert.deepEqual(Object.keys(view.myPick).sort(), ["confidence", "option"]);
    assert.equal(view.canPick, false);
    assert.equal(view.cutoffAt, view.revealAt);
  };
  const initialBalances = await balances();
  evidence.confirmationHTTP = { kind: "actual public handlers over official OSS HTTP", outerSDKSkipQueue: true, requests, races: [], engineOCCRetryEventsObserved: false, exactRevealMillisecondProved: false };
  const nearReveal = fixture.confirmationScenarios.revealAdmission;
  let revealChoice;
  let revealReceipt;
  await check("QA-CONFIRM.http-before-reveal-capability", async () => {
    const view = await get(nearReveal);
    assert.equal(view.canPick, true);
    assert.ok(view.serverTime < nearReveal.revealAt, "The isolated reveal fixture expired before its confirmation probe");
    assert.equal(view.cutoffAt, view.revealAt);
    revealChoice = args(nearReveal.betId);
    revealReceipt = receipt(await mutation("v0Bets:pick", revealChoice), revealChoice);
    assert.ok(revealReceipt.updatedAt < nearReveal.revealAt);
    evidence.confirmationHTTP.reveal = { revealAt: nearReveal.revealAt, beforeServerTime: view.serverTime, acceptedAt: revealReceipt.updatedAt };
  });

  let winningChoice;
  let winningReceipt;
  for (const [name, bet, sameKey, samePayload, errorCode] of [
    ["different-key-different-payload", fixture, false, false, "CONFLICT"],
    ["same-key-same-payload", fixture.confirmationScenarios.sameRequestSamePayload, true, true, null],
    ["same-key-different-payload", fixture.confirmationScenarios.sameRequestDifferentPayload, true, false, "IDEMPOTENCY_CONFLICT"],
    ["different-key-same-payload", fixture.confirmationScenarios.newRequestSamePayload, false, true, null],
  ]) {
    await check(`QA-CONFIRM.http-overlap.${name}`, async () => {
      const before = await count();
      const first = args(bet.betId);
      const second = { ...first, requestId: sameKey ? first.requestId : randomUUID(), option: samePayload ? first.option : 1, confidence: samePayload ? first.confidence : 0.75 };
      const start = requests.length;
      const results = await Promise.allSettled([mutation("v0Bets:pick", first), mutation("v0Bets:pick", second)]);
      const successes = results.flatMap((result, index) => result.status === "fulfilled" ? [{ receipt: receipt(result.value, index ? second : first), choice: index ? second : first }] : []);
      const failures = results.flatMap((result) => result.status === "rejected" ? [result.reason] : []);
      assert.equal(successes.length, errorCode ? 1 : 2);
      assert.equal(failures.length, errorCode ? 1 : 0);
      if (errorCode) {
        assert.ok(failures[0] instanceof ConvexError);
        assert.equal(failures[0].data?.code, errorCode);
      } else assert.deepEqual(successes[0].receipt, successes[1].receipt);
      const observed = requests.slice(start);
      assert.equal(observed.length, 2);
      const overlapped = Math.max(...observed.map((item) => item.startedAtMs)) < Math.min(...observed.map((item) => item.finishedAtMs));
      assert.equal(overlapped, true, "The two actual HTTP request intervals did not overlap");
      assert.equal(await count(), before + 1);
      const view = await get(bet);
      selection(view, successes[0].choice);
      assert.equal(view.card.bettorCount, 1);
      evidence.confirmationHTTP.races.push({ name, requestCount: 2, overlappingHTTPIntervals: true, successfulAcknowledgments: successes.length, logicalRejectionCode: errorCode, persistedPickDelta: 1 });
      if (name === "different-key-different-payload") { winningChoice = successes[0].choice; winningReceipt = successes[0].receipt; }
    });
  }

  await check("QA-CONFIRM.http-stable-new-key-and-immutable-choice", async () => {
    const before = await count();
    const matching = { ...winningChoice, requestId: randomUUID() };
    assert.deepEqual(await mutation("v0Bets:pick", matching), winningReceipt);
    assert.deepEqual(await mutation("v0Bets:pick", matching), winningReceipt);
    await unchangedCode(mutation("v0Bets:pick", { ...winningChoice, option: 1 - winningChoice.option }), "IDEMPOTENCY_CONFLICT");
    await unchangedCode(mutation("v0Bets:pick", { ...winningChoice, option: 1 - winningChoice.option, requestId: randomUUID() }), "CONFLICT");
    await unchangedCode(mutation("v0Bets:pick", { ...winningChoice, confidence: 0.5, requestId: randomUUID() }), "CONFLICT");
    assert.equal(await count(), before);
    selection(await get(fixture), winningChoice);
  });

  await check("QA-CONFIRM.http-lost-response-independent-bettor", async () => {
    assert.equal((await get(fixture, sessions.creator.token)).canPick, true);
    const before = await count();
    const choice = args(fixture.betId, { token: sessions.creator.token, option: 1, confidence: 0.5 });
    let discarded;
    const lostClient = new ConvexHttpClient(origin, { logger: false, skipConvexDeploymentUrlCheck: true, fetch: async (input, init) => {
      const response = await observedFetch(input, init);
      const envelope = await response.clone().json();
      assert.equal(envelope.status, "success");
      discarded = receipt(envelope.value, choice);
      throw new Error("Synthetic client discarded the successful HTTP pick response");
    } });
    await assert.rejects(lostClient.mutation(makeFunctionReference("v0Bets:pick"), choice, { skipQueue: true }), /Synthetic client discarded the successful HTTP pick response/);
    assert.ok(discarded);
    assert.equal(await count(), before + 1);
    selection(await get(fixture, sessions.creator.token), choice);
    assert.deepEqual(await mutation("v0Bets:pick", choice), discarded);
    assert.deepEqual(await mutation("v0Bets:pick", choice), discarded);
    assert.equal(await count(), before + 1);
    assert.equal((await get(fixture)).card.bettorCount, 2);
    selection(await get(fixture), winningChoice);
  });

  await check("QA-CONFIRM.http-ineligible-and-risk-denial", async () => {
    const before = await count();
    for (const role of ["subject", "outsider"]) await unchangedCode(mutation("v0Bets:pick", args(fixture.betId, { token: sessions[role].token })), "NOT_AVAILABLE");
    await unchangedCode(mutation("v0Bets:pick", { ...winningChoice, riskPoints: 0, requestId: randomUUID() }), "INVALID_INPUT");
    assert.equal(await count(), before);
  });
  await check("QA-CONFIRM.http-no-economic-mutation", async () => {
    assert.deepEqual(await balances(), initialBalances);
    assert.equal((await local.inspectFixture()).ledger, 0);
  });

  await delay(Math.max(0, nearReveal.revealAt - Date.now()) + 25);
  await check("QA-CONFIRM.http-after-reveal-new-admission-versus-replay", async () => {
    const before = await count();
    const view = await get(nearReveal, sessions.creator.token);
    assert.ok(view.serverTime >= nearReveal.revealAt);
    assert.equal(view.canPick, false);
    assert.equal(view.myPick, null);
    await unchangedCode(mutation("v0Bets:pick", args(nearReveal.betId, { token: sessions.creator.token })), "NOT_AVAILABLE");
    assert.deepEqual(await mutation("v0Bets:pick", revealChoice), revealReceipt);
    assert.deepEqual(await mutation("v0Bets:pick", { ...revealChoice, requestId: randomUUID() }), revealReceipt);
    assert.equal(await count(), before);
    selection(await get(nearReveal), revealChoice);
    evidence.confirmationHTTP.reveal.afterServerTime = view.serverTime;
    assert.deepEqual(await balances(), initialBalances);
  });

  await check("QA-CONFIRM.http-void-before-cached-receipt", async () => {
    const bet = fixture.confirmationScenarios.voidReplay;
    const choice = args(bet.betId);
    receipt(await mutation("v0Bets:pick", choice), choice);
    const before = await count();
    const economic = await balances();
    assert.deepEqual(await mutation("v0Bets:veto", { token: sessions.subject.token, betId: bet.betId, requestId: randomUUID() }), { voided: true });
    assert.equal((await query("v0Auth:me", { token: sessions.friend.token })).account.id, fixture.actors.friend);
    await unchangedCode(mutation("v0Bets:pick", choice), "NOT_AVAILABLE");
    await unchangedCode(mutation("v0Bets:pick", { ...choice, requestId: randomUUID() }), "NOT_AVAILABLE");
    assert.equal((await get(bet)).view, "unavailable");
    assert.equal(await count(), before);
    assert.deepEqual(await balances(), economic);
  });

  await check("QA-CONFIRM.http-membership-rejoin-cannot-revive-receipt", async () => {
    const bet = fixture.confirmationScenarios.memberReplay;
    const choice = args(bet.betId);
    receipt(await mutation("v0Bets:pick", choice), choice);
    const before = await count();
    assert.deepEqual(await mutation("v0Controls:leave", { token: sessions.friend.token, groupId: fixture.groups[0], requestId: randomUUID() }), { left: true });
    await unchangedCode(mutation("v0Bets:pick", choice), "NOT_AVAILABLE");
    await mutation("v0Groups:invite", { token: sessions.creator.token, groupId: fixture.groups[0], phone: actors.friend.phone, requestId: randomUUID() });
    const invitations = await query("v0Groups:invitations", { token: sessions.friend.token });
    assert.equal(invitations.length, 1);
    const accepted = await mutation("v0Groups:accept", { token: sessions.friend.token, inviteId: invitations[0].id, requestId: randomUUID() });
    assert.equal(accepted.id, fixture.groups[0]);
    assert.ok((await query("v0Auth:me", { token: sessions.friend.token })).groups.some((group) => group.id === fixture.groups[0]));
    await unchangedCode(get(bet), "NOT_AVAILABLE");
    await unchangedCode(mutation("v0Bets:pick", choice), "NOT_AVAILABLE");
    assert.equal(await count(), before);
  });

  await check("QA-CONFIRM.http-revocation-and-block-before-replay", async () => {
    const bet = fixture.confirmationScenarios.blockReplay;
    const choice = args(bet.betId);
    const original = receipt(await mutation("v0Bets:pick", choice), choice);
    const before = await count();
    const pair = await mutation("v0Auth:createPair", { token: sessions.friend.token, requestId: randomUUID() });
    markSensitive(pair.code);
    const second = await action("v0Auth:redeemPair", { code: pair.code, deviceId: "qa-confirmation-second-device", requestId: randomUUID() });
    markSensitive(second.token);
    assert.equal(second.account.id, fixture.actors.friend);
    await mutation("v0Auth:revoke", { token: sessions.friend.token, allDevices: false, requestId: randomUUID() });
    await unchangedCode(mutation("v0Bets:pick", choice), "AUTH_REQUIRED");
    assert.deepEqual(await mutation("v0Bets:pick", { ...choice, token: second.token }), original);
    assert.deepEqual(await mutation("v0Controls:block", { token: sessions.creator.token, accountId: fixture.actors.friend, requestId: randomUUID() }), { blocked: true });
    assert.equal((await query("v0Auth:me", { token: second.token })).account.id, fixture.actors.friend);
    await unchangedCode(mutation("v0Bets:pick", { ...choice, token: second.token }), "NOT_AVAILABLE");
    await unchangedCode(get(bet, second.token), "NOT_AVAILABLE");
    assert.equal(await count(), before);
  });
  evidence.confirmationHTTP.finalFixtureCounts = await local.inspectFixture();
  assert.equal(evidence.confirmationHTTP.finalFixtureCounts.picks, 9);
  assert.equal(evidence.confirmationHTTP.finalFixtureCounts.ledger, 0);
}
