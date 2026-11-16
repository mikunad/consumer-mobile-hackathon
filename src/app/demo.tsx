import { useEffect, useRef, useState } from "react";
import { Platform, Pressable, ScrollView, Text, View, useWindowDimensions } from "react-native";
import { Stack as Screen } from "expo-router";
import { Id } from "@convex/_generated/dataModel";
import { BetItem, Bubble, Poll, Row, Stack, Who, stamp } from "@/components/chat/thread";
import { InvisibleInk } from "@/components/chat/ink";
import { I, t } from "@/components/chat/ios";
import { clock, fmt } from "@/lib/time";

// Hard-coded stage demo. No backend. Space or → steps forward, ← steps back, 1/2/3 switch who you're viewing as, H hides the controls.

type P = "mikun" | "febe" | "jill";
const PEOPLE: Record<P, { _id: P; name: string; emoji: string }> = {
  mikun: { _id: "mikun", name: "Mikun", emoji: "🦁" },
  febe: { _id: "febe", name: "Febe", emoji: "🦊" },
  jill: { _id: "jill", name: "Jill", emoji: "🌸" },
};
const ORDER: P[] = ["mikun", "febe", "jill"];
const AI: Who = { _id: "ai", name: "AI", emoji: "✦" };
const START = 1000;

type Bet = { id: string; by: P | "ai"; about: P; kind: BetItem["kind"]; q: string; options: string[] };
type Ev =
  | { k: "bet"; at: number; bet: Bet; side?: number; amt?: number }
  | { k: "stake"; at: number; bet: string; by: P; side: number; amt: number }
  | { k: "reveal"; at: number }
  | { k: "rub"; at: number }
  | { k: "call"; at: number; bet: string; win: number }
  | { k: "board"; at: number };

const ou = (line: number) => ["Over " + line, "Under " + line];
const B: Record<string, Bet> = {
  agentic: { id: "agentic", by: "febe", about: "mikun", kind: "overunder", q: "How many times does @Mikun say “agentic” on stage?", options: ou(3.5) },
  flight: { id: "flight", by: "jill", about: "febe", kind: "overunder", q: "How many times does @Febe check tonight's flight before we're off stage?", options: ou(6.5) },
  smelly: { id: "smelly", by: "mikun", about: "jill", kind: "overunder", q: "How many people does @Jill call smelly today?", options: ou(2.5) },
  laugh: { id: "laugh", by: "ai", about: "mikun", kind: "yesno", q: "Do the judges laugh before @Mikun hits the 1:00 mark?", options: ["Yes", "No"] },
};

// Minutes after 4:00 PM.
const SCRIPT: Ev[] = [
  { k: "bet", at: 41, bet: B.agentic, side: 0, amt: 100 },
  { k: "stake", at: 42, bet: "agentic", by: "jill", side: 1, amt: 250 },
  { k: "bet", at: 44, bet: B.flight, side: 0, amt: 100 },
  { k: "stake", at: 45, bet: "flight", by: "mikun", side: 1, amt: 150 },
  { k: "bet", at: 47, bet: B.smelly, side: 0, amt: 100 },
  { k: "stake", at: 48, bet: "smelly", by: "febe", side: 1, amt: 200 },
  { k: "bet", at: 51, bet: B.laugh },
  { k: "stake", at: 52, bet: "laugh", by: "febe", side: 0, amt: 100 },
  { k: "stake", at: 53, bet: "laugh", by: "jill", side: 1, amt: 50 },
  { k: "reveal", at: 60 },
  { k: "rub", at: 60 },
  { k: "call", at: 61, bet: "agentic", win: 0 },
  { k: "call", at: 61, bet: "flight", win: 0 },
  { k: "call", at: 62, bet: "smelly", win: 1 },
  { k: "call", at: 62, bet: "laugh", win: 0 },
  { k: "board", at: 63 },
];

function at(min: number) {
  const d = new Date();
  d.setHours(16, 0, 0, 0);
  return d.getTime() + min * 60 * 1000;
}
const REVEAL = at(60);

type Stake = { by: P; side: number; amt: number; payout?: number };
type Live = { bet: Bet; t: number; stakes: Stake[]; win?: number };
type Item =
  | { type: "bet"; t: number; id: string }
  | { type: "stake"; t: number; id: string; s: Stake }
  | { type: "settled"; t: number; id: string }
  | { type: "board"; t: number };

function play(step: number) {
  const bets = new Map<string, Live>();
  const items: Item[] = [];
  let revealed = false;
  let rubbed = false;
  let now = at(40);
  for (const ev of SCRIPT.slice(0, step)) {
    now = at(ev.at);
    if (ev.k === "bet") {
      const live: Live = { bet: ev.bet, t: now, stakes: [] };
      if (ev.amt && ev.bet.by !== "ai") live.stakes.push({ by: ev.bet.by, side: ev.side ?? 0, amt: ev.amt });
      bets.set(ev.bet.id, live);
      items.push({ type: "bet", t: now, id: ev.bet.id });
    } else if (ev.k === "stake") {
      const s = { by: ev.by, side: ev.side, amt: ev.amt };
      bets.get(ev.bet)!.stakes.push(s);
      items.push({ type: "stake", t: now, id: ev.bet, s });
    } else if (ev.k === "reveal") revealed = true;
    else if (ev.k === "rub") rubbed = true;
    else if (ev.k === "call") {
      const live = bets.get(ev.bet)!;
      live.win = ev.win;
      const total = live.stakes.reduce((n, s) => n + s.amt, 0);
      const winPool = live.stakes.filter((s) => s.side === ev.win).reduce((n, s) => n + s.amt, 0);
      for (const s of live.stakes) s.payout = s.side === ev.win && winPool ? Math.round((s.amt / winPool) * total) : 0;
      items.push({ type: "settled", t: now, id: ev.bet });
    } else items.push({ type: "board", t: now });
  }
  const points = (p: P) => START + [...bets.values()].flatMap((b) => b.stakes).filter((s) => s.by === p).reduce((n, s) => n - s.amt + (s.payout ?? 0), 0);
  return { bets, items, revealed, rubbed, now, points };
}

function betItem(live: Live, me: P): BetItem {
  const total = live.stakes.reduce((n, s) => n + s.amt, 0);
  const pools = live.bet.options.map((_, i) => live.stakes.filter((s) => s.side === i).reduce((n, s) => n + s.amt, 0));
  const mine = live.stakes.find((s) => s.by === me);
  return {
    type: "bet",
    _id: live.bet.id as Id<"bets">,
    t: live.t,
    question: live.bet.q,
    kind: live.bet.kind,
    options: live.bet.options,
    pools,
    pct: pools.map((p) => (total ? (p / total) * 100 : 100 / pools.length)),
    total,
    bettors: new Set(live.stakes.map((s) => s.by)).size,
    status: live.win === undefined ? "open" : "settled",
    winningOption: live.win,
    subject: PEOPLE[live.bet.about],
    author: live.bet.by === "ai" ? AI : PEOPLE[live.bet.by],
    ai: live.bet.by === "ai",
    aboutMe: live.bet.about === me,
    mine: mine ? { option: mine.side, amount: mine.amt, payout: mine.payout } : null,
    faces: live.stakes.map((s) => ({ emoji: PEOPLE[s.by].emoji, name: PEOPLE[s.by].name })),
  };
}

function Board({ points }: { points: (p: P) => number }) {
  const ranked = [...ORDER].sort((a, b) => points(b) - points(a));
  const medals = ["🥇", "🥈", "🥉"];
  return (
    <View style={{ alignSelf: "center", width: 270, backgroundColor: I.fill, borderRadius: 18, padding: 14, gap: 8, marginVertical: 10 }}>
      <Text style={[t(13, "600", I.secondary), { textAlign: "center" }]}>FINAL STANDINGS</Text>
      {ranked.map((p, i) => (
        <View key={p} style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
          <Text style={{ fontSize: 18 }}>{medals[i]}</Text>
          <Text style={{ fontSize: 18 }}>{PEOPLE[p].emoji}</Text>
          <Text style={[t(17, "600"), { flex: 1 }]}>{PEOPLE[p].name}</Text>
          <Text style={[t(17, "600", points(p) >= START ? I.green : I.red), { fontVariant: ["tabular-nums"] }]}>{fmt(points(p))}</Text>
        </View>
      ))}
      <Text style={[t(14, "500"), { textAlign: "center", marginTop: 4 }]}>🍻 {PEOPLE[ranked[ranked.length - 1]].name} buys the first round.</Text>
    </View>
  );
}

function Chat({ me, step }: { me: P; step: number }) {
  const { bets, items, revealed, rubbed, now, points } = play(step);
  const scroll = useRef<React.ComponentRef<typeof ScrollView>>(null);
  const ys = useRef(new Map<string, number>());
  const others = ORDER.filter((p) => p !== me);
  const aboutMe = [...bets.values()].filter((b) => b.bet.about === me);
  const friends = new Set(aboutMe.flatMap((b) => b.stakes.map((s) => s.by))).size;
  const riding = aboutMe.reduce((n, b) => n + b.stakes.reduce((m, s) => m + s.amt, 0), 0);
  // Stakes on a bet about you stay hidden until the reveal; the tapbacks on the ink show who's in.
  const shown = items.filter((it) => !(it.type === "stake" && !revealed && bets.get(it.id)!.bet.about === me));
  const firstInk = [...bets.values()].find((b) => b.bet.about === me)?.bet.id;
  // At the reveal, jump to the first bet about you so the room sees the ink dissolve.
  useEffect(() => {
    if (!revealed || !firstInk) return;
    const y = ys.current.get(firstInk);
    if (y !== undefined) setTimeout(() => scroll.current?.scrollTo({ y: Math.max(0, y - 60), animated: true }), 50);
  }, [revealed, rubbed, me, firstInk]);
  const senderOf = (it: Item): string => {
    if (it.type === "board") return "board";
    if (it.type === "stake") return it.s.by;
    const b = bets.get(it.id)!.bet;
    return it.type === "settled" ? b.about : b.by;
  };
  return (
    <View style={{ flex: 1, backgroundColor: I.bg }}>
      <View style={{ paddingTop: 14, paddingBottom: 8, backgroundColor: I.bar, borderBottomWidth: 0.5, borderBottomColor: I.sep }}>
        <View style={{ flexDirection: "row", alignItems: "center", paddingHorizontal: 8 }}>
          <View style={{ width: 70 }}>
            <Text style={t(30, "300", I.blue)}>‹</Text>
          </View>
          <View style={{ flex: 1, alignItems: "center", gap: 3 }}>
            <Stack faces={others.map((p) => PEOPLE[p].emoji)} size={40} />
            <Text numberOfLines={1} style={t(11, "400")}>
              Mikun, Febe & Jill <Text style={t(11, "400", I.secondary)}>›</Text>
            </Text>
          </View>
          <View style={{ width: 70, alignItems: "flex-end", paddingRight: 6 }}>
            <Text style={[t(15, "600"), { fontVariant: ["tabular-nums"] }]}>{fmt(points(me))}</Text>
            <Text style={t(10, "400", I.secondary)}>pts</Text>
          </View>
        </View>
      </View>
      <ScrollView
        ref={scroll}
        onContentSizeChange={() => {
          if (!revealed || items.some((i) => i.type === "settled")) scroll.current?.scrollToEnd({ animated: true });
        }}
        contentContainerStyle={{ paddingHorizontal: 12, paddingTop: 8, paddingBottom: 16, gap: 3 }}
      >
        <View style={{ alignItems: "center", paddingVertical: 8, gap: 2 }}>
          <Text style={[t(11, "600", revealed ? I.blue : I.secondary), { fontVariant: ["tabular-nums"] }]}>
            {revealed ? "The reveal is live. Rub the ink." : "Reveal at " + stamp(REVEAL) + " · " + clock(REVEAL - now)}
          </Text>
          <Text style={t(11, "400", I.secondary)}>Bets about you are hidden in invisible ink until then.</Text>
          {aboutMe.length > 0 && !revealed ? (
            <View style={{ marginTop: 6, backgroundColor: I.fill, borderRadius: 99, paddingHorizontal: 12, paddingVertical: 5 }}>
              <Text style={[t(12, "600"), { fontVariant: ["tabular-nums"] }]}>
                🔒 {aboutMe.length} bet{aboutMe.length === 1 ? "" : "s"} riding on you · {friends} friend{friends === 1 ? "" : "s"} · {fmt(riding)} pts
              </Text>
            </View>
          ) : null}
        </View>
        {shown.length === 0 ? <Text style={[t(13, "400", I.secondary), { textAlign: "center", marginTop: 30 }]}>No bets yet. The person a bet is about won't see it.</Text> : null}
        {shown.map((it, idx) => {
          const prev = shown[idx - 1];
          const next = shown[idx + 1];
          const sender = senderOf(it);
          const mine = sender === me;
          const showTime = !prev || it.t - prev.t > 10 * 60 * 1000;
          const showName = showTime || senderOf(prev) !== sender;
          const last = !next || senderOf(next) !== sender || next.t - it.t > 10 * 60 * 1000;
          const key = it.type + ":" + ("id" in it ? it.id : "") + ":" + idx;
          const time = showTime ? (
            <Text style={[t(11, "400", I.secondary), { textAlign: "center", marginVertical: 10 }]}>
              <Text style={t(11, "600", I.secondary)}>Today</Text> {stamp(it.t)}
            </Text>
          ) : null;
          const gap = !showTime && showName ? <View style={{ height: 8 }} /> : null;
          if (it.type === "board")
            return (
              <View key={key}>
                {time}
                <Board points={points} />
              </View>
            );
          const live = bets.get(it.id)!;
          const b = betItem(live, me);
          if (it.type === "bet") {
            const bubble = (
              <Bubble mine={mine} color={mine ? I.blue : I.gray} tail={last}>
                <Poll b={b} mine={mine} />
              </Bubble>
            );
            return (
              <View key={key} onLayout={(e) => ys.current.set(it.id, e.nativeEvent.layout.y)}>
                {time}
                {gap}
                <Row who={b.author} mine={mine} showName={showName} last={last} faces={b.faces}>
                  {b.aboutMe && b.status === "open" ? (
                    <InvisibleInk
                      key={revealed ? (rubbed ? "rubbed" : "rub") : "sealed"}
                      name={"@" + PEOPLE[me].name}
                      canRub={revealed}
                      uncovered={rubbed}
                      hint={revealed ? "" : "Unlocks at " + stamp(REVEAL) + " · " + (b.bettors === 1 ? "1 friend is in" : b.bettors + " friends are in")}
                    >
                      {bubble}
                    </InvisibleInk>
                  ) : (
                    bubble
                  )}
                </Row>
              </View>
            );
          }
          if (it.type === "stake")
            return (
              <View key={key}>
                {time}
                {gap}
                <Row who={PEOPLE[it.s.by]} mine={mine} showName={showName} last={last}>
                  <Bubble mine={mine} color={mine ? I.blue : I.gray} tail={last}>
                    <Text style={t(16, "400", mine ? "#fff" : I.label)}>
                      {fmt(it.s.amt)} on {live.bet.options[it.s.side]}{" "}
                      <Text style={t(13, "400", mine ? "rgba(255,255,255,0.75)" : I.secondary)}>· {live.bet.q.length > 34 ? live.bet.q.slice(0, 33) + "…" : live.bet.q}</Text>
                    </Text>
                  </Bubble>
                </Row>
              </View>
            );
          const winners = live.stakes.filter((s) => (s.payout ?? 0) > s.amt);
          return (
            <View key={key}>
              {time}
              {gap}
              <Row who={PEOPLE[live.bet.about]} mine={mine} showName={showName} last={last}>
                <Bubble mine={mine} color={mine ? I.blue : I.gray} tail={last}>
                  <Text style={t(16, "400", mine ? "#fff" : I.label)}>
                    It was {live.bet.options[live.win!]}. {live.bet.q}
                  </Text>
                  {winners.length ? (
                    <Text style={[t(14, "600", mine ? "rgba(255,255,255,0.9)" : I.green), { marginTop: 3, fontVariant: ["tabular-nums"] }]}>
                      {winners.map((s) => PEOPLE[s.by].emoji + " " + PEOPLE[s.by].name + " +" + fmt(s.payout! - s.amt)).join("   ")}
                    </Text>
                  ) : null}
                </Bubble>
              </Row>
            </View>
          );
        })}
      </ScrollView>
      <View style={{ backgroundColor: I.bar, borderTopWidth: 0.5, borderTopColor: I.sep, padding: 10, paddingBottom: 18, flexDirection: "row", gap: 8, alignItems: "center" }}>
        <View style={{ width: 34, height: 34, borderRadius: 17, backgroundColor: "#E3E3E8", alignItems: "center", justifyContent: "center" }}>
          <Text style={[t(22, "400", "#6E6E73"), { marginTop: -2 }]}>+</Text>
        </View>
        <View style={{ flex: 1, borderWidth: 1, borderColor: I.sep, borderRadius: 18, backgroundColor: "#fff", paddingHorizontal: 12, paddingVertical: 7 }}>
          <Text style={t(16, "400", I.secondary)}>{revealed ? "Betting's closed. Reveal time." : "Bet on someone…"}</Text>
        </View>
      </View>
    </View>
  );
}

export default function Demo() {
  const [step, setStep] = useState(0);
  const [me, setMe] = useState<P>("mikun");
  const [controls, setControls] = useState(true);
  const { width, height } = useWindowDimensions();
  useEffect(() => {
    if (Platform.OS !== "web") return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === " " || e.key === "ArrowRight" || e.key === "PageDown") setStep((s) => Math.min(SCRIPT.length, s + 1));
      else if (e.key === "ArrowLeft" || e.key === "PageUp") setStep((s) => Math.max(0, s - 1));
      else if (e.key === "1" || e.key === "2" || e.key === "3") setMe(ORDER[Number(e.key) - 1]);
      else if (e.key === "r" || e.key === "R") setStep(0);
      else if (e.key === "h" || e.key === "H") setControls((c) => !c);
      else return;
      e.preventDefault();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);
  const framed = width > 600;
  const phoneH = Math.min(844, height - 40);
  return (
    <View style={{ flex: 1, backgroundColor: framed ? "#1C1C1E" : I.bg, alignItems: "center", justifyContent: "center" }}>
      <Screen.Screen options={{ title: "Called It" }} />
      {controls ? (
        <View style={{ position: framed ? "absolute" : "relative", top: framed ? 20 : 0, left: framed ? 20 : 0, gap: 8, padding: framed ? 0 : 8, flexDirection: framed ? "column" : "row", flexWrap: "wrap", zIndex: 5 }}>
          <Text style={t(12, "600", framed ? "#8E8E93" : I.secondary)}>VIEWING AS</Text>
          {ORDER.map((p, i) => (
            <Pressable key={p} onPress={() => setMe(p)} style={{ paddingHorizontal: 12, paddingVertical: 6, borderRadius: 99, backgroundColor: me === p ? I.blue : framed ? "#2C2C2E" : I.fill }}>
              <Text style={t(14, "600", me === p ? "#fff" : framed ? "#fff" : I.label)}>
                {i + 1} · {PEOPLE[p].emoji} {PEOPLE[p].name}
              </Text>
            </Pressable>
          ))}
          <Text style={[t(12, "500", "#8E8E93"), { fontVariant: ["tabular-nums"] }]}>
            Step {step}/{SCRIPT.length}
          </Text>
          {framed ? <Text style={t(12, "400", "#636366")}>Space next · ← back{"\n"}R restart · H hide</Text> : null}
        </View>
      ) : null}
      <View
        style={
          framed
            ? { width: 390, height: phoneH, borderRadius: 48, overflow: "hidden", borderWidth: 10, borderColor: "#000", backgroundColor: I.bg }
            : { flex: 1, width: "100%" }
        }
      >
        <Chat me={me} step={step} />
      </View>
    </View>
  );
}
