import { useEffect, useRef, useState } from "react";
import { Animated, Modal, Pressable, ScrollView, Text, TextInput, View } from "react-native";
import { useMutation } from "convex/react";
import { api } from "@convex/_generated/api";
import { Id } from "@convex/_generated/dataModel";
import { useStableQuery } from "@/lib/use-stable-query";
import { useQueryNow, fmt } from "@/lib/time";
import { payoutFor } from "@/lib/odds";
import { MarketChart } from "@/components/ui";
import { Bounce, Glow, LiveDot, N, Ticker, label, mono, nightOpt, nt } from "./night";

function timeOf(ts: number) {
  return new Date(ts).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
}

function Cta({ label: text, onPress, disabled, color = N.lime, ink = N.bg }: { label: string; onPress: () => void; disabled?: boolean; color?: string; ink?: string }) {
  return (
    <View style={{ flex: 1 }}>
      <Bounce
        onPress={onPress}
        disabled={disabled}
        accessibilityLabel={text}
        style={{ height: 54, borderRadius: 14, backgroundColor: disabled ? N.raised : color, alignItems: "center", justifyContent: "center", shadowColor: color, shadowOpacity: disabled ? 0 : 0.35, shadowRadius: 16, shadowOffset: { width: 0, height: 0 } }}
      >
        <Text style={nt(17, "700", disabled ? N.mut : ink)}>{text}</Text>
      </Bounce>
    </View>
  );
}

export function MarketSheet({ betId, token, onClose }: { betId: Id<"bets">; token: string; onClose: () => void }) {
  const now = useQueryNow();
  const m = useStableQuery(api.chat.market, { token, betId, now });
  const stake = useMutation(api.chat.stake);
  const declare = useMutation(api.chat.declare);
  const veto = useMutation(api.chat.veto);
  const [side, setSide] = useState<number | null>(null);
  const [amount, setAmount] = useState("100");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const rise = useRef(new Animated.Value(700)).current;
  useEffect(() => {
    Animated.spring(rise, { toValue: 0, useNativeDriver: true, speed: 14, bounciness: 7 }).start();
  }, [rise]);
  const pick = m?.mine ? m.mine.option : side;
  const amt = Math.max(0, Math.floor(Number(amount) || 0));
  const run = async (f: () => Promise<unknown>) => {
    setBusy(true);
    setErr(null);
    try {
      await f();
    } catch (e) {
      setErr(String((e as { data?: string }).data ?? (e as Error).message));
    } finally {
      setBusy(false);
    }
  };
  const name = m?.subject?.name ?? "them";
  const bettors = m ? m.sides.flat() : [];
  const title = !m ? "" : m.isSubject ? "Your bet for today" : m.locked ? "The result" : "Bet on " + name;
  const settled = !!m && m.status === "settled" && m.winningOption !== undefined;
  const iWon = settled && !!m?.mine && m.mine.option === m.winningOption;
  return (
    <Modal transparent animationType="fade" visible onRequestClose={onClose}>
      <Pressable onPress={onClose} style={{ flex: 1, backgroundColor: "rgba(0,0,0,0.55)" }} />
      <Animated.View style={{ maxHeight: "90%", backgroundColor: N.bg, borderTopLeftRadius: 22, borderTopRightRadius: 22, borderTopWidth: 1, borderColor: N.line, transform: [{ translateY: rise }] }}>
        <View style={{ alignSelf: "center", width: 40, height: 5, borderRadius: 3, backgroundColor: "#3A423E", marginTop: 8 }} />
        <View style={{ flexDirection: "row", alignItems: "center", paddingHorizontal: 16, paddingTop: 12, paddingBottom: 6, maxWidth: 560, width: "100%", alignSelf: "center" }}>
          <Pressable onPress={onClose} hitSlop={10} style={{ width: 100 }}>
            <Text style={nt(17, "500", N.lime)}>{m && m.locked ? "Done" : "Cancel"}</Text>
          </Pressable>
          <Text numberOfLines={1} style={[label(), { flex: 1, textAlign: "center" }]}>{title}</Text>
          <Text numberOfLines={1} adjustsFontSizeToFit style={[label(), { width: 100, textAlign: "right", letterSpacing: 0.6 }]}>{m && !m.locked ? "locks " + timeOf(m.revealAt) : ""}</Text>
        </View>
        {m === undefined ? (
          <Text style={[mono(14, N.mut), { padding: 24 }]}>Loading…</Text>
        ) : m === null ? (
          <View style={{ padding: 24, gap: 8 }}>
            <Text style={nt(24, "800")}>Today's bet is about you</Text>
            <Text style={nt(15, "400", N.mut)}>You'll see it at the reveal.</Text>
          </View>
        ) : (
          <ScrollView contentContainerStyle={{ paddingHorizontal: 16, paddingBottom: 34, gap: 14, maxWidth: 560, width: "100%", alignSelf: "center" }} keyboardShouldPersistTaps="handled">
            <View style={{ gap: 8, paddingTop: 4 }}>
              <View style={{ flexDirection: "row", alignItems: "center", gap: 6 }}>
                {m.status === "open" ? <LiveDot /> : null}
                <Text style={label(m.status === "open" ? N.lime : N.mut)}>
                  {m.status === "open" ? "live" : m.status}
                  {m.subject ? " · about " + (m.isSubject ? "you" : m.subject.name) : ""}
                </Text>
              </View>
              {m.isSubject ? <Text style={nt(15, "400", N.mut)}>Your friends bet on whether…</Text> : null}
              <Text style={nt(24, "800")}>{m.question}</Text>
            </View>
            {settled && m.mine ? (
              <Glow color={iWon ? N.gold : N.red} style={{ backgroundColor: "#000", borderRadius: 20, borderWidth: 1, borderColor: iWon ? N.gold : N.red, padding: 20, alignItems: "center", gap: 6 }}>
                <Text style={[nt(34, "800", iWon ? N.lime : N.red), { textShadowColor: iWon ? N.lime : N.red, textShadowRadius: 18 }]}>{iWon ? "Called it!" : "Not this time"}</Text>
                {iWon ? (
                  <Ticker value={(m.mine.payout ?? Math.floor((m.pools.reduce((a, b) => a + b, 0) * m.mine.amount) / m.pools[m.mine.option])) - m.mine.amount} prefix="+" suffix=" pts" duration={1400} style={mono(30, N.gold, true)} />
                ) : (
                  <Text style={mono(26, N.red, true)}>-{fmt(m.mine.amount)} pts</Text>
                )}
              </Glow>
            ) : null}
            <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 10 }}>
              {m.options.map((o, i) => {
                const on = pick === i;
                const won = settled && m.winningOption === i;
                const lost = settled && m.winningOption !== i;
                const c = nightOpt(m.kind, i);
                const mult = payoutFor(m.pools, i, 100) / 100;
                return (
                  <View key={i} style={{ flexBasis: "47%", flexGrow: 1 }}>
                    <Bounce
                      disabled={m.locked || !!m.mine || m.isSubject}
                      onPress={() => setSide(i)}
                      accessibilityLabel={o + " " + Math.round(m.pct[i]) + "%"}
                      style={{
                        backgroundColor: N.card,
                        borderRadius: 16,
                        borderWidth: on || won ? 1.5 : 1,
                        borderColor: on || won ? c : N.line,
                        padding: 14,
                        gap: 4,
                        opacity: lost ? 0.45 : 1,
                        shadowColor: c,
                        shadowOpacity: on || won ? 0.45 : 0,
                        shadowRadius: 18,
                        shadowOffset: { width: 0, height: 0 },
                      }}
                    >
                      <Text numberOfLines={1} style={label(on || won ? c : N.mut)}>
                        {won ? "✓ " : ""}
                        {o}
                      </Text>
                      <Ticker value={m.pct[i]} format={(n) => n + "%"} style={mono(34, c, true)} />
                      <Text style={mono(12, N.mut)}>{m.status === "open" ? "pays " + mult.toFixed(2) + "×" : fmt(m.pools[i]) + " pts"}</Text>
                    </Bounce>
                  </View>
                );
              })}
            </View>
            {m.canDeclare ? (
              <View style={{ gap: 10, marginTop: 6 }}>
                <Text style={[nt(22, "800"), { textAlign: "center" }]}>So... is it true?</Text>
                <View style={{ flexDirection: "row", gap: 10 }}>
                  {m.options.map((o, i) => (
                    <Cta
                      key={i}
                      color={m.kind === "yesno" ? (i === 0 ? N.lime : N.red) : nightOpt(m.kind, i)}
                      ink={m.kind === "yesno" && i === 1 ? N.text : N.bg}
                      label={m.kind === "yesno" ? (i === 0 ? "Yeah, guilty" : "Nope, never") : o}
                      disabled={busy}
                      onPress={() => run(() => declare({ token, betId, winningOption: i }))}
                    />
                  ))}
                </View>
                <Pressable onPress={() => run(() => veto({ token, betId }))} disabled={busy} style={{ alignSelf: "center", paddingVertical: 4 }}>
                  <Text style={nt(15, "500", N.lime)}>Too far? Veto it</Text>
                </Pressable>
                <Text style={[mono(12, N.mut), { textAlign: "center" }]}>Honor system. Veto refunds everyone.</Text>
              </View>
            ) : null}
            {!m.locked && !m.isSubject ? (
              <>
                <View style={{ flexDirection: "row", alignItems: "baseline", gap: 6, marginTop: 4 }}>
                  <Text style={[label(), { flex: 1 }]}>{m.mine ? "add to " + m.options[m.mine.option] : "how sure are you"}</Text>
                  <TextInput
                    value={amount}
                    onChangeText={(v) => setAmount(v.replace(/[^0-9]/g, ""))}
                    keyboardType="number-pad"
                    returnKeyType="done"
                    style={[mono(34, N.gold, true), { width: 130, padding: 0, textAlign: "right", outlineStyle: "none" } as object]}
                  />
                </View>
                <View style={{ height: 4, borderRadius: 2, backgroundColor: N.line }}>
                  <View style={{ height: 4, borderRadius: 2, backgroundColor: N.lime, width: Math.min(100, (100 * amt) / Math.max(1, m.points)) + "%" }} />
                </View>
                <View style={{ flexDirection: "row", gap: 8 }}>
                  {[["50", 50], ["100", 100], ["250", 250], ["All in", m.points]].map(([l, v]) => {
                    const on = amt === v;
                    return (
                      <View key={l} style={{ flex: 1 }}>
                        <Bounce onPress={() => setAmount(String(v))} accessibilityLabel={String(l)} style={{ alignItems: "center", paddingVertical: 11, borderRadius: 12, backgroundColor: on ? N.lime : N.card, borderWidth: 1, borderColor: on ? N.lime : N.line }}>
                          <Text style={mono(15, on ? N.bg : N.text, true)}>{l}</Text>
                        </Bounce>
                      </View>
                    );
                  })}
                </View>
                <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
                  <Text style={{ fontSize: 16 }}>{bettors.map((b) => b.emoji).join("")}</Text>
                  <Text numberOfLines={1} style={[nt(14, "400", N.mut), { flex: 1 }]}>
                    {bettors.length ? bettors.map((b) => (b.me ? "You" : b.name)).join(", ") + " already bet" : "Nobody's in yet"}
                  </Text>
                  <Text style={mono(12, N.mut)}>{fmt(m.points)} left</Text>
                </View>
                <View style={{ flexDirection: "row", justifyContent: "space-between", alignItems: "baseline" }}>
                  <Text style={label()}>win ≈</Text>
                  <Ticker value={pick !== null && amt > 0 ? payoutFor(m.pools, pick, amt) : 0} suffix=" pts" style={mono(20, N.gold, true)} />
                </View>
                <View style={{ flexDirection: "row" }}>
                  <Cta
                    label={busy ? "Placing…" : pick === null ? "Pick a side" : "Lock it in · " + fmt(amt)}
                    disabled={busy || pick === null || amt < 1}
                    onPress={() => pick !== null && run(async () => { await stake({ token, betId, option: pick, amount: amt }); onClose(); })}
                  />
                </View>
                <Text style={[mono(12, N.mut), { textAlign: "center" }]}>{name} won't see this bet until {timeOf(m.revealAt)}.</Text>
              </>
            ) : null}
            {err ? <Text style={nt(15, "600", N.red)}>{err}</Text> : null}
            {m.locked || m.isSubject ? (
              <>
                <Text style={[label(), { marginBottom: -6 }]}>who bet what</Text>
                <View style={{ backgroundColor: N.card, borderRadius: 16, borderWidth: 1, borderColor: N.line, overflow: "hidden" }}>
                  {m.options.flatMap((o, i) =>
                    m.sides[i].map((p, j) => (
                      <View key={o + j} style={{ flexDirection: "row", alignItems: "center", gap: 12, paddingHorizontal: 16, paddingVertical: 11, borderTopWidth: i || j ? 1 : 0, borderTopColor: N.line }}>
                        <Text style={{ fontSize: 22 }}>{p.emoji}</Text>
                        <Text style={[nt(16, p.me ? "700" : "500"), { flex: 1 }]}>{p.me ? "You" : p.name}</Text>
                        <Text style={mono(13, nightOpt(m.kind, i))}>
                          {o} · {fmt(p.amount)}
                        </Text>
                      </View>
                    )),
                  )}
                  {bettors.length === 0 ? <Text style={[nt(15, "400", N.mut), { padding: 16 }]}>Nobody bet on this one.</Text> : null}
                </View>
              </>
            ) : null}
            <View style={{ backgroundColor: N.card, borderRadius: 16, borderWidth: 1, borderColor: N.line, paddingTop: 10, paddingRight: 8 }}>
              <MarketChart
                ticks={m.ticks.length ? m.ticks : [{ t: m.opensAt, pct: m.pct }]}
                start={m.opensAt}
                end={Math.max(m.revealAt, now)}
                now={Math.min(now, m.revealAt)}
                colors={m.options.map((_, i) => nightOpt(m.kind, i))}
                height={80}
                startLabel="dropped"
                endLabel={"reveal " + timeOf(m.revealAt)}
              />
            </View>
          </ScrollView>
        )}
      </Animated.View>
    </Modal>
  );
}
