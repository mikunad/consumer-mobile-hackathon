import { internalMutation } from "./_generated/server";
import { advanceBet } from "./v0Bets";
import { approvedPolicy } from "./v0GamePolicy";

export const sweep = internalMutation({
  args: {},
  handler: async (ctx) => {
    const now = Date.now();
    const open = await ctx.db.query("v0Bets").withIndex("by_state_reveal", (q) => q.eq("state", "open").lte("revealAt", now)).take(100);
    const locked = await ctx.db.query("v0Bets").withIndex("by_state_reveal", (q) => q.eq("state", "locked").lte("revealAt", now)).take(100);
    const unanswered = await ctx.db.query("v0Bets").withIndex("by_state_reveal", (q) => q.eq("state", "revealed").lte("revealAt", now - approvedPolicy.unansweredDurationMs)).take(100);
    for (const bet of [...open, ...locked, ...unanswered]) await advanceBet(ctx, bet);
    return { advanced: open.length + locked.length + unanswered.length };
  },
});
