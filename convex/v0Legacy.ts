import {
  action as originalAction,
  internalMutation as originalInternalMutation,
  mutation as originalMutation,
  query as originalQuery,
} from "./_generated/server";
import { legacyUnavailable } from "./v0Policy";

function disabled(builder: (definition: any) => any) {
  return (definition: any) => builder(typeof definition === "function" ? legacyUnavailable : { ...definition, handler: legacyUnavailable });
}

export const query = disabled(originalQuery) as typeof originalQuery;
export const mutation = disabled(originalMutation) as typeof originalMutation;
export const action = disabled(originalAction) as typeof originalAction;
export const internalMutation = disabled(originalInternalMutation) as typeof originalInternalMutation;
