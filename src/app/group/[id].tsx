import { useState } from "react";
import { Pressable, ScrollView, Text, TextInput, View } from "react-native";
import { router, useLocalSearchParams } from "expo-router";
import { useMutation, useQuery } from "convex/react";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { api } from "@convex/_generated/api";
import { Id } from "@convex/_generated/dataModel";
import { useIdentity } from "@/lib/identity";
import { useNow, useQueryNow } from "@/lib/time";
import { useStableQuery } from "@/lib/use-stable-query";
import { C, F } from "@/lib/theme";
import { MarketCard } from "@/components/market-card";
import { Leaderboard } from "@/components/leaderboard";
import { Button, Card, s } from "@/components/ui";

const input = {
  fontFamily: F.bodyMed,
  fontSize: 16,
  color: C.ink,
  backgroundColor: C.paper,
  borderRadius: 10,
  paddingHorizontal: 12,
  paddingVertical: 10,
};

function errText(e: unknown) {
  const d = (e as { data?: unknown }).data;
  return typeof d === "string" ? d : "Something went wrong";
}

export default function GroupScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const groupId = id as Id<"groups">;
  const insets = useSafeAreaInsets();
  const { token } = useIdentity();
  const now = useNow();
  const qnow = useQueryNow();
  const group = useQuery(api.groups.get, { token: token ?? undefined, groupId });
  const me = useQuery(api.users.me, { token: token ?? undefined });
  const today = useStableQuery(api.game.today, { token: token ?? undefined, now: qnow, groupId });
  const rows = useStableQuery(api.game.leaderboard, { now: qnow, groupId });
  if (group === undefined) return <View style={s.screen} />;
  if (group === null) return <View style={[s.screen, s.column, { paddingTop: 80 }]}><Text style={s.h2}>Group not found</Text></View>;
  const round = today?.round ?? null;
  return (
    <ScrollView style={s.screen} contentContainerStyle={[s.column, { paddingTop: insets.top + 14, paddingBottom: 80, gap: 14 }]}>
      <Pressable onPress={() => (router.canGoBack() ? router.back() : router.replace("/me"))}>
        <Text style={[s.sub, { fontFamily: F.bodyBold }]}>‹ Back</Text>
      </Pressable>
      <Text style={s.h1}>{group.name}</Text>
      <Text style={[s.sub, { marginTop: -8 }]}>
        {group.members.map((m) => m.emoji + " @" + m.name).join("   ")}
      </Text>
      {group.isDefault ? (
        <Card>
          <Text style={s.body}>Hackathon drops live on the Today tab. Everyone who joins is in this group.</Text>
        </Card>
      ) : (
        <>
          {group.isMember && token ? <AddMember token={token} groupId={groupId} /> : null}
          {today?.aboutMe ? (
            <Card style={{ backgroundColor: C.goldSoft, borderColor: C.gold }}>
              <Text style={s.h2}>
                {today.aboutMe} {today.aboutMe === 1 ? "bet is" : "bets are"} riding on you
              </Text>
              <Text style={s.sub}>You can&apos;t see them. Your friends can.</Text>
            </Card>
          ) : null}
          {round && me && today
            ? today.bets.map((m) => (
                <MarketCard
                  key={m._id}
                  m={m}
                  ctx={{
                    token,
                    points: me.points,
                    mult: 1,
                    roundStart: round.opensAt,
                    roundLock: today.next?.opensAt ?? round.opensAt + 3600000,
                    now,
                    late: now - round.opensAt > 10 * 60 * 1000,
                  }}
                />
              ))
            : null}
          {group.isOwner && token && today ? <OwnerSettle token={token} bets={today.bets} /> : null}
          {group.isMember && token ? <AddBet token={token} groupId={groupId} members={group.members.filter((m) => m._id !== me?._id)} /> : null}
        </>
      )}
      <Text style={[s.label, { marginTop: 8 }]}>Leaderboard</Text>
      {rows ? <Leaderboard rows={rows} highlight={me?._id} /> : null}
    </ScrollView>
  );
}

function AddMember({ token, groupId }: { token: string; groupId: Id<"groups"> }) {
  const [q, setQ] = useState("");
  const results = useQuery(api.groups.searchUsers, q.length >= 1 ? { token, q } : "skip");
  const add = useMutation(api.groups.addMember);
  const [msg, setMsg] = useState<string | null>(null);
  return (
    <View style={{ gap: 6 }}>
      <TextInput
        value={q}
        onChangeText={setQ}
        autoCapitalize="none"
        autoCorrect={false}
        placeholder="Add people by @username"
        placeholderTextColor={C.faint}
        style={input}
      />
      {(results ?? []).map((u) => (
        <Pressable
          key={u._id}
          onPress={async () => {
            try {
              await add({ token, groupId, userId: u._id });
              setMsg("Added @" + u.name);
              setQ("");
            } catch (e) {
              setMsg(errText(e));
            }
          }}
          style={{ flexDirection: "row", gap: 8, alignItems: "center", padding: 8, backgroundColor: C.card, borderRadius: 10 }}
        >
          <Text style={{ fontSize: 18 }}>{u.emoji}</Text>
          <Text style={[s.body, { flex: 1 }]}>@{u.name}</Text>
          <Text style={{ fontFamily: F.bodyBold, color: C.yes }}>Add</Text>
        </Pressable>
      ))}
      {msg ? <Text style={s.sub}>{msg}</Text> : null}
    </View>
  );
}

function AddBet({ token, groupId, members }: { token: string; groupId: Id<"groups">; members: { _id: Id<"users">; name: string; emoji: string }[] }) {
  const add = useMutation(api.groups.addBet);
  const [question, setQuestion] = useState("");
  const [kind, setKind] = useState<"yesno" | "overunder">("yesno");
  const [line, setLine] = useState("2.5");
  const [subject, setSubject] = useState<Id<"users"> | undefined>(undefined);
  const [err, setErr] = useState<string | null>(null);
  return (
    <Card style={{ gap: 8 }}>
      <Text style={s.label}>Add a bet to this drop</Text>
      <TextInput value={question} onChangeText={setQuestion} placeholder="Will Sam be late to dinner?" placeholderTextColor={C.faint} style={input} />
      <View style={{ flexDirection: "row", gap: 6 }}>
        {(["yesno", "overunder"] as const).map((k) => (
          <Button
            key={k}
            small
            color={kind === k ? C.ink : C.tile}
            textColor={kind === k ? "#fff" : C.ink}
            label={k === "yesno" ? "Yes/No" : "Over/Under"}
            onPress={() => setKind(k)}
          />
        ))}
        {kind === "overunder" ? <TextInput value={line} onChangeText={setLine} keyboardType="decimal-pad" style={[input, { width: 70 }]} /> : null}
      </View>
      {members.length ? (
        <>
          <Text style={s.sub}>About someone? They won&apos;t see it.</Text>
          <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 6 }}>
            {members.map((m) => (
              <Pressable
                key={m._id}
                onPress={() => setSubject(subject === m._id ? undefined : m._id)}
                style={{
                  paddingVertical: 6,
                  paddingHorizontal: 10,
                  borderRadius: 10,
                  backgroundColor: subject === m._id ? C.ink : C.paper,
                }}
              >
                <Text style={{ fontFamily: F.bodyMed, color: subject === m._id ? "#fff" : C.ink }}>
                  {m.emoji} @{m.name}
                </Text>
              </Pressable>
            ))}
          </View>
        </>
      ) : null}
      {err ? <Text style={{ color: C.no, fontFamily: F.bodyMed }}>{err}</Text> : null}
      <Button
        small
        label="Add bet"
        color={C.yes}
        disabled={!question.trim()}
        onPress={async () => {
          setErr(null);
          const l = Number(line);
          if (kind === "overunder" && (!Number.isFinite(l) || Math.abs((l % 1) - 0.5) > 1e-9)) {
            setErr("Over/under lines end in .5");
            return;
          }
          try {
            await add({ token, groupId, question, kind, line: kind === "overunder" ? l : undefined, subjectUserId: subject });
            setQuestion("");
            setSubject(undefined);
          } catch (e) {
            setErr(errText(e));
          }
        }}
      />
    </Card>
  );
}

function OwnerSettle({ token, bets }: { token: string; bets: { _id: Id<"bets">; question: string; options: string[]; status: string }[] }) {
  const settle = useMutation(api.groups.settle);
  const open = bets.filter((b) => b.status === "open" || b.status === "locked");
  const [err, setErr] = useState<string | null>(null);
  if (!open.length) return null;
  return (
    <Card style={{ gap: 10 }}>
      <Text style={s.label}>You run this group · call results</Text>
      {open.map((b) => (
        <View key={b._id} style={{ gap: 6 }}>
          <Text style={[s.body, { fontFamily: F.bodyMed }]}>{b.question}</Text>
          <View style={{ flexDirection: "row", gap: 6, flexWrap: "wrap" }}>
            {b.options.map((o, i) => (
              <Button key={i} small color={i === 0 ? C.yes : C.no} label={o + " happened"} onPress={() => settle({ token, betId: b._id, winningOption: i }).catch((e) => setErr(errText(e)))} />
            ))}
            <Button small color={C.tile} textColor={C.ink} label="Void" onPress={() => settle({ token, betId: b._id, winningOption: null }).catch((e) => setErr(errText(e)))} />
          </View>
        </View>
      ))}
      {err ? <Text style={{ color: C.no }}>{err}</Text> : null}
    </Card>
  );
}
