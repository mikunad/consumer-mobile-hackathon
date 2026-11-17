import { internalMutation, internalQuery, httpAction } from "./_generated/server";
import { v } from "convex/values";
import { landingResponse } from "./v0Web";

export const generateUploadUrl = internalMutation({
  args: {},
  handler: async (ctx) => await ctx.storage.generateUploadUrl(),
});

export const record = internalMutation({
  args: { path: v.string(), storageId: v.id("_storage"), contentType: v.string(), deployId: v.string() },
  handler: async (ctx, a) => {
    const old = await ctx.db
      .query("assets")
      .withIndex("by_path", (q) => q.eq("path", a.path))
      .collect();
    for (const o of old) {
      await ctx.storage.delete(o.storageId);
      await ctx.db.delete(o._id);
    }
    await ctx.db.insert("assets", a);
  },
});

export const lookup = internalQuery({
  args: { path: v.string() },
  handler: async (ctx, { path }) =>
    await ctx.db
      .query("assets")
      .withIndex("by_path", (q) => q.eq("path", path))
      .first(),
});

export const serve = httpAction(async (_ctx, request) => landingResponse(request));
