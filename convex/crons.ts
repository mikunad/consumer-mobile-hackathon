import { cronJobs } from "convex/server";
import { internal } from "./_generated/api";

const crons = cronJobs();
crons.interval("advance V0 cutoff and reveal clocks", { minutes: 1 }, internal.v0Jobs.sweep, {});
crons.interval("deliver neutral V0 notifications", { minutes: 1 }, internal.v0Notifications.deliverPending, {});
export default crons;
