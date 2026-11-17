import { useEffect, useRef, useState } from "react";
import { Pressable, ScrollView, Text, TextInput, View } from "react-native";
import { useLocalSearchParams, useRouter } from "expo-router";
import { useMutation, useQuery } from "convex/react";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { api } from "@convex/_generated/api";
import { useIdentity } from "@/lib/identity";
import { fmt } from "@/lib/time";
import { Wordmark } from "@/components/ui";
import { ChatJoin } from "@/components/chat/join";
import { ConnectContext } from "@/components/chat/connect-context";
import AsyncStorage from "@react-native-async-storage/async-storage";
import { Stack } from "@/components/chat/thread";
import { I, t } from "@/components/chat/ios";

function when(ts: number) {
  const d = new Date(ts);
  const h = d.getHours() % 12 || 12;
  return h + ":" + String(d.getMinutes()).padStart(2, "0") + (d.getHours() < 12 ? " AM" : " PM");
}

export default function ChatList() {
  const insets = useSafeAreaInsets();
  const router = useRouter();
  const { token, ready } = useIdentity();
  const params = useLocalSearchParams<{ invite?: string }>();
  const home = useQuery(api.chat.home, { token: token ?? undefined });
  const enter = useMutation(api.chat.enter);
  const createGroup = useMutation(api.chat.createGroup);
  const join = useMutation(api.chat.join);
  const tried = useRef(false);
  const [mode, setMode] = useState<null | "new" | "join">(null);
  const [name, setName] = useState("");
  const [err, setErr] = useState<string | null>(null);
  const [ctx, setCtx] = useState<"unknown" | "show" | "done">("unknown");
  useEffect(() => {
    AsyncStorage.getItem("calledit.context").then((v) => setCtx(v ? "done" : "show"));
  }, []);
  useEffect(() => {
    if (!token || !home?.user || tried.current) return;
    tried.current = true;
    if (params.invite) join({ token, invite: params.invite }).catch(() => {});
    else enter({ token }).catch(() => {});
  }, [token, home, tried, params.invite, enter, join]);
  if (!ready || home === undefined) return <View style={{ flex: 1, backgroundColor: I.bg }} />;
  if (!home.user || !token) return <ChatJoin />;
  if (ctx === "show")
    return (
      <ConnectContext
        onDone={() => {
          AsyncStorage.setItem("calledit.context", "1");
          setCtx("done");
        }}
      />
    );
  const stats = home.stats;
  const submit = async () => {
    setErr(null);
    try {
      const id = mode === "new" ? await createGroup({ token, name }) : await join({ token, invite: name });
      setMode(null);
      setName("");
      router.push({ pathname: "/c/g/[id]", params: { id } });
    } catch (e) {
      setErr(String((e as { data?: string }).data ?? (e as Error).message));
    }
  };
  return (
    <ScrollView style={{ flex: 1, backgroundColor: I.bg }} contentContainerStyle={{ paddingTop: insets.top + 8, paddingBottom: 60, maxWidth: 620, width: "100%", alignSelf: "center" }} keyboardShouldPersistTaps="handled">
      <View style={{ flexDirection: "row", alignItems: "center", paddingHorizontal: 16, height: 44 }}>
        <Pressable onPress={() => setMode(mode === "join" ? null : "join")} hitSlop={8}>
          <Text style={t(17, "400", I.blue)}>Join</Text>
        </Pressable>
        <View style={{ flex: 1, alignItems: "center" }}>
          <Wordmark size={14} />
        </View>
        <Pressable onPress={() => setMode(mode === "new" ? null : "new")} hitSlop={8}>
          <Text style={t(22, "400", I.blue)}>✎</Text>
        </Pressable>
      </View>
      <Text style={[t(34, "700"), { paddingHorizontal: 16, marginTop: 2, marginBottom: 10 }]}>Groups</Text>
      {stats ? (
        <View style={{ flexDirection: "row", marginHorizontal: 16, backgroundColor: I.fill, borderRadius: 12, paddingVertical: 12, marginBottom: 12 }}>
          <View style={{ flex: 1, alignItems: "center", gap: 2 }}>
            <Text style={[t(20, "700"), { fontVariant: ["tabular-nums"] }]}>{fmt(stats.total)}</Text>
            <Text style={t(11, "400", I.secondary)}>total points</Text>
          </View>
          <View style={{ width: 0.5, backgroundColor: I.sep }} />
          <View style={{ flex: 1.3, alignItems: "center", gap: 2, paddingHorizontal: 6 }}>
            <Text numberOfLines={1} style={t(20, "700")}>{stats.best ? "#" + stats.best.rank : "–"}</Text>
            <Text numberOfLines={1} style={t(11, "400", I.secondary)}>{stats.best ? "in " + stats.best.name : "no groups yet"}</Text>
          </View>
          <View style={{ width: 0.5, backgroundColor: I.sep }} />
          <View style={{ flex: 1, alignItems: "center", gap: 2, paddingHorizontal: 6 }}>
            <Text numberOfLines={1} style={t(20, "700")}>{stats.nemesis ? stats.nemesis.emoji : "😇"}</Text>
            <Text numberOfLines={1} style={t(11, "400", I.secondary)}>{stats.nemesis ? "nemesis @" + stats.nemesis.name : "no nemesis yet"}</Text>
          </View>
        </View>
      ) : null}
      {mode ? (
        <View style={{ marginHorizontal: 16, marginBottom: 12, gap: 8 }}>
          <View style={{ flexDirection: "row", gap: 8 }}>
            <TextInput
              value={name}
              onChangeText={setName}
              autoFocus
              autoCapitalize={mode === "join" ? "none" : "words"}
              placeholder={mode === "new" ? "Group name, e.g. Us two" : "Invite code"}
              placeholderTextColor={I.secondary}
              onSubmitEditing={submit}
              style={[t(17), { flex: 1, backgroundColor: I.fill, borderRadius: 10, paddingHorizontal: 12, paddingVertical: 9 }]}
            />
            <Pressable onPress={submit} style={{ backgroundColor: I.blue, borderRadius: 10, paddingHorizontal: 14, justifyContent: "center" }}>
              <Text style={t(16, "600", "#fff")}>{mode === "new" ? "Create" : "Join"}</Text>
            </Pressable>
          </View>
          {err ? <Text style={t(13, "500", I.red)}>{err}</Text> : null}
        </View>
      ) : null}
      {home.groups.map((g, i) => (
        <Pressable key={g._id} onPress={() => router.push({ pathname: "/c/g/[id]", params: { id: g._id } })} style={({ pressed }) => ({ flexDirection: "row", alignItems: "center", paddingLeft: 16, backgroundColor: pressed ? I.fill : I.bg })}>
          <View style={{ paddingVertical: 10, marginRight: 12 }}>
            <Stack faces={g.faces.length ? g.faces : [home.user!.emoji]} size={46} />
          </View>
          <View style={{ flex: 1, paddingVertical: 10, paddingRight: 16, borderBottomWidth: i === home.groups.length - 1 ? 0 : 0.5, borderBottomColor: I.sep, gap: 2 }}>
            <View style={{ flexDirection: "row", alignItems: "center" }}>
              <Text numberOfLines={1} style={[t(17, "600"), { flex: 1 }]}>{g.name}</Text>
              <Text style={t(15, "400", I.secondary)}>{g.last ? when(g.last.t) : ""} ›</Text>
            </View>
            <Text numberOfLines={2} style={t(15, "400", I.secondary)}>{g.last?.text ?? "No bets yet. Start something."}</Text>
          </View>
        </Pressable>
      ))}
      {home.groups.length === 0 ? <Text style={[t(15, "400", I.secondary), { textAlign: "center", marginTop: 40, paddingHorizontal: 30 }]}>No groups yet. Tap ✎ to start one, or Join with a friend&apos;s invite code.</Text> : null}
      <Text style={[t(12, "400", I.secondary), { textAlign: "center", marginTop: 30 }]}>
        {home.user.emoji} @{home.user.name}
      </Text>
    </ScrollView>
  );
}
