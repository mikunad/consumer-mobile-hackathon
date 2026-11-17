import { Component, ReactNode, useEffect, useState } from "react";
import { Animated, Modal, Platform, Pressable, ScrollView, Text, View, useWindowDimensions } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import Svg, { Circle, Line, Path } from "react-native-svg";
import { useQuery } from "convex/react";
import * as Haptics from "expo-haptics";
import { FunctionReturnType } from "convex/server";
import { api } from "@convex/_generated/api";
import { Id } from "@convex/_generated/dataModel";
import { C, F, OPTION_COLORS, tnum } from "@/lib/theme";
import { fmt, hourLabel } from "@/lib/time";
import { s } from "./ui";
import {
  LETTER_AT,
  NetText,
  Scorecard,
  ShareButton,
  Tile,
  TileState,
  isResolved,
  markRevealed,
  shareText,
  signed,
  useRevealed,
} from "./scorecard";

type Results = NonNullable<FunctionReturnType<typeof api.reveal.dropResults>>;
type Bet = Results["bets"][number];
type Card = FunctionReturnType<typeof api.reveal.myScorecards>[number];

const native = Platform.OS !== "web";

class Safe extends Component<{ children: ReactNode; fallback?: ReactNode }, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError() {
    return { failed: true };
  }
  render() {
    return this.state.failed ? (this.props.fallback ?? null) : this.props.children;
  }
}

function maskTiles(tiles: { betId: string; status: string; tile: TileState }[], revealed: Set<string> | null): TileState[] {
  return tiles.map((t) => (isResolved(t.status) && !revealed?.has(t.betId) ? "hidden" : t.tile));
}

function unrevealedIn(card: Card, revealed: Set<string>) {
  return card.tiles.filter((t) => isResolved(t.status) && !revealed.has(t.betId)).length;
}

export function RevealStory({ token, roundId, onClose }: { token: string; roundId: Id<"rounds">; onClose: () => void }) {
  return (
    <Modal visible animationType="fade" onRequestClose={onClose} statusBarTranslucent>
      <Safe fallback={<StoryMessage text="Results aren't available yet." onClose={onClose} />}>
        <Story token={token} roundId={roundId} onClose={onClose} />
      </Safe>
    </Modal>
  );
}

function Story({ token, roundId, onClose }: { token: string; roundId: Id<"rounds">; onClose: () => void }) {
  const data = useQuery(api.reveal.dropResults, { token, roundId });
  const revealed = useRevealed();
  if (data === null) return <StoryMessage text="That drop is gone." onClose={onClose} />;
  if (data === undefined || revealed === null) return <StoryMessage text="Tallying the room…" onClose={onClose} loading />;
  return <StoryView data={data} revealed={revealed} onClose={onClose} />;
}

function StoryMessage({ text, onClose, loading }: { text: string; onClose: () => void; loading?: boolean }) {
  return (
    <Pressable onPress={onClose} style={[s.screen, { alignItems: "center", justifyContent: "center", gap: 22 }]}>
      <Scorecard tiles={[]} from="hidden" size={34} />
      <Text style={[s.sub, { fontFamily: F.bodyMed, fontSize: 15 }]}>{text}</Text>
      {loading ? null : <Text style={[s.label, { color: C.faint }]}>tap to close</Text>}
    </Pressable>
  );
}

export function StoryView({ data, revealed, onClose }: { data: Results; revealed: Set<string>; onClose: () => void }) {
  const insets = useSafeAreaInsets();
  const [steps] = useState(() => data.bets.filter((b) => isResolved(b.status)).map((b) => b._id));
  const [i, setI] = useState(() => Math.max(0, steps.findIndex((id) => !revealed.has(id))));
  const [flipped, setFlipped] = useState(false);
  const n = steps.length;
  const bet = i < n ? data.bets.find((b) => b._id === steps[i]) ?? null : null;
  const [prog] = useState(() => new Animated.Value(0));
  const [tint] = useState(() => new Animated.Value(0));

  useEffect(() => {
    prog.setValue(flipped ? 0.5 : 0);
    Animated.timing(prog, { toValue: bet && !flipped ? 0.5 : 1, duration: 380, useNativeDriver: false }).start();
    Animated.timing(tint, { toValue: flipped ? 1 : 0, duration: flipped ? 420 : 160, useNativeDriver: false }).start();
  }, [i, flipped, bet, prog, tint]);

  const forward = () => {
    if (bet && !flipped) {
      setFlipped(true);
      markRevealed([bet._id]);
      if (native)
        Haptics.notificationAsync(
          bet.tile === "won"
            ? Haptics.NotificationFeedbackType.Success
            : bet.tile === "lost"
              ? Haptics.NotificationFeedbackType.Error
              : Haptics.NotificationFeedbackType.Warning,
        );
      return;
    }
    if (i >= n) return;
    if (i + 1 === n) markRevealed(steps);
    setI(i + 1);
    setFlipped(false);
  };
  const back = () => {
    if (flipped) return setFlipped(false);
    if (i === 0) return;
    setI(i - 1);
    setFlipped(true);
  };

  const winner = bet && bet.status === "settled" && bet.winningOption !== undefined ? OPTION_COLORS[bet.winningOption % 4] : null;

  return (
    <View style={[s.screen, { paddingTop: insets.top + 10, paddingBottom: insets.bottom + 16 }]}>
      <Animated.View
        pointerEvents="none"
        style={{ position: "absolute", top: 0, left: 0, right: 0, bottom: 0, backgroundColor: winner?.bg ?? C.tile, opacity: tint }}
      />
      <View style={[s.column, { flex: 1, maxWidth: 480 }]}>
        <View style={{ flexDirection: "row", gap: 4 }}>
          {[...steps, "card"].map((id, k) => (
            <View key={id} style={{ flex: 1, height: 4, borderRadius: 2, backgroundColor: "rgba(30,28,25,0.12)", overflow: "hidden" }}>
              {k < i ? (
                <View style={{ flex: 1, backgroundColor: C.ink }} />
              ) : k === i ? (
                <Animated.View
                  style={{ height: 4, backgroundColor: C.ink, width: prog.interpolate({ inputRange: [0, 1], outputRange: ["0%", "100%"] }) }}
                />
              ) : null}
            </View>
          ))}
        </View>
        <View style={{ flexDirection: "row", alignItems: "center", marginTop: 12, marginBottom: 8 }}>
          <Text style={[s.label, { color: C.ink, letterSpacing: 1.4 }]}>
            {data.round.title} · {bet ? "results" : "your card"}
          </Text>
          <View style={{ flex: 1 }} />
          {bet ? (
            <Text style={[s.label, tnum, { marginRight: 12 }]}>
              {i + 1} / {n}
            </Text>
          ) : null}
          <Pressable onPress={onClose} hitSlop={12} style={{ width: 32, height: 32, alignItems: "center", justifyContent: "center" }}>
            <Svg width={14} height={14} viewBox="0 0 14 14">
              <Path d="M1 1l12 12M13 1L1 13" stroke={C.ink} strokeWidth={2.2} strokeLinecap="round" />
            </Svg>
          </Pressable>
        </View>
        {bet ? (
          <View style={{ flex: 1 }}>
            <BetScreen key={bet._id} bet={bet} slot={data.bets.indexOf(bet)} flipped={flipped} start={data.round.opensAt} end={data.endsAt} />
            <View style={{ position: "absolute", top: 0, bottom: 0, left: 0, right: 0, flexDirection: "row" }}>
              <Pressable onPress={back} style={{ flex: 3 }} />
              <Pressable onPress={forward} style={{ flex: 7 }} />
            </View>
            <Text style={[s.label, { textAlign: "center", color: flipped ? C.sub : C.ink }]}>
              {!flipped ? "Tap to see what happened" : i + 1 === n ? "Tap for your card" : "Tap for the next one"}
            </Text>
          </View>
        ) : (
          <FinalCard data={data} onBack={n > 0 ? back : undefined} onClose={onClose} />
        )}
      </View>
    </View>
  );
}

function useEnter(on: boolean) {
  const [v] = useState(() => new Animated.Value(on ? 1 : 0));
  useEffect(() => {
    v.setValue(0);
    Animated.spring(v, { toValue: 1, useNativeDriver: native, friction: 7, tension: 70 }).start();
  }, [on, v]);
  return {
    opacity: v,
    transform: [{ translateY: v.interpolate({ inputRange: [0, 1], outputRange: [18, 0] }) }],
  };
}

function BetScreen({ bet, slot, flipped, start, end }: { bet: Bet; slot: number; flipped: boolean; start: number; end: number }) {
  const enter = useEnter(flipped);
  const letter = LETTER_AT[slot] ?? String(slot + 1);
  return (
    <View style={{ flex: 1, paddingTop: 18, gap: 18 }}>
      <View style={{ flexDirection: "row", alignItems: "center", gap: 14 }}>
        <Tile letter={letter} state={flipped ? bet.tile : "hidden"} size={52} />
        <Text style={[s.label, { flex: 1, lineHeight: 16 }]}>
          {bet.kind === "yesno" ? "Yes or no" : bet.kind === "overunder" ? "Over or under" : "Pick one"} {"\n"}
          <Text style={{ color: C.ink }}>{bet.bettors} {bet.bettors === 1 ? "player" : "players"} · {fmt(bet.total)} pts</Text>
        </Text>
      </View>
      <Text style={[s.h1, flipped ? { fontSize: 19, lineHeight: 25, fontFamily: F.displaySemi, color: C.sub } : { fontSize: 34, lineHeight: 40 }]}>
        {bet.question}
      </Text>
      <Animated.View style={[{ gap: 18 }, enter]}>{flipped ? <Outcome bet={bet} /> : <RoomOdds bet={bet} start={start} end={end} />}</Animated.View>
    </View>
  );
}

function RoomOdds({ bet, start, end }: { bet: Bet; start: number; end: number }) {
  const { width } = useWindowDimensions();
  const lead = bet.pct.indexOf(Math.max(...bet.pct));
  const col = OPTION_COLORS[lead % 4];
  const chartW = Math.min(width, 480) - 32;
  return (
    <>
      {bet.total === 0 ? (
        <Text style={{ fontFamily: F.displaySemi, fontSize: 26, color: C.sub }}>Nobody put points on this one.</Text>
      ) : (
        <View style={{ flexDirection: "row", alignItems: "baseline", gap: 10 }}>
          <Text style={[{ fontFamily: F.monoBold, fontSize: 64, color: col.fg, letterSpacing: -3, lineHeight: 70 }, tnum]}>
            {Math.round(bet.pct[lead])}%
          </Text>
          <Text style={{ fontFamily: F.displaySemi, fontSize: 24, color: C.ink, flexShrink: 1 }}>
            said <Text style={{ color: col.fg, textTransform: "uppercase" }}>{bet.options[lead]}</Text>
          </Text>
        </View>
      )}
      <View style={{ gap: 8 }}>
        <View style={{ flexDirection: "row", height: 14, borderRadius: 4, overflow: "hidden", gap: 2 }}>
          {bet.options.map((_, k) => (
            <View key={k} style={{ flex: Math.max(bet.pct[k], 0.5), backgroundColor: bet.total === 0 ? C.line : OPTION_COLORS[k % 4].fg }} />
          ))}
        </View>
        <View style={{ flexDirection: "row", justifyContent: "space-between", flexWrap: "wrap", gap: 6 }}>
          {bet.options.map((o, k) => (
            <Text key={k} style={[{ fontFamily: F.mono, fontSize: 13, color: OPTION_COLORS[k % 4].fg }, tnum]}>
              {o.toUpperCase()} {Math.round(bet.pct[k])}%
            </Text>
          ))}
        </View>
      </View>
      <OddsChart ticks={bet.ticks} index={lead} options={bet.options.length} start={start} end={end} color={col.fg} soft={col.bg} width={chartW} />
      <MyPick bet={bet} />
    </>
  );
}

function MyPick({ bet }: { bet: Bet }) {
  if (!bet.mine) return <Text style={[s.sub, { fontSize: 15 }]}>You didn&apos;t call this one.</Text>;
  const col = OPTION_COLORS[bet.mine.option % 4];
  return (
    <View style={{ flexDirection: "row", alignItems: "center", gap: 10 }}>
      <Text style={s.label}>Your call</Text>
      <View style={{ backgroundColor: col.fg, borderRadius: 8, paddingHorizontal: 10, paddingVertical: 5 }}>
        <Text style={{ fontFamily: F.bodyBold, color: "#fff", fontSize: 14, textTransform: "uppercase" }}>{bet.options[bet.mine.option]}</Text>
      </View>
      <Text style={[{ fontFamily: F.mono, fontSize: 14, color: C.ink }, tnum]}>{fmt(bet.mine.amount)} pts</Text>
    </View>
  );
}

function OddsChart({
  ticks,
  index,
  options,
  start,
  end,
  color,
  soft,
  width,
  height = 96,
}: {
  ticks: { t: number; pct: number[] }[];
  index: number;
  options: number;
  start: number;
  end: number;
  color: string;
  soft: string;
  width: number;
  height?: number;
}) {
  const last = ticks.length ? ticks[ticks.length - 1].t : end;
  const stop = Math.max(end, last);
  const span = Math.max(1, stop - start);
  const x = (t: number) => ((Math.min(Math.max(t, start), stop) - start) / span) * width;
  const y = (p: number) => 6 + (1 - p / 100) * (height - 12);
  let cur = 100 / options;
  const pts: [number, number][] = [[0, y(cur)]];
  for (const t of ticks) {
    pts.push([x(t.t), y(cur)]);
    cur = t.pct[index];
    pts.push([x(t.t), y(cur)]);
  }
  pts.push([width, y(cur)]);
  const line = pts.map(([a, b], k) => (k ? "L" : "M") + a.toFixed(1) + " " + b.toFixed(1)).join(" ");
  return (
    <View style={{ gap: 6 }}>
      <Svg width={width} height={height}>
        <Path d={line + " L" + width + " " + height + " L0 " + height + " Z"} fill={soft} />
        <Line x1={0} x2={width} y1={y(50)} y2={y(50)} stroke={C.faint} strokeDasharray="3,5" strokeWidth={1} />
        <Path d={line} fill="none" stroke={color} strokeWidth={2.5} strokeLinejoin="round" />
        <Circle cx={width - 4} cy={y(cur)} r={4} fill={color} />
      </Svg>
      <View style={{ flexDirection: "row", justifyContent: "space-between" }}>
        <Text style={[s.label, tnum, { fontSize: 10 }]}>Opened {hourLabel(start)}</Text>
        <Text style={[s.label, tnum, { fontSize: 10 }]}>{ticks.length} {ticks.length === 1 ? "bet" : "bets"} placed · closed {hourLabel(stop)}</Text>
      </View>
    </View>
  );
}

function Outcome({ bet }: { bet: Bet }) {
  const refunded = bet.status === "refunded";
  const w = bet.winningOption ?? 0;
  const col = OPTION_COLORS[w % 4];
  const word = refunded ? "Void" : bet.options[w];
  const size = Math.min(92, 300 / Math.max(3, word.length * 0.62));
  const winPct = Math.round(bet.pct[w] ?? 0);
  return (
    <>
      <View>
        <Text style={s.label}>What happened</Text>
        <Text numberOfLines={1} style={{ fontFamily: F.display, fontSize: size, lineHeight: size * 1.1, color: refunded ? C.sub : col.fg, textTransform: "uppercase", letterSpacing: -1 }}>
          {word}
        </Text>
        <Text style={[s.body, tnum, { fontFamily: F.bodyMed, color: C.ink }]}>
          {refunded
            ? "Refunded. Everyone got their points back."
            : bet.total === 0
              ? "Nobody saw it coming."
              : winPct < 50
                ? "Upset. Only " + winPct + "% of the room saw it coming."
                : winPct + "% of the room called it."}
        </Text>
      </View>
      <View style={{ flexDirection: "row", alignItems: "center", borderTopWidth: 1.5, borderBottomWidth: 1.5, borderColor: "rgba(30,28,25,0.12)", paddingVertical: 14 }}>
        <View style={{ flex: 1, gap: 2 }}>
          <Text style={s.label}>You</Text>
          <Text style={[{ fontFamily: F.bodyBold, fontSize: 16, color: C.ink }, tnum]}>
            {bet.mine ? fmt(bet.mine.amount) + " on " + bet.options[bet.mine.option] : "Skipped"}
          </Text>
        </View>
        {bet.mine && bet.net !== null ? (
          <Text style={[{ fontFamily: F.monoBold, fontSize: 40, letterSpacing: -2, color: bet.net > 0 ? C.yes : bet.net < 0 ? C.no : C.sub }, tnum]}>
            {refunded ? "±0" : signed(bet.net)}
          </Text>
        ) : (
          <Text style={{ fontFamily: F.monoBold, fontSize: 28, color: C.faint }}>—</Text>
        )}
      </View>
      {refunded ? null : <CalledIt bet={bet} color={col.fg} />}
    </>
  );
}

function CalledIt({ bet, color }: { bet: Bet; color: string }) {
  if (bet.winnerCount === 0) return <Text style={[s.sub, { fontSize: 15 }]}>Nobody called it.</Text>;
  const shown = bet.winners.slice(0, 5);
  const more = bet.winnerCount - shown.length;
  const label = bet.tile !== "won" ? "Called it" : bet.winnerCount === 1 ? "Only you called it" : "You and " + (bet.winnerCount - 1) + " more called it";
  return (
    <View style={{ gap: 10 }}>
      <Text style={s.label}>{label}</Text>
      <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 6 }}>
        {shown.map((w, k) => (
          <View
            key={k}
            style={{
              flexDirection: "row",
              alignItems: "center",
              gap: 5,
              paddingVertical: 6,
              paddingHorizontal: 10,
              borderRadius: 999,
              backgroundColor: w.me ? color : C.card,
            }}
          >
            <Text style={{ fontSize: 16 }}>{w.emoji}</Text>
            <Text style={{ fontFamily: F.bodyBold, fontSize: 14, color: w.me ? "#fff" : C.ink }}>{w.me ? "You" : "@" + w.name}</Text>
          </View>
        ))}
        {more > 0 ? (
          <View style={{ paddingVertical: 6, paddingHorizontal: 10, borderRadius: 999, borderWidth: 1.5, borderColor: "rgba(30,28,25,0.15)" }}>
            <Text style={[{ fontFamily: F.monoBold, fontSize: 14, color: C.ink }, tnum]}>+{more}</Text>
          </View>
        ) : null}
      </View>
    </View>
  );
}

function headline(tiles: TileState[]) {
  const played = tiles.filter((t) => t === "won" || t === "lost").length;
  const won = tiles.filter((t) => t === "won").length;
  if (played === 0) return "You sat this one out.";
  if (won === played && played >= 3) return "Perfect drop.";
  if (won === played) return "Clean sweep.";
  if (won === 0) return "The room got you.";
  if (won * 2 >= played) return "You called it.";
  return "Tough drop.";
}

function FinalCard({ data, onBack, onClose }: { data: Results; onBack?: () => void; onClose: () => void }) {
  const tiles = data.bets.map((b) => b.tile);
  const played = tiles.filter((t) => t === "won" || t === "lost").length;
  const won = tiles.filter((t) => t === "won").length;
  const enter = useEnter(true);
  const text = shareText(data.round.title, tiles, data.net);
  return (
    <ScrollView contentContainerStyle={{ flexGrow: 1, justifyContent: "center", gap: 26, paddingVertical: 16 }}>
      <Animated.View style={[{ gap: 6 }, enter]}>
        <Text style={[s.label, { color: C.flame }]}>
          {data.round.title} · {hourLabel(data.round.opensAt)}
        </Text>
        <Text style={[s.h1, { fontSize: 44, lineHeight: 48, letterSpacing: -1 }]}>{headline(tiles)}</Text>
      </Animated.View>
      <View style={{ alignItems: "center" }}>
        <Scorecard tiles={tiles} size={50} gap={7} stagger={260} from="hidden" />
      </View>
      <View style={{ flexDirection: "row", borderTopWidth: 1.5, borderBottomWidth: 1.5, borderColor: C.line }}>
        <Stat label="drop total" value={<NetText net={data.net} size={34} played={played > 0} />} />
        <View style={{ width: 1.5, backgroundColor: C.line }} />
        <Stat
          label="called"
          value={
            <Text style={[{ fontFamily: F.monoBold, fontSize: 34, color: C.ink, letterSpacing: -1 }, tnum]}>
              {won}
              <Text style={{ color: C.faint }}>/{played}</Text>
            </Text>
          }
        />
      </View>
      <View style={{ backgroundColor: C.card, borderRadius: 14, borderWidth: 1.5, borderColor: C.line, padding: 14 }}>
        <Text style={[{ fontFamily: F.mono, fontSize: 13, color: C.ink, lineHeight: 20 }, tnum]}>{text.split("\n")[0]}</Text>
      </View>
      <View style={{ gap: 10 }}>
        <ShareButton text={text} />
        <View style={{ flexDirection: "row", gap: 10 }}>
          {onBack ? (
            <Pressable onPress={onBack} style={{ flex: 1, paddingVertical: 14, alignItems: "center", borderRadius: 14, borderWidth: 1.5, borderColor: C.line }}>
              <Text style={{ fontFamily: F.bodyBold, fontSize: 15, color: C.ink }}>Back</Text>
            </Pressable>
          ) : null}
          <Pressable onPress={onClose} style={{ flex: 1, paddingVertical: 14, alignItems: "center", borderRadius: 14, borderWidth: 1.5, borderColor: C.line }}>
            <Text style={{ fontFamily: F.bodyBold, fontSize: 15, color: C.ink }}>Done</Text>
          </Pressable>
        </View>
      </View>
    </ScrollView>
  );
}

function Stat({ label, value }: { label: string; value: ReactNode }) {
  return (
    <View style={{ flex: 1, alignItems: "center", paddingVertical: 14, gap: 2 }}>
      {value}
      <Text style={s.label}>{label}</Text>
    </View>
  );
}

export function RevealBanner({ token, onOpen }: { token: string; onOpen: (roundId: Id<"rounds">) => void }) {
  return (
    <Safe>
      <Banner token={token} onOpen={onOpen} />
    </Safe>
  );
}

function Banner({ token, onOpen }: { token: string; onOpen: (roundId: Id<"rounds">) => void }) {
  const cards = useQuery(api.reveal.myScorecards, { token });
  const revealed = useRevealed();
  if (!cards || !revealed) return null;
  const card = [...cards].reverse().find((c) => unrevealedIn(c, revealed) > 0);
  if (!card) return null;
  const fresh = unrevealedIn(card, revealed);
  return (
    <Pressable
      onPress={() => onOpen(card.roundId)}
      style={({ pressed }) => ({
        backgroundColor: C.ink,
        borderRadius: 22,
        padding: 20,
        gap: 16,
        transform: [{ scale: pressed ? 0.98 : 1 }],
      })}
    >
      <Scorecard tiles={maskTiles(card.tiles, revealed)} size={38} gap={6} dark />
      <View style={{ gap: 4 }}>
        <Text style={[s.label, { color: C.gold, letterSpacing: 1.4 }]}>
          {fresh} {fresh === 1 ? "result" : "results"} waiting
        </Text>
        <Text style={{ fontFamily: F.display, fontSize: 32, lineHeight: 36, color: "#fff", letterSpacing: -0.5 }}>
          {card.title} results are in.
        </Text>
      </View>
      <View style={{ flexDirection: "row", alignItems: "center", justifyContent: "space-between" }}>
        <Text style={[s.sub, { color: "#A8A195", flex: 1 }]}>See what the room called, one bet at a time.</Text>
        <View style={{ backgroundColor: C.gold, borderRadius: 12, paddingVertical: 10, paddingHorizontal: 16 }}>
          <Text style={{ fontFamily: F.bodyBold, fontSize: 15, color: C.ink }}>Tap to reveal</Text>
        </View>
      </View>
    </Pressable>
  );
}

export function DropScorecards({ token }: { token: string }) {
  return (
    <Safe>
      <Cards token={token} />
    </Safe>
  );
}

function Cards({ token }: { token: string }) {
  const cards = useQuery(api.reveal.myScorecards, { token });
  const revealed = useRevealed();
  const [story, setStory] = useState<Id<"rounds"> | null>(null);
  if (!cards || !revealed) return null;
  const played = cards.filter((c) => c.played);
  return (
    <View style={{ gap: 10 }}>
      {played.length === 0 ? <Text style={s.sub}>Your drop cards show up here once you call something.</Text> : null}
      {played.map((c) => {
        const tiles = maskTiles(c.tiles, revealed);
        const pending = unrevealedIn(c, revealed) > 0;
        const won = tiles.filter((t) => t === "won").length;
        const decided = tiles.filter((t) => t === "won" || t === "lost").length;
        const settled = c.tiles.filter((t) => isResolved(t.status)).length;
        return (
          <View key={c.roundId} style={{ borderRadius: 18, borderWidth: 1.5, borderColor: C.line, padding: 14, gap: 12 }}>
            <View style={{ flexDirection: "row", alignItems: "baseline", gap: 8 }}>
              <Text style={{ fontFamily: F.displaySemi, fontSize: 18, color: C.ink }}>{c.title}</Text>
              {c.group ? <Text style={[s.label, { color: C.ink }]}>{c.group}</Text> : null}
              <Text style={[s.label, tnum]}>{hourLabel(c.opensAt)}</Text>
              <View style={{ flex: 1 }} />
              {pending ? null : <NetText net={c.net} size={18} />}
            </View>
            <View style={{ flexDirection: "row", alignItems: "center", gap: 12 }}>
              <Scorecard tiles={tiles} size={34} gap={5} />
              <View style={{ flex: 1 }} />
              {pending ? (
                <Pressable onPress={() => setStory(c.roundId)} style={{ backgroundColor: C.gold, borderRadius: 10, paddingVertical: 7, paddingHorizontal: 11 }}>
                  <Text style={{ fontFamily: F.bodyBold, fontSize: 13, color: C.ink }}>Reveal</Text>
                </Pressable>
              ) : settled > 0 ? (
                <ShareButton text={shareText(c.title, tiles, c.net)} label="Copy" dark={false} small />
              ) : null}
            </View>
            <Text style={[s.sub, tnum]}>
              {pending
                ? "Results are in. Reveal them first."
                : settled === 0
                  ? "Waiting on results"
                  : won + " of " + decided + " called" + (settled < c.tiles.length ? " · " + (c.tiles.length - settled) + " still open" : "")}
            </Text>
            {pending ? null : (
              <Pressable onPress={() => setStory(c.roundId)} style={{ position: "absolute", top: 0, left: 0, right: 110, bottom: 0 }} />
            )}
          </View>
        );
      })}
      {story ? <RevealStory token={token} roundId={story} onClose={() => setStory(null)} /> : null}
    </View>
  );
}
