import { ReactNode } from "react";
import { LiveCounter } from "@/components/live-counter";
import { Pressable, ScrollView, Text, View } from "react-native";
import { useQueries, useQuery } from "convex/react";
import { router, useLocalSearchParams } from "expo-router";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { api } from "@convex/_generated/api";
import { Id } from "@convex/_generated/dataModel";
import { useIdentity } from "@/lib/identity";
import { C, F, OPTION_COLORS, tnum } from "@/lib/theme";
import { fmt, hourLabel, useNow, useQueryNow } from "@/lib/time";
import { multiplier } from "@/lib/odds";
import {
  Market,
  PositionBand,
  StakePanel,
  Staker,
  StatusTag,
  SubjectLine,
  kindLabel,
  leadOf,
  myPosition,
  sinceDrop,
} from "@/components/market-card";
import { Delta, Faces, LateTag, MarketChart, TickingNumber, s } from "@/components/ui";

type Detail = {
  bet: Market;
  round: { title: string; number: number; opensAt: number };
  endsAt: number;
  position: number;
  count: number;
  sides?: Staker[][];
  mult: number;
  points: number;
  joined: boolean;
};

const HOUR = 60 * 60 * 1000;

export default function BetPage() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const betId = id as Id<"bets">;
  const insets = useSafeAreaInsets();
  const { token } = useIdentity();
  const qnow = useQueryNow();
  const now = useNow();
  const res = useQueries({
    m: { query: api.market.market, args: token ? { betId, token, now: qnow } : { betId, now: qnow } },
  }).m as Omit<Detail, "joined"> & { joined: boolean } | null | undefined | Error;
  const failed = res instanceof Error;
  const today = useQuery(api.game.today, failed ? { token: token ?? undefined, now: qnow } : "skip");
  const me = useQuery(api.users.me, failed ? { token: token ?? undefined } : "skip");

  let d: Detail | null | undefined;
  if (!failed) d = res;
  else if (today) {
    const i = today.bets.findIndex((b) => b._id === betId);
    d =
      i < 0 || !today.round
        ? null
        : {
            bet: today.bets[i],
            round: today.round,
            endsAt: today.next?.opensAt ?? today.round.opensAt + HOUR,
            position: i + 1,
            count: today.bets.length,
            mult: multiplier(today.streak.next),
            points: me?.points ?? 0,
            joined: !!me,
          };
  }

  const back = () => (router.canGoBack() ? router.back() : router.replace("/hackathon"));

  return (
    <View style={s.screen}>
      <ScrollView contentContainerStyle={[s.column, { paddingTop: insets.top + 10, paddingBottom: insets.bottom + 48, gap: 18 }]}>
        <View style={{ flexDirection: "row", alignItems: "center", justifyContent: "space-between" }}>
          <Pressable onPress={back} hitSlop={12} style={({ pressed }) => ({ opacity: pressed ? 0.5 : 1, flexDirection: "row", alignItems: "center", gap: 6 })}>
            <Text style={{ fontFamily: F.bodyBold, fontSize: 18, color: C.ink }}>←</Text>
            <Text style={[s.label, { color: C.ink }]}>Today</Text>
          </Pressable>
          {d ? (
            <Text style={[s.label, tnum]}>
              {d.round.title} · {d.position} of {d.count}
            </Text>
          ) : null}
        </View>
        {d === undefined ? <Text style={[s.sub, { color: C.faint }]}>Loading…</Text> : null}
        {d === null ? <Text style={s.body}>This market isn&apos;t around anymore.</Text> : null}
        {d ? <Body d={d} token={token} now={now} /> : null}
      </ScrollView>
    </View>
  );
}

function Body({ d, token, now }: { d: Detail; token: string | null; now: number }) {
  const m = d.bet;
  const settled = m.status === "settled" || m.status === "refunded";
  const closed = m.locked || settled;
  const lead = leadOf(m);
  const leadCol = OPTION_COLORS[lead % 4];
  const pos = myPosition(m);
  const sides = d.sides;
  const everyone = (sides ?? []).flat();
  const backer = everyone.reduce<Staker | null>((a, p) => (!a || p.amount > a.amount ? p : a), null);
  const backerSide = backer && sides ? sides.findIndex((side) => side.includes(backer)) : -1;
  const ctx = {
    token: d.joined ? token : null,
    points: d.points,
    mult: d.mult,
    roundStart: d.round.opensAt,
    roundLock: d.endsAt,
    now,
    late: now - d.round.opensAt > 10 * 60 * 1000,
  };
  const colors = m.options.map((_, i) => OPTION_COLORS[i % 4].fg);
  const crowd = sides ? sides.map((side, i) => ({ side, i })).sort((a, b) => b.side.length - a.side.length)[0] : undefined;

  return (
    <>
      <View style={{ gap: 10 }}>
        <View style={{ flexDirection: "row", alignItems: "center", gap: 10 }}>
          <Text style={s.label}>{kindLabel(m.kind)}</Text>
          <StatusTag m={m} />
        </View>
        <SubjectLine subject={m.subject} />
        <Text style={[s.h1, { fontSize: 32, lineHeight: 36 }]}>{m.question}</Text>
        {everyone.length ? (
          <View style={{ flexDirection: "row", alignItems: "center", gap: 10 }}>
            <Faces people={everyone} size={28} max={6} ring={C.paper} bg={C.card} />
            <Text style={[s.sub, { flex: 1, color: C.ink }]} numberOfLines={2}>
              <Text style={{ fontFamily: F.bodyBold }}>{everyone.length} {everyone.length === 1 ? "friend" : "friends"} in</Text>
              {crowd && crowd.side.length ? " · most called " + m.options[crowd.i].toUpperCase() : ""}
            </Text>
          </View>
        ) : sides ? (
          <Text style={s.sub}>Nobody&apos;s in yet. First call sets the odds.</Text>
        ) : null}
      </View>

      {m.counter !== undefined && m.line !== undefined ? <LiveCounter count={m.counter} line={m.line} settled={settled} /> : null}
      <View style={{ gap: 6 }}>
        <View style={{ flexDirection: "row", alignItems: "flex-end", gap: 12 }}>
          {settled ? (
            <Text style={{ fontFamily: F.display, fontSize: 60, lineHeight: 64, letterSpacing: -2, color: m.status === "refunded" ? C.sub : leadCol.fg, textTransform: "uppercase" }}>
              {m.status === "refunded" ? "Void" : m.options[lead]}
            </Text>
          ) : (
            <View style={{ flexDirection: "row", alignItems: "flex-start" }}>
              <TickingNumber value={m.pct[lead]} style={{ fontFamily: F.monoBold, fontSize: 68, lineHeight: 70, letterSpacing: -3.5, color: m.locked ? C.ink2 : leadCol.fg }} />
              <Text style={{ fontFamily: F.monoBold, fontSize: 26, marginTop: 6, color: m.locked ? C.ink2 : leadCol.fg }}>%</Text>
            </View>
          )}
          <View style={{ flex: 1, paddingBottom: 8, gap: 3 }}>
            <Text style={[s.label, { color: C.ink }]}>{settled ? "the result" : m.options[lead] + " chance"}</Text>
            {settled ? null : <Delta value={sinceDrop(m, lead)} suffix="since drop" />}
          </View>
          <View style={{ alignItems: "flex-end", paddingBottom: 8, gap: 1 }}>
            <Text style={[{ fontFamily: F.monoBold, fontSize: 18, color: C.ink }, tnum]}>{fmt(m.total)}</Text>
            <Text style={[s.label, { fontSize: 9.5 }]}>pts volume</Text>
          </View>
        </View>
        <MarketChart
          ticks={m.ticks}
          start={d.round.opensAt}
          end={d.endsAt}
          now={now}
          colors={colors}
          focus={lead}
          all
          height={200}
          startLabel={"dropped " + hourLabel(d.round.opensAt)}
          endLabel={(closed ? "closed " : "closes ") + hourLabel(d.endsAt)}
        />
        <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 14 }}>
          {m.options.map((o, i) => (
            <View key={i} style={{ flexDirection: "row", alignItems: "center", gap: 6 }}>
              <View style={{ width: 10, height: 10, borderRadius: 2, backgroundColor: colors[i] }} />
              <Text style={[{ fontFamily: F.bodyBold, fontSize: 12, color: C.ink, letterSpacing: 0.6, textTransform: "uppercase" }]}>{o}</Text>
              <Text style={[{ fontFamily: F.mono, fontSize: 12, color: C.sub }, tnum]}>{Math.round(m.pct[i])}%</Text>
              <Delta value={sinceDrop(m, i)} size={11} />
            </View>
          ))}
        </View>
      </View>

      <Section title={closed ? "Your call" : pos.staked ? "Add to your call" : "Make the call"}>
        {pos.staked > 0 || closed ? <PositionBand m={m} mult={d.mult} /> : null}
        {!closed ? (
          d.joined ? (
            <StakePanel key={m._id + ":" + (pos.option ?? lead)} m={m} ctx={ctx} initial={pos.staked > 0 ? pos.option : lead} lockSide={pos.staked > 0} />
          ) : (
            <Text style={s.sub}>Join on the Today tab to call this one.</Text>
          )
        ) : null}
      </Section>

      {sides ? (
        <Section title="Who's in">
          {m.options.map((o, i) => (
            <SideBlock key={i} label={o} side={sides[i] ?? []} i={i} won={m.status === "settled" ? m.winningOption === i : undefined} total={m.pools[i]} />
          ))}
        </Section>
      ) : null}

      {backer ? (
        <View style={{ backgroundColor: C.goldSoft, borderRadius: 14, padding: 16, flexDirection: "row", alignItems: "center", gap: 14 }}>
          <View style={{ width: 54, height: 54, borderRadius: 10, backgroundColor: C.gold, alignItems: "center", justifyContent: "center" }}>
            <Text style={{ fontSize: 30 }}>{backer.emoji}</Text>
          </View>
          <View style={{ flex: 1, gap: 2 }}>
            <Text style={[s.label, { color: C.goldDeep }]}>Biggest backer</Text>
            <Text style={[{ fontFamily: F.displaySemi, fontSize: 19, color: C.ink, lineHeight: 24 }, tnum]}>
              {backer.me ? "You" : "@" + backer.name} put <Text style={{ fontFamily: F.monoBold }}>{fmt(backer.amount)}</Text> on{" "}
              <Text style={{ color: OPTION_COLORS[backerSide % 4]?.deep ?? C.ink }}>{m.options[backerSide]}</Text>
            </Text>
          </View>
        </View>
      ) : null}

      <Reveal m={m} endsAt={d.endsAt} winners={m.status === "settled" && sides && m.winningOption !== undefined ? sides[m.winningOption] ?? [] : []} />
    </>
  );
}

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <View style={{ borderTopWidth: 2, borderTopColor: C.ink, paddingTop: 12, gap: 12 }}>
      <Text style={[s.label, { color: C.ink, fontSize: 12 }]}>{title}</Text>
      {children}
    </View>
  );
}

function SideBlock({ label, side, i, won, total }: { label: string; side: Staker[]; i: number; won?: boolean; total: number }) {
  const col = OPTION_COLORS[i % 4];
  return (
    <View style={{ gap: 6, opacity: won === false ? 0.55 : 1 }}>
      <View style={{ flexDirection: "row", alignItems: "center", gap: 10, backgroundColor: won ? col.fg : col.bg, borderRadius: 10, paddingHorizontal: 12, paddingVertical: 9 }}>
        <Text numberOfLines={1} style={{ fontFamily: F.display, fontSize: 18, color: won ? "#fff" : col.deep, textTransform: "uppercase", flexShrink: 1 }}>
          {won ? "✓ " : ""}
          {label}
        </Text>
        <Faces people={side} size={24} max={5} ring={won ? col.fg : col.bg} bg={C.card} />
        <View style={{ flex: 1 }} />
        <Text style={[{ fontFamily: F.mono, fontSize: 12, color: won ? "#fff" : col.deep }, tnum]}>
          {side.length} {side.length === 1 ? "person" : "people"} · {fmt(total)}
        </Text>
      </View>
      {side.length === 0 ? (
        <Text style={[s.sub, { paddingHorizontal: 12, fontStyle: "italic" }]}>Nobody yet</Text>
      ) : (
        side.map((p) => (
          <View key={p.id} style={{ flexDirection: "row", alignItems: "center", gap: 10, paddingHorizontal: 12, paddingVertical: 5, borderBottomWidth: 1, borderBottomColor: C.line }}>
            <Text style={{ fontSize: 20, width: 26 }}>{p.emoji}</Text>
            <Text numberOfLines={1} style={{ fontFamily: p.me ? F.bodyBold : F.bodyMed, fontSize: 15, color: C.ink, flexShrink: 1 }}>
              {"@" + p.name}{p.me ? " (you)" : ""}
            </Text>
            {p.late ? <LateTag /> : null}
            <View style={{ flex: 1 }} />
            {p.payout !== undefined && won !== undefined ? (
              <Text style={[{ fontFamily: F.monoBold, fontSize: 14, color: p.payout > p.amount ? C.yes : C.no }, tnum]}>
                {p.payout > 0 ? "+" + fmt(p.payout - p.amount) : "−" + fmt(p.amount)}
              </Text>
            ) : null}
            <Text style={[{ fontFamily: F.mono, fontSize: 14, color: C.sub, minWidth: 48, textAlign: "right" }, tnum]}>{fmt(p.amount)}</Text>
          </View>
        ))
      )}
    </View>
  );
}

function Reveal({ m, endsAt, winners }: { m: Market; endsAt: number; winners: Staker[] }) {
  const settled = m.status === "settled";
  const lines =
    m.status === "refunded"
      ? { kicker: "Voided", head: "No result. Everyone got their points back.", sub: "" }
      : settled
        ? {
            kicker: "Called",
            head: m.options[m.winningOption ?? 0] + ". " + winners.length + (winners.length === 1 ? " person" : " people") + " called it.",
            sub: winners.length ? "Winners split the pot of " + fmt(m.total) + " pts by stake." : "Nobody called it.",
          }
        : {
            kicker: "The reveal",
            head: "Results drop when the admin calls it.",
            sub: m.locked ? "Betting is closed. Sit tight." : "Bets stay open until the next drop at " + hourLabel(endsAt) + ".",
          };
  return (
    <View style={{ backgroundColor: C.ink, borderRadius: 14, padding: 18, gap: 8 }}>
      <Text style={[s.label, { color: C.gold }]}>{lines.kicker}</Text>
      <Text style={{ fontFamily: F.display, fontSize: 24, lineHeight: 29, color: C.paper, letterSpacing: -0.4 }}>{lines.head}</Text>
      {winners.length ? <Faces people={winners} size={30} max={8} ring={C.ink} bg={C.yes} /> : null}
      {lines.sub ? <Text style={[s.sub, { color: C.faint }]}>{lines.sub}</Text> : null}
    </View>
  );
}
