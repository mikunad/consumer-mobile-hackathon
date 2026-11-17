import { useState } from "react";
import { Modal, Pressable, ScrollView, Text, TextInput, View } from "react-native";
import { useMutation } from "convex/react";
import { api } from "@convex/_generated/api";
import { Id } from "@convex/_generated/dataModel";
import { useStableQuery } from "@/lib/use-stable-query";
import { useQueryNow, fmt } from "@/lib/time";
import { payoutFor } from "@/lib/odds";
import { MarketChart } from "@/components/ui";
import { I, optColor, t } from "./ios";

const BLUE = "#0A7AFF";
const GROUPED = "#F2F2F7";
const GREEN = "#22903F";
const RED = "#D7001A";

export function optionColor(kind: string, i: number) {
  const c = optColor(kind, i);
  return { fg: c.fg, bg: c.soft, deep: c.fg };
}

function timeOf(ts: number) {
  return new Date(ts).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
}

function Cta({ label, onPress, disabled, color = BLUE }: { label: string; onPress: () => void; disabled?: boolean; color?: string }) {
  return (
    <Pressable onPress={onPress} disabled={disabled} style={({ pressed }) => ({ flex: 1, height: 50, borderRadius: 14, backgroundColor: color, alignItems: "center", justifyContent: "center", opacity: disabled ? 0.4 : pressed ? 0.85 : 1 })}>
      <Text style={t(17, "600", "#fff")}>{label}</Text>
    </Pressable>
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
  return (
    <Modal transparent animationType="slide" visible onRequestClose={onClose}>
      <Pressable onPress={onClose} style={{ flex: 1, backgroundColor: "rgba(0,0,0,0.3)" }} />
      <View style={{ maxHeight: "90%", backgroundColor: GROUPED, borderTopLeftRadius: 14, borderTopRightRadius: 14 }}>
        <View style={{ alignSelf: "center", width: 36, height: 5, borderRadius: 3, backgroundColor: "#C7C7CC", marginTop: 6 }} />
        <View style={{ flexDirection: "row", alignItems: "center", paddingHorizontal: 16, paddingTop: 10, paddingBottom: 6, maxWidth: 560, width: "100%", alignSelf: "center" }}>
          <Pressable onPress={onClose} hitSlop={10} style={{ width: 80 }}>
            <Text style={t(17, "400", BLUE)}>{m && m.locked ? "Done" : "Cancel"}</Text>
          </Pressable>
          <Text numberOfLines={1} style={[t(17, "600"), { flex: 1, textAlign: "center" }]}>{title}</Text>
          <Text style={[t(15, "400", I.secondary), { width: 80, textAlign: "right" }]}>{m && !m.locked ? "locks " + timeOf(m.revealAt) : ""}</Text>
        </View>
        {m === undefined ? (
          <Text style={[t(15, "400", I.secondary), { padding: 24 }]}>Loading…</Text>
        ) : m === null ? (
          <View style={{ padding: 24, gap: 8 }}>
            <Text style={t(22, "700")}>Today&apos;s bet is about you</Text>
            <Text style={t(15, "400", I.secondary)}>You&apos;ll see it at the reveal.</Text>
          </View>
        ) : (
          <ScrollView contentContainerStyle={{ paddingHorizontal: 16, paddingBottom: 30, gap: 14, maxWidth: 560, width: "100%", alignSelf: "center" }} keyboardShouldPersistTaps="handled">
            {m.isSubject ? <Text style={t(15, "400", I.secondary)}>Your friends bet on whether…</Text> : null}
            <View style={{ flexDirection: "row", alignItems: "flex-end", gap: 8 }}>
              <View style={{ width: 30, height: 30, borderRadius: 15, backgroundColor: "#1C1C1E", alignItems: "center", justifyContent: "center" }}>
                <Text style={t(11, "700", "#E8C25A")}>{m.author ? m.author.emoji : "CI"}</Text>
              </View>
              <View style={{ flexShrink: 1, backgroundColor: "#E9E9EB", borderRadius: 18, paddingHorizontal: 14, paddingVertical: 10 }}>
                <Text style={t(17, "400")}>{m.question}</Text>
              </View>
            </View>
            <View style={{ backgroundColor: "#fff", borderRadius: 12, overflow: "hidden" }}>
              {m.options.map((o, i) => {
                const on = pick === i;
                const won = m.status === "settled" && m.winningOption === i;
                const mult = payoutFor(m.pools, i, 100) / 100;
                return (
                  <Pressable
                    key={i}
                    disabled={m.locked || !!m.mine || m.isSubject}
                    onPress={() => setSide(i)}
                    style={{ flexDirection: "row", alignItems: "center", paddingHorizontal: 16, paddingVertical: 12, marginLeft: i ? 16 : 0, paddingLeft: i ? 0 : 16, borderTopWidth: i ? 0.5 : 0, borderTopColor: "#C6C6C8" }}
                  >
                    <View style={{ flex: 1, gap: 2 }}>
                      <Text style={t(17, on || won ? "600" : "400")}>
                        {won ? "✓ " : ""}
                        {o}
                      </Text>
                      <Text style={[t(14, "400", I.secondary), { fontVariant: ["tabular-nums"] }]}>
                        {Math.round(m.pct[i])}% picked this{m.status === "open" ? " · pays " + mult.toFixed(1) + "×" : " · " + fmt(m.pools[i]) + " pts"}
                      </Text>
                    </View>
                    <View style={{ width: 24, height: 24, borderRadius: 12, borderWidth: on || won ? 0 : 1.5, borderColor: "#C7C7CC", backgroundColor: on || won ? BLUE : "transparent", alignItems: "center", justifyContent: "center" }}>
                      {on || won ? <Text style={t(13, "800", "#fff")}>✓</Text> : null}
                    </View>
                  </Pressable>
                );
              })}
            </View>
            {m.canDeclare ? (
              <View style={{ gap: 10, marginTop: 6 }}>
                <Text style={[t(22, "700"), { textAlign: "center" }]}>So... is it true?</Text>
                <View style={{ flexDirection: "row", gap: 10 }}>
                  {m.options.map((o, i) => (
                    <Cta key={i} color={m.kind === "yesno" ? (i === 0 ? GREEN : RED) : i === 0 ? GREEN : BLUE} label={m.kind === "yesno" ? (i === 0 ? "Yeah, guilty" : "Nope, never") : o} disabled={busy} onPress={() => run(() => declare({ token, betId, winningOption: i }))} />
                  ))}
                </View>
                <Pressable onPress={() => run(() => veto({ token, betId }))} disabled={busy} style={{ alignSelf: "center", paddingVertical: 4 }}>
                  <Text style={t(15, "400", BLUE)}>Too far? Veto it</Text>
                </Pressable>
                <Text style={[t(13, "400", I.secondary), { textAlign: "center" }]}>Honor system. Veto refunds everyone.</Text>
              </View>
            ) : null}
            {!m.locked && !m.isSubject ? (
              <>
                <Text style={[t(13, "400", I.secondary), { marginLeft: 16, marginBottom: -8 }]}>{m.mine ? "ADD TO " + m.options[m.mine.option].toUpperCase() : "HOW SURE ARE YOU"}</Text>
                <View style={{ backgroundColor: "#fff", borderRadius: 12, padding: 16, gap: 12 }}>
                  <View style={{ flexDirection: "row", alignItems: "baseline", gap: 6 }}>
                    <TextInput
                      value={amount}
                      onChangeText={(v) => setAmount(v.replace(/[^0-9]/g, ""))}
                      keyboardType="number-pad"
                      returnKeyType="done"
                      style={[t(34, "700"), { minWidth: 70, padding: 0, fontVariant: ["tabular-nums"], outlineStyle: "none" } as object]}
                    />
                    <Text style={t(17, "400", I.secondary)}>pts</Text>
                    <View style={{ flex: 1 }} />
                    <Text style={[t(15, "400", I.secondary), { fontVariant: ["tabular-nums"] }]}>You have {fmt(m.points)} left</Text>
                  </View>
                  <View style={{ height: 4, borderRadius: 2, backgroundColor: "#E5E5EA" }}>
                    <View style={{ height: 4, borderRadius: 2, backgroundColor: BLUE, width: Math.min(100, (100 * amt) / Math.max(1, m.points)) + "%" }} />
                  </View>
                  <View style={{ flexDirection: "row", gap: 8 }}>
                    {[["50", 50], ["100", 100], ["250", 250], ["All in", m.points]].map(([l, v]) => (
                      <Pressable key={l} onPress={() => setAmount(String(v))} style={{ flex: 1, alignItems: "center", paddingVertical: 8, borderRadius: 99, backgroundColor: amt === v ? BLUE : "#E9E9EB" }}>
                        <Text style={t(15, "500", amt === v ? "#fff" : BLUE)}>{l}</Text>
                      </Pressable>
                    ))}
                  </View>
                </View>
                <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
                  <Text style={{ fontSize: 16 }}>{bettors.map((b) => b.emoji).join("")}</Text>
                  <Text numberOfLines={1} style={[t(15, "400", I.secondary), { flex: 1 }]}>
                    {bettors.length ? bettors.map((b) => (b.me ? "You" : b.name)).join(", ") + " already bet" : "Nobody's in yet"}
                  </Text>
                  {pick !== null && amt > 0 ? <Text style={[t(17, "700"), { fontVariant: ["tabular-nums"] }]}>Win ≈ {fmt(payoutFor(m.pools, pick, amt))}</Text> : null}
                </View>
                <View style={{ flexDirection: "row" }}>
                  <Cta
                    label={busy ? "Placing…" : pick === null ? "Pick a side" : "Call it"}
                    disabled={busy || pick === null || amt < 1}
                    onPress={() => pick !== null && run(async () => { await stake({ token, betId, option: pick, amount: amt }); onClose(); })}
                  />
                </View>
                <Text style={[t(13, "400", I.secondary), { textAlign: "center" }]}>{name} won&apos;t see this bet until {timeOf(m.revealAt)}.</Text>
              </>
            ) : null}
            {err ? <Text style={t(15, "500", RED)}>{err}</Text> : null}
            {m.locked || m.isSubject ? (
              <>
                <Text style={[t(13, "400", I.secondary), { marginLeft: 16, marginBottom: -8 }]}>WHO BET WHAT</Text>
                <View style={{ backgroundColor: "#fff", borderRadius: 12, overflow: "hidden" }}>
                  {m.options.flatMap((o, i) =>
                    m.sides[i].map((p, j) => (
                      <View key={o + j} style={{ flexDirection: "row", alignItems: "center", gap: 12, paddingHorizontal: 16, paddingVertical: 11 }}>
                        <Text style={{ fontSize: 22 }}>{p.emoji}</Text>
                        <Text style={[t(17), { flex: 1 }]}>{p.me ? "You" : p.name}</Text>
                        <Text style={t(15, "400", I.secondary)}>
                          {o} · {fmt(p.amount)}
                        </Text>
                      </View>
                    )),
                  )}
                  {bettors.length === 0 ? <Text style={[t(15, "400", I.secondary), { padding: 16 }]}>Nobody bet on this one.</Text> : null}
                </View>
              </>
            ) : null}
            <MarketChart
              ticks={m.ticks.length ? m.ticks : [{ t: m.opensAt, pct: m.pct }]}
              start={m.opensAt}
              end={Math.max(m.revealAt, now)}
              now={Math.min(now, m.revealAt)}
              colors={m.options.map((_, i) => optionColor(m.kind, i).fg)}
              height={80}
              startLabel="dropped"
              endLabel={"reveal " + timeOf(m.revealAt)}
            />
          </ScrollView>
        )}
      </View>
    </Modal>
  );
}
