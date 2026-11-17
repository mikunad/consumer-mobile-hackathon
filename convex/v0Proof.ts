import { makeFunctionReference } from "convex/server";
import { v } from "convex/values";
import type { Doc, Id } from "./_generated/dataModel";
import { action, internalMutation, internalQuery, query, type QueryCtx } from "./_generated/server";
import type { PrivateProof, ProofRef } from "./v0Contract";
import { fail, once, rateLimit, requireBet, requireSession } from "./v0Policy";
import { stateAt } from "./v0GamePolicy";

const contentType = v.union(v.literal("image/jpeg"), v.literal("image/png"), v.literal("audio/mp4"));
const MAX_PROOF_BYTES = 512 * 1024;

function proofRef(proof: Doc<"v0Proofs">): ProofRef {
  return { id: proof._id, contentType: proof.contentType, createdAt: proof.createdAt };
}

async function visibleBet(ctx: QueryCtx, token: string, betId: Id<"v0Bets">) {
  const { account } = await requireSession(ctx, token);
  const bet = await requireBet(ctx, betId, account._id);
  if (Date.now() < bet.revealAt || stateAt(bet, Date.now()) === "voided") fail("NOT_AVAILABLE");
  return { account, bet };
}

function validateBytes(bytes: ArrayBuffer, type: string) {
  const data = new Uint8Array(bytes);
  if (!data.length || data.length > MAX_PROOF_BYTES) fail("INVALID_INPUT", "Choose proof smaller than 512 KiB.");
  const jpeg = data[0] === 0xff && data[1] === 0xd8 && data[2] === 0xff;
  const png = [137, 80, 78, 71, 13, 10, 26, 10].every((value, index) => data[index] === value);
  const mp4 = data.length >= 12 && String.fromCharCode(...data.slice(4, 8)) === "ftyp";
  if ((type === "image/jpeg" && !jpeg) || (type === "image/png" && !png) || (type === "audio/mp4" && !mp4)) fail("INVALID_INPUT", "The proof file format is not supported.");
}

const uploadArgs = { token: v.string(), betId: v.id("v0Bets"), contentType, bytes: v.bytes(), requestId: v.string() };
type UploadArgs = { token: string; betId: Id<"v0Bets">; contentType: ProofRef["contentType"]; bytes: ArrayBuffer; requestId: string };

export const store = internalMutation({
  args: uploadArgs,
  handler: async (ctx, args): Promise<ProofRef> => {
    const { account, bet } = await visibleBet(ctx, args.token, args.betId);
    if (bet.subjectId !== account._id) fail("NOT_AVAILABLE");
    validateBytes(args.bytes, args.contentType);
    const sha256 = Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", args.bytes)), (byte) => byte.toString(16).padStart(2, "0")).join("");
    return await once(ctx, account._id, "proof", args.requestId, { betId: bet._id, contentType: args.contentType, sha256 }, async () => {
      await rateLimit(ctx, `proof:${account._id}`, 12, 60 * 60_000);
      const storageId = await ctx.storage.store(new Blob([args.bytes], { type: args.contentType }));
      const createdAt = Date.now();
      const id = await ctx.db.insert("v0Proofs", { accountId: account._id, betId: bet._id, storageId, contentType: args.contentType, sha256, requestId: args.requestId, createdAt });
      return { id, contentType: args.contentType, createdAt };
    });
  },
});

export const upload = action({
  args: uploadArgs,
  handler: async (ctx, args): Promise<ProofRef> => await ctx.runMutation(makeFunctionReference<"mutation", UploadArgs, ProofRef>("v0Proof:store"), args),
});

export const list = query({
  args: { token: v.string(), betId: v.id("v0Bets") },
  handler: async (ctx, { token, betId }): Promise<ProofRef[]> => {
    await visibleBet(ctx, token, betId);
    return (await ctx.db.query("v0Proofs").withIndex("by_bet", (q) => q.eq("betId", betId)).collect()).map(proofRef);
  },
});

export const authorizeRead = internalQuery({
  args: { token: v.string(), proofId: v.id("v0Proofs") },
  handler: async (ctx, { token, proofId }) => {
    const proof = await ctx.db.get(proofId);
    if (!proof) {
      await requireSession(ctx, token);
      return fail("NOT_AVAILABLE");
    }
    await visibleBet(ctx, token, proof.betId);
    return { ...proofRef(proof), storageId: proof.storageId };
  },
});

type AuthorizedProof = ProofRef & { storageId: Id<"_storage"> };
const readReference = makeFunctionReference<"query", { token: string; proofId: Id<"v0Proofs"> }, AuthorizedProof>("v0Proof:authorizeRead");

export const read = action({
  args: { token: v.string(), proofId: v.id("v0Proofs") },
  handler: async (ctx, args): Promise<PrivateProof> => {
    const proof = await ctx.runQuery(readReference, args);
    const blob = await ctx.storage.get(proof.storageId);
    if (!blob || blob.size > MAX_PROOF_BYTES) fail("NOT_AVAILABLE");
    const bytes = await blob.arrayBuffer();
    await ctx.runQuery(readReference, args);
    return { id: proof.id, contentType: proof.contentType, createdAt: proof.createdAt, bytes };
  },
});
