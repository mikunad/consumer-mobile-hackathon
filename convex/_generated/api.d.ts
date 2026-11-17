/* eslint-disable */
/**
 * Generated `api` utility.
 *
 * THIS CODE IS AUTOMATICALLY GENERATED.
 *
 * To regenerate, run `npx convex dev`.
 * @module
 */

import type {
  ApiFromModules,
  FilterApi,
  FunctionReference,
} from "convex/server";
import type * as admin from "../admin.js";
import type * as ai from "../ai.js";
import type * as chat from "../chat.js";
import type * as crons from "../crons.js";
import type * as ext from "../ext.js";
import type * as game from "../game.js";
import type * as groups from "../groups.js";
import type * as hosting from "../hosting.js";
import type * as http from "../http.js";
import type * as lib from "../lib.js";
import type * as market from "../market.js";
import type * as merge from "../merge.js";
import type * as reveal from "../reveal.js";
import type * as users from "../users.js";
import type * as v0ApiPolicy from "../v0ApiPolicy.js";
import type * as v0Apns from "../v0Apns.js";
import type * as v0Auth from "../v0Auth.js";
import type * as v0AuthProvider from "../v0AuthProvider.js";
import type * as v0Bets from "../v0Bets.js";
import type * as v0Cleanup from "../v0Cleanup.js";
import type * as v0Contract from "../v0Contract.js";
import type * as v0Controls from "../v0Controls.js";
import type * as v0Groups from "../v0Groups.js";
import type * as v0Jobs from "../v0Jobs.js";
import type * as v0Legacy from "../v0Legacy.js";
import type * as v0Notifications from "../v0Notifications.js";
import type * as v0Policy from "../v0Policy.js";
import type * as v0Proof from "../v0Proof.js";
import type * as v0Runtime from "../v0Runtime.js";
import type * as v0Safety from "../v0Safety.js";
import type * as v0Schema from "../v0Schema.js";
import type * as v0Suggestions from "../v0Suggestions.js";
import type * as v0Web from "../v0Web.js";

/**
 * A utility for referencing Convex functions in your app's API.
 *
 * Usage:
 * ```js
 * const myFunctionReference = api.myModule.myFunction;
 * ```
 */
declare const fullApi: ApiFromModules<{
  admin: typeof admin;
  ai: typeof ai;
  chat: typeof chat;
  crons: typeof crons;
  ext: typeof ext;
  game: typeof game;
  groups: typeof groups;
  hosting: typeof hosting;
  http: typeof http;
  lib: typeof lib;
  market: typeof market;
  merge: typeof merge;
  reveal: typeof reveal;
  users: typeof users;
  v0ApiPolicy: typeof v0ApiPolicy;
  v0Apns: typeof v0Apns;
  v0Auth: typeof v0Auth;
  v0AuthProvider: typeof v0AuthProvider;
  v0Bets: typeof v0Bets;
  v0Cleanup: typeof v0Cleanup;
  v0Contract: typeof v0Contract;
  v0Controls: typeof v0Controls;
  v0Groups: typeof v0Groups;
  v0Jobs: typeof v0Jobs;
  v0Legacy: typeof v0Legacy;
  v0Notifications: typeof v0Notifications;
  v0Policy: typeof v0Policy;
  v0Proof: typeof v0Proof;
  v0Runtime: typeof v0Runtime;
  v0Safety: typeof v0Safety;
  v0Schema: typeof v0Schema;
  v0Suggestions: typeof v0Suggestions;
  v0Web: typeof v0Web;
}>;
export declare const api: FilterApi<
  typeof fullApi,
  FunctionReference<any, "public">
>;
export declare const internal: FilterApi<
  typeof fullApi,
  FunctionReference<any, "internal">
>;
