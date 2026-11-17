import { useState } from "react";
import { Pressable, ScrollView, Text, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useQuery } from "convex/react";
import { api } from "@convex/_generated/api";
import { Id } from "@convex/_generated/dataModel";
import { useStableQuery } from "@/lib/use-stable-query";
import { useIdentity } from "@/lib/identity";
import { C, F, tnum } from "@/lib/theme";
import { fmt, useNow, useQueryNow } from "@/lib/time";
import { multiplier } from "@/lib/odds";
import { Join } from "@/components/join";
import { DropHeader } from "@/components/drop-header";
import { DropLands, useDropSeen } from "@/components/drop-lands";
import { MarketCard } from "@/components/market-card";
import { BottomTabs, Card, Flame, LateTag, TickingNumber, Wordmark, s } from "@/components/ui";
import { NetText, Scorecard, TileState, isResolved, tileOf, useRevealed } from "@/components/scorecard";
import { RevealBanner, RevealStory } from "@/components/reveal-story";

export default function Today() {
  const { token, ready } = useIdentity();
  const insets = useSafeAreaInsets();
  const qnow = useQueryNow();
  const now = useNow();
  const me = useQuery(api.users.me, { token: token ?? undefined });
  const today = useStableQuery(api.game.today, { token: token ?? undefined, now: qnow });
  const round = today?.round ?? null;
  const live = !!round && now >= round.opensAt;
  const drop = useDropSeen(live && today && today.bets.length > 0 ? round?._id : undefined);
  const [story, setStory] = useState<Id<"rounds"> | null>(null);

  if (!ready || (token && me === undefined)) return <View style={s.screen} />;
  if (!token || me === null) return <Join />;
  if (!me) return <View style={s.screen} />;
  if (live && round && drop.show) return <DropLands round={round} count={today?.bets.length ?? 0} now={now} onDone={drop.markSeen} />;

  const mult = multiplier(today?.streak.next ?? 1);
  const streakShown = today?.streak.shown ?? 0;
  const ctx = {
    token,
    points: me.points,
    mult,
    roundStart: round?.opensAt ?? 0,
    roundLock: today?.next?.opensAt ?? (round ? round.opensAt + 3600000 : 0),
    now,
    late: !!round && now - round.opensAt > 10 * 60 * 1000,
  };

  return (
    <View style={s.screen}>
      <ScrollView contentContainerStyle={[s.column, { paddingTop: insets.top + 14, paddingBottom: 120, gap: 14 }]}>
        <View style={{ flexDirection: "row", justifyContent: "space-between", alignItems: "center" }}>
          <Wordmark size={22} />
        </View>
        <View style={{ flexDirection: "row", alignItems: "center", gap: 10, paddingVertical: 4 }}>
          <Text style={{ fontSize: 30 }}>{me.emoji}</Text>
          <View style={{ flex: 1 }}>
            <Text style={{ fontFamily: F.displaySemi, fontSize: 20, color: C.ink }}>@{me.name}</Text>
            <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
              <Flame n={streakShown} />
              <Text style={s.sub}>{mult > 1 ? "+" + Math.round((mult - 1) * 100) + "% on wins this drop" : "bet every drop to build a streak"}</Text>
            </View>
          </View>
          <View style={{ alignItems: "flex-end" }}>
            <TickingNumber value={me.points} style={{ fontFamily: F.monoBold, fontSize: 26, color: C.ink }} />
            <Text style={s.label}>points</Text>
          </View>
        </View>

        <RevealBanner token={token} onOpen={setStory} />

        {today ? <DropHeader round={round} next={today.next} now={now} /> : null}
        {live && round && today && today.bets.length > 0 ? (
          <DropCard title={round.title} bets={today.bets} onOpen={() => setStory(round._id)} />
        ) : null}

        {round && now >= round.opensAt ? today?.bets.map((m) => <MarketCard key={m._id} m={m} ctx={ctx} />) : null}
        {today && today.waiting.length > 0 ? (
          <Card style={{ gap: 8 }}>
            <Text style={s.label}>Waiting on results</Text>
            {today.waiting.map((w) => (
              <View key={w._id} style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
                <Text style={[s.body, { flex: 1 }]} numberOfLines={1}>
                  {w.question}
                </Text>
                {w.late ? <LateTag /> : null}
                <Text style={[s.sub, { fontFamily: F.mono }]}>
                  {fmt(w.amount)} on {w.pick}
                </Text>
              </View>
            ))}
          </Card>
        ) : null}
        {live && today?.bets.length === 0 ? (
          <Card>
            <Text style={s.body}>Bets for this drop are on their way.</Text>
          </Card>
        ) : null}
        {!round ? (
          <Card style={{ gap: 8 }}>
            <Text style={s.h2}>How it works</Text>
            <Text style={[s.body, { color: C.sub, lineHeight: 22 }]}>
              Every hour a drop of bets lands for everyone at once. Pick a side and stake points. Winners split the whole pot by
              stake, so the long shot pays the most. Bet every drop to grow your streak: +10% on wins per drop in a row, up to 2x.
              Picks after the first 10 minutes are tagged late. Bets stay open until the next drop.
            </Text>
          </Card>
        ) : null}
      </ScrollView>
      <BottomTabs />
      {story ? <RevealStory token={token} roundId={story} onClose={() => setStory(null)} /> : null}
    </View>
  );
}

type DropBet = {
  _id: string;
  status: string;
  winningOption?: number;
  mine: { option: number; amount: number; payout?: number }[];
};

function DropCard({ title, bets, onOpen }: { title: string; bets: DropBet[]; onOpen: () => void }) {
  const revealed = useRevealed();
  const shown = bets.map((b) => isResolved(b.status) && !!revealed?.has(b._id));
  const tiles: TileState[] = bets.map((b, i) =>
    isResolved(b.status) && !shown[i] ? "hidden" : tileOf(b.status, b.winningOption, b.mine[0]?.option),
  );
  const settled = bets.filter((b) => isResolved(b.status)).length;
  const waiting = shown.filter((v, i) => !v && isResolved(bets[i].status)).length;
  const counted = bets.filter((b, i) => shown[i] && b.mine.length > 0 && b.mine.every((m) => m.payout !== undefined));
  const net = counted.reduce(
    (a, b) => a + (b.status === "refunded" ? 0 : b.mine.reduce((x, m) => x + (m.payout ?? 0) - m.amount, 0)),
    0,
  );
  return (
    <Pressable
      disabled={settled === 0}
      onPress={onOpen}
      style={({ pressed }) => ({
        flexDirection: "row",
        alignItems: "center",
        gap: 12,
        paddingVertical: 12,
        paddingHorizontal: 14,
        borderRadius: 18,
        borderWidth: 1.5,
        borderColor: C.line,
        transform: [{ scale: pressed ? 0.98 : 1 }],
      })}
    >
      <Scorecard tiles={tiles} size={32} gap={5} />
      <View style={{ flex: 1, alignItems: "flex-end", gap: 1 }}>
        {counted.length > 0 ? (
          <NetText net={net} size={20} />
        ) : (
          <Text style={[{ fontFamily: F.monoBold, fontSize: 20, color: C.ink }, tnum]}>
            {settled}
            <Text style={{ color: C.faint }}>/{bets.length}</Text>
          </Text>
        )}
        <Text style={[s.label, { fontSize: 10, color: waiting > 0 ? "#9A6B12" : C.sub }]} numberOfLines={1}>
          {waiting > 0 ? "tap to reveal" : counted.length > 0 ? title + " so far" : "settled"}
        </Text>
      </View>
    </Pressable>
  );
}
