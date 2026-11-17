import { internalMutation } from "./v0Legacy";
import { v } from "convex/values";
import { START_POINTS } from "./lib";

export const mergeUser = internalMutation({
  args: { from: v.id("users"), to: v.id("users"), groupId: v.id("groups") },
  handler: async (ctx, { from, to, groupId }) => {
    const src = await ctx.db.get(from);
    const dst = await ctx.db.get(to);
    if (!src || !dst || from === to) throw new Error("bad users");
    const rounds = await ctx.db.query("rounds").filter((q) => q.eq(q.field("groupId"), groupId)).collect();
    let bets = 0;
    for (const r of rounds) {
      for (const b of await ctx.db.query("bets").withIndex("by_round", (q) => q.eq("roundId", r._id)).collect()) {
        const patch: Record<string, unknown> = {};
        if (b.subjectUserId === from) patch.subjectUserId = to;
        if (b.createdBy === from) patch.createdBy = to;
        if (Object.keys(patch).length) { await ctx.db.patch(b._id, patch); bets++; }
        for (const r2 of await ctx.db.query("reactions").withIndex("by_bet", (q) => q.eq("betId", b._id)).collect())
          if (r2.userId === from) await ctx.db.patch(r2._id, { userId: to });
      }
    }
    let stakes = 0;
    for (const s of await ctx.db.query("stakes").withIndex("by_user", (q) => q.eq("userId", from)).collect()) {
      if (rounds.some((r) => r._id === s.roundId)) { await ctx.db.patch(s._id, { userId: to }); stakes++; }
    }
    const sm = await ctx.db.query("members").withIndex("by_group_user", (q) => q.eq("groupId", groupId).eq("userId", from)).first();
    const dm = await ctx.db.query("members").withIndex("by_group_user", (q) => q.eq("groupId", groupId).eq("userId", to)).first();
    if (sm && dm) {
      const spent = START_POINTS - (sm.points ?? START_POINTS);
      await ctx.db.patch(dm._id, { points: (dm.points ?? START_POINTS) - spent });
      await ctx.db.delete(sm._id);
    }
    for (const s of await ctx.db.query("sessions").collect()) if (s.userId === from) await ctx.db.patch(s._id, { userId: to });
    await ctx.db.insert("sessions", { userId: to, token: src.token, device: "merged from @" + (src.username ?? src.name) });
    await ctx.db.patch(from, { token: "merged-" + crypto.randomUUID() });
    return { bets, stakes };
  },
});
