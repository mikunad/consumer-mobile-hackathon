import { useState } from "react";
import { Pressable, ScrollView, Text, View } from "react-native";
import { useMutation } from "convex/react";
import { useLocalSearchParams, useRouter } from "expo-router";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { StatusBar } from "expo-status-bar";
import { api } from "@convex/_generated/api";
import { Id } from "@convex/_generated/dataModel";
import { useIdentity } from "@/lib/identity";
import { useStableQuery } from "@/lib/use-stable-query";
import { fmt, useQueryNow } from "@/lib/time";
import { Avatar, Stack } from "@/components/chat/thread";
import { Bounce, N, Ticker, label, mono, nt } from "@/components/chat/night";

export default function GroupInfo() {
  const insets = useSafeAreaInsets();
  const router = useRouter();
  const { id } = useLocalSearchParams<{ id: string }>();
  const { token } = useIdentity();
  const qnow = useQueryNow();
  const pair = useMutation(api.ext.createPair);
  const [code, setCode] = useState<{ code: string; expiresAt: number } | null>(null);
  const data = useStableQuery(api.chat.thread, token ? { token, groupId: id as Id<"groups">, now: qnow } : ("skip" as never));
  if (!data)
    return (
      <View style={{ flex: 1, backgroundColor: N.bg }}>
        <StatusBar style="light" />
      </View>
    );
  const items = data.items as { type: string; total?: number; status?: string }[];
  const pot = items.filter((i) => i.type === "bet" || i.type === "sealed").reduce((a, i) => a + (i.total ?? 0), 0);
  const bets = items.filter((i) => i.type === "bet" || i.type === "sealed").length;
  const others = data.members.filter((m) => m._id !== data.me._id);
  const section = { backgroundColor: N.card, borderRadius: 16, borderWidth: 1, borderColor: N.line, marginHorizontal: 16, overflow: "hidden" as const };
  return (
    <ScrollView style={{ flex: 1, backgroundColor: N.bg }} contentContainerStyle={{ paddingTop: insets.top + 6, paddingBottom: 60, gap: 18, maxWidth: 620, width: "100%", alignSelf: "center" }}>
      <StatusBar style="light" />
      <View style={{ flexDirection: "row", paddingHorizontal: 16, height: 40, alignItems: "center" }}>
        <View style={{ flex: 1 }} />
        <Pressable onPress={() => (router.canGoBack() ? router.back() : router.replace({ pathname: "/c/g/[id]", params: { id } }))} hitSlop={10}>
          <Text style={nt(17, "600", N.lime)}>Done</Text>
        </Pressable>
      </View>
      <View style={{ alignItems: "center", gap: 8 }}>
        <Stack faces={others.map((m) => m.emoji)} size={84} />
        <Text style={nt(24, "800")}>{data.group.name}</Text>
        <Text style={mono(12, N.mut)}>{data.members.length} people · invite code {data.group.inviteCode}</Text>
      </View>
      <View style={[section, { padding: 18, gap: 6, alignItems: "center" }]}>
        <Text style={label()}>the dinner pot</Text>
        <Ticker value={pot} duration={1300} style={[mono(48, N.gold, true), { textShadowColor: N.gold, textShadowRadius: 16 }]} />
        <Text style={[nt(13, "400", N.mut), { textAlign: "center" }]}>
          {bets} bet{bets === 1 ? "" : "s"} riding. Last place after the reveal buys the first round.
        </Text>
      </View>
      <Text style={[label(), { marginHorizontal: 20, marginBottom: -10 }]}>leaderboard</Text>
      <View style={{ marginHorizontal: 16, gap: 8 }}>
        {data.members.map((m, i) => {
          const me = m._id === data.me._id;
          return (
            <View key={m._id} style={{ flexDirection: "row", alignItems: "center", gap: 12, paddingHorizontal: 14, paddingVertical: 10, backgroundColor: N.card, borderRadius: 14, borderWidth: me ? 1.5 : 1, borderColor: me ? N.lime : N.line, shadowColor: N.lime, shadowOpacity: me ? 0.3 : 0, shadowRadius: 12, shadowOffset: { width: 0, height: 0 } }}>
              <Text style={[mono(15, i === 0 ? N.gold : N.mut, true), { width: 20 }]}>{i + 1}</Text>
              <Avatar emoji={m.emoji} size={36} />
              <Text numberOfLines={1} style={[nt(16, me ? "700" : "500"), { flex: 1 }]}>
                {me ? "You" : m.name}
              </Text>
              <Ticker value={m.points} duration={900} style={mono(16, N.lime, true)} />
            </View>
          );
        })}
      </View>
      <View style={[section, { padding: 16, gap: 8 }]}>
        <Text style={nt(15, "700")}>Play inside iMessage</Text>
        <Text style={nt(14, "400", N.mut)}>Open Called It from the apps drawer in your group chat, then enter this one-time code to sign in there. It works once and expires in 10 minutes.</Text>
        {code ? (
          <Text selectable style={[mono(34, N.lime, true), { letterSpacing: 6, textAlign: "center" }]}>{code.code}</Text>
        ) : null}
        <View style={{ alignSelf: "flex-start" }}>
          <Bounce onPress={async () => token && setCode(await pair({ token }))} style={{ backgroundColor: N.lime, borderRadius: 12, paddingHorizontal: 16, paddingVertical: 10 }}>
            <Text style={nt(15, "700", N.bg)}>{code ? "New code" : "Pair iMessage app"}</Text>
          </Bounce>
        </View>
      </View>
      {data.aboutMe.bets > 0 ? (
        <View style={[section, { padding: 16, gap: 4 }]}>
          <Text style={nt(15, "700")}>Riding on you</Text>
          <Text style={mono(13, N.gold)}>
            {data.aboutMe.bets} bet{data.aboutMe.bets === 1 ? "" : "s"} · {data.aboutMe.friends} friend{data.aboutMe.friends === 1 ? "" : "s"} in · {fmt(data.aboutMe.points)} pts
          </Text>
        </View>
      ) : null}
    </ScrollView>
  );
}
