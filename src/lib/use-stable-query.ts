import { useQuery } from "convex/react";
import { FunctionReference, FunctionArgs } from "convex/server";

export function useStableQuery<Q extends FunctionReference<"query">>(query: Q, args: FunctionArgs<Q>) {
  return useQuery(query, args);
}
