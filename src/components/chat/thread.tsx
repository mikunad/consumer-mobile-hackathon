import { useRef, useState } from "react";
import { Pressable, ScrollView, Text, TextInput, View, KeyboardAvoidingView, Platform } from "react-native";
import { useRouter } from "expo-router";
import { useAction, useMutation } from "convex/react";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { FunctionReturnType } from "convex/server";
import { api } from "@convex/_generated/api";
import { Id } from "@convex/_generated/dataModel";
import { useStableQuery } from "@/lib/use-stable-query";
import { clock, fmt, useNow, useQueryNow } from "@/lib/time";
import { MarketSheet } from "./market-sheet";
import { InvisibleInk } from "./ink";
import { Suggestions, Draft } from "./suggestions";
import { I, SYS, optColor, t } from "./ios";

type Data = NonNullable<FunctionReturnType<typeof api.chat.thread>>;
export type Who = { _id: string; name: string; emoji: string } | null;
export type Face = { emoji: string; name: string };
export type BetItem = {
  type: "bet";
  _id: Id<"bets">;
  t: number;
  question: string;
  kind: "yesno" | "overunder" | "multi";
  options: string[];
  pools: number[];
  pct: number[];
  total: number;
  bettors: number;
  status: string;
  winningOption?: number;
  subject: Who;
  author: Who;
  ai: boolean;
  aboutMe: boolean;
  mine: { option: number; amount: number; payout?: number } | null;
  faces: Face[];
};
type SealedItem = { type: "sealed"; _id: Id<"bets">; t: number; friends: number; total: number; author: Who; faces: Face[] };
type StakeItem = { type: "stake"; _id: string; t: number; betId: Id<"bets">; who: Who; amount: number; option: string; question: string };
type SettledItem = { type: "settled"; _id: string; t: number; betId: Id<"bets">; question: string; status: string; winner: string | null; subject: Who; payouts: { emoji: string; name: string; net: number }[] };
type Item = BetItem | SealedItem | StakeItem | SettledItem;
type Kind = "yesno" | "overunder" | "multi";

export function stamp(ts: number) {
  const d = new Date(ts);
  const h = d.getHours() % 12 || 12;
  return h + ":" + String(d.getMinutes()).padStart(2, "0") + (d.getHours() < 12 ? " AM" : " PM");
}

export function Avatar({ emoji, size = 30, bg = "#D7D7DC" }: { emoji: string; size?: number; bg?: string }) {
  return (
    <View style={{ width: size, height: size, borderRadius: size / 2, backgroundColor: bg, alignItems: "center", justifyContent: "center" }}>
      <Text style={{ fontSize: size * 0.56 }}>{emoji}</Text>
    </View>
  );
}

export function Stack({ faces, size = 34 }: { faces: string[]; size?: number }) {
  const shown = faces.slice(0, 3);
  if (shown.length <= 1) return <Avatar emoji={shown[0] ?? "👥"} size={size} />;
  const small = size * 0.68;
  return (
    <View style={{ width: size * 1.25, height: size }}>
      {shown.slice(0, 2).map((f, i) => (
        <View key={i} style={{ position: "absolute", left: i === 0 ? 0 : size * 1.25 - small, top: i === 0 ? 0 : size - small, borderWidth: 1.5, borderColor: I.bg, borderRadius: small }}>
          <Avatar emoji={f} size={small} />
        </View>
      ))}
    </View>
  );
}

export function Bubble({ mine, color, children, tail, width }: { mine: boolean; color: string; children: React.ReactNode; tail: boolean; width?: number }) {
  const side = mine ? "right" : "left";
  return (
    <View style={{ alignSelf: mine ? "flex-end" : "flex-start", width }}>
      {tail ? (
        <>
          <View style={{ position: "absolute", bottom: 0, [side]: -6, width: 20, height: 18, backgroundColor: color, [mine ? "borderBottomLeftRadius" : "borderBottomRightRadius"]: 15 }} />
          <View style={{ position: "absolute", bottom: 0, [side]: -10, width: 10, height: 20, backgroundColor: I.bg, [mine ? "borderBottomLeftRadius" : "borderBottomRightRadius"]: 10 }} />
        </>
      ) : null}
      <View style={{ backgroundColor: color, borderRadius: 18, paddingHorizontal: 12, paddingVertical: 8 }}>{children}</View>
    </View>
  );
}

function Tapbacks({ faces, mine }: { faces: Face[]; mine: boolean }) {
  if (!faces.length) return null;
  return (
    <View style={{ position: "absolute", top: -16, [mine ? "left" : "right"]: -8, flexDirection: mine ? "row" : "row-reverse", zIndex: 2 }}>
      {faces.slice(0, 5).map((f, i) => (
        <View
          key={i}
          style={{ width: 30, height: 30, borderRadius: 15, backgroundColor: mine ? I.gray : "#D9EAFF", borderWidth: 2, borderColor: I.bg, alignItems: "center", justifyContent: "center", [mine ? "marginLeft" : "marginRight"]: i ? -9 : 0 }}
        >
          <Text style={{ fontSize: 14 }}>{f.emoji}</Text>
        </View>
      ))}
    </View>
  );
}

export function Row({ who, mine, showName, last, children, faces }: { who: Who; mine: boolean; showName: boolean; last: boolean; children: React.ReactNode; faces?: Face[] }) {
  const isAI = who?._id === "ai";
  return (
    <View style={{ gap: 2, marginTop: faces?.length ? 14 : 0 }}>
      {showName && !mine ? (
        <Text style={[t(11, "400", I.secondary), { marginLeft: 50 }]}>
          {isAI ? "AI · Created by AI" : who?.name ?? "someone"}
        </Text>
      ) : null}
      <View style={{ flexDirection: "row", alignItems: "flex-end", gap: 8, justifyContent: mine ? "flex-end" : "flex-start" }}>
        {!mine ? <View style={{ width: 30 }}>{last ? <Avatar emoji={who?.emoji ?? "🙂"} bg={isAI ? "#1C1C1E" : "#D7D7DC"} /> : null}</View> : null}
        <View style={{ maxWidth: "82%", flexShrink: 1 }}>
          {children}
          {faces ? <Tapbacks faces={faces} mine={mine} /> : null}
        </View>
      </View>
    </View>
  );
}

export function Poll({ b, mine }: { b: BetItem; mine: boolean }) {
  const settled = b.status === "settled" || b.status === "refunded";
  const fg = mine ? "#fff" : I.label;
  const sub = mine ? "rgba(255,255,255,0.8)" : I.secondary;
  const mention = mine ? "#fff" : "#0A7AFF";
  return (
    <View style={{ gap: 10, width: 252, paddingVertical: 2 }}>
      <Text style={t(17, "400", fg)}>
        {b.subject && !b.question.toLowerCase().includes("@" + b.subject.name.toLowerCase()) ? <Text style={t(17, "600", mention)}>{b.aboutMe ? "@you " : "@" + b.subject.name + " "}</Text> : null}
        {b.question}
      </Text>
      <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 8 }}>
        {b.options.map((o, i) => {
          const won = settled && b.winningOption === i;
          const lost = settled && b.winningOption !== i;
          const picked = b.mine?.option === i;
          return (
            <View key={i} style={{ borderRadius: 99, paddingHorizontal: 14, paddingVertical: 7, backgroundColor: won ? "#22903F" : picked ? "#0A7AFF" : "#fff", opacity: lost ? 0.5 : 1 }}>
              <Text style={[t(15, "500", won || picked ? "#fff" : "#0A7AFF"), { fontVariant: ["tabular-nums"] }]}>
                {won ? "✓ " : ""}
                {o} · {Math.round(b.pct[i])}%
              </Text>
            </View>
          );
        })}
      </View>
      <Text style={[t(12, "400", sub), { fontVariant: ["tabular-nums"] }]}>
        {b.bettors} in · {fmt(b.total)} pts ·{" "}
        {settled
          ? b.mine?.payout !== undefined
            ? b.mine.payout > b.mine.amount
              ? "you won " + fmt(b.mine.payout - b.mine.amount)
              : b.mine.payout === b.mine.amount
                ? "refunded"
                : "you lost " + fmt(b.mine.amount)
            : "called"
          : b.aboutMe
            ? "tap to call it"
            : b.mine
              ? "you're on " + b.options[b.mine.option]
              : "tap to bet"}
      </Text>
    </View>
  );
}

function Composer({ data, token }: { data: Data; token: string }) {
  const insets = useSafeAreaInsets();
  const create = useMutation(api.chat.createBet);
  const friends = data.members.filter((m) => m._id !== data.me._id);
  const [text, setText] = useState("");
  const [tray, setTray] = useState(false);
  const [subject, setSubject] = useState<Id<"users"> | null>(friends.length === 1 ? friends[0]._id : null);
  const [kind, setKind] = useState<Kind>("yesno");
  const [line, setLine] = useState(2.5);
  const [a, setA] = useState("");
  const [b, setB] = useState("");
  const [side, setSide] = useState(0);
  const [amount, setAmount] = useState(100);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [ai, setAi] = useState(false);
  const suggest = useAction(api.ai.suggest);
  const [live, setLive] = useState<{ subject: string; kind: Kind; question: string; line?: number; options?: string[]; why: string }[] | null>(null);
  const [drafting, setDrafting] = useState(false);
  const [ideas, setIdeas] = useState(false);
  const closed = data.group.revealed;
  const pickIdea = (d: Draft) => {
    setText(d.question);
    setKind(d.kind);
    if (d.line !== undefined) setLine(Math.floor(d.line) + 0.5);
    if (d.options) {
      setA(d.options[0] ?? "");
      setB(d.options[1] ?? "");
    }
    setSubject(d.subjectId as Id<"users">);
    setSide(0);
    setAi(true);
    setIdeas(false);
    setTray(true);
  };
  const options = kind === "yesno" ? ["Yes", "No"] : kind === "overunder" ? ["Over " + line, "Under " + line] : [a.trim() || "This", b.trim() || "That"];
  const ready = !!subject && text.trim().length >= 5 && (kind !== "multi" || (a.trim() && b.trim()));
  const open = tray || text.length > 0;
  const send = async () => {
    if (!ready || !subject) {
      setTray(true);
      setErr(!subject ? "Who's it about?" : kind === "multi" && !(a.trim() && b.trim()) ? "Name both choices" : "Write the question");
      return;
    }
    setBusy(true);
    setErr(null);
    try {
      await create({ token, groupId: data.group._id, subjectUserId: subject, kind, question: text, line: kind === "overunder" ? line : undefined, options: kind === "multi" ? [a, b] : undefined, option: side, amount: Math.min(amount, data.me.points), ai: ai || undefined });
      setAi(false);
      setText("");
      setA("");
      setB("");
      setTray(false);
      setSide(0);
    } catch (e) {
      setErr(String((e as { data?: string }).data ?? (e as Error).message));
    } finally {
      setBusy(false);
    }
  };
  const chip = (on: boolean) => ({ paddingHorizontal: 11, paddingVertical: 6, borderRadius: 99, backgroundColor: on ? I.blue : I.fill });
  const seg = (on: boolean) => ({ flex: 1, alignItems: "center" as const, paddingVertical: 6, borderRadius: 7, backgroundColor: on ? "#fff" : "transparent", shadowColor: "#000", shadowOpacity: on ? 0.08 : 0, shadowRadius: 3, shadowOffset: { width: 0, height: 1 } });
  return (
    <View style={{ backgroundColor: I.bar, borderTopWidth: 0.5, borderTopColor: I.sep, paddingBottom: Math.max(insets.bottom, 8) }}>
      {open && !closed ? (
        <View style={{ paddingHorizontal: 12, paddingTop: 10, gap: 9, maxWidth: 620, width: "100%", alignSelf: "center" }}>
          <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
            <Pressable onPress={() => setIdeas(!ideas)} style={[chip(ideas), { flexDirection: "row", gap: 5, alignItems: "center" }]}>
              <Text style={t(14, "600", ideas ? "#fff" : I.purple)}>✦ Ideas from your chats</Text>
            </Pressable>
            {ai ? <Text style={t(12, "500", I.secondary)}>Created by AI · edit anything</Text> : null}
          </View>
          {ideas ? (
            <ScrollView style={{ maxHeight: 330 }} keyboardShouldPersistTaps="handled" contentContainerStyle={{ gap: 6 }}>
              <Pressable
                disabled={drafting}
                onPress={async () => {
                  setDrafting(true);
                  setErr(null);
                  try {
                    setLive(await suggest({ token, groupId: data.group._id }));
                  } catch (e) {
                    setErr(String((e as { data?: string }).data ?? (e as Error).message));
                  } finally {
                    setDrafting(false);
                  }
                }}
                style={{ alignSelf: "flex-start", paddingHorizontal: 11, paddingVertical: 6, borderRadius: 99, backgroundColor: "#F3E8FA" }}
              >
                <Text style={t(13, "600", I.purple)}>{drafting ? "Reading what you shared…" : live ? "✦ Draft fresh ones" : "✦ Draft live with AI from the shared chat"}</Text>
              </Pressable>
              {live?.map((d, i) => {
                const who = data.members.find((m) => m.name === d.subject);
                return (
                  <Pressable
                    key={i}
                    onPress={() => who && pickIdea({ subjectId: who._id, kind: d.kind, question: d.question, line: d.line, options: d.options })}
                    style={{ backgroundColor: "#fff", borderRadius: 12, borderWidth: 0.5, borderColor: I.sep, padding: 10, gap: 3 }}
                  >
                    <Text style={t(12, "600", I.secondary)}>
                      {who?.emoji} {d.subject} · {d.kind === "yesno" ? "Yes / No" : d.kind === "overunder" ? "Over / Under " + d.line : d.options?.join(" vs ")}
                    </Text>
                    <Text style={t(15, "600")}>{d.question}</Text>
                    <Text style={t(12, "400", I.purple)}>Why this bet? {d.why}</Text>
                  </Pressable>
                );
              })}
              {live ? null : <Suggestions members={data.members} meId={data.me._id} onPick={pickIdea} />}
            </ScrollView>
          ) : null}
          <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ gap: 6, alignItems: "center" }} keyboardShouldPersistTaps="handled">
            <Text style={t(13, "600", I.secondary)}>About</Text>
            {friends.map((f) => (
              <Pressable key={f._id} onPress={() => setSubject(f._id)} style={[chip(subject === f._id), { flexDirection: "row", gap: 4, alignItems: "center" }]}>
                <Text style={{ fontSize: 14 }}>{f.emoji}</Text>
                <Text style={t(14, "500", subject === f._id ? "#fff" : I.label)}>{f.name}</Text>
              </Pressable>
            ))}
            {friends.length === 0 ? <Text style={t(13, "400", I.secondary)}>Invite someone first · code {data.group.inviteCode}</Text> : null}
          </ScrollView>
          <View style={{ flexDirection: "row", backgroundColor: "#E3E3E8", borderRadius: 9, padding: 2 }}>
            {([["yesno", "Yes / No"], ["overunder", "Over / Under"], ["multi", "This or That"]] as const).map(([k, l]) => (
              <Pressable key={k} onPress={() => { setKind(k); setSide(0); }} style={seg(kind === k)}>
                <Text style={t(13, kind === k ? "600" : "400")}>{l}</Text>
              </Pressable>
            ))}
          </View>
          {kind === "overunder" ? (
            <View style={{ flexDirection: "row", alignItems: "center", gap: 10 }}>
              <Text style={t(13, "600", I.secondary)}>Line</Text>
              <Pressable onPress={() => setLine(Math.max(0.5, line - 1))} style={chip(false)}><Text style={t(16, "600")}>−</Text></Pressable>
              <Text style={[t(17, "600"), { fontVariant: ["tabular-nums"], minWidth: 44, textAlign: "center" }]}>{line}</Text>
              <Pressable onPress={() => setLine(line + 1)} style={chip(false)}><Text style={t(16, "600")}>+</Text></Pressable>
            </View>
          ) : null}
          {kind === "multi" ? (
            <View style={{ flexDirection: "row", gap: 8 }}>
              {[[a, setA, "Drunken noodle"], [b, setB, "Pad see ew"]].map(([v, set, ph], i) => (
                <TextInput key={i} value={v as string} onChangeText={set as (s: string) => void} placeholder={ph as string} placeholderTextColor={I.tertiary} maxLength={28} style={[t(15), { flex: 1, backgroundColor: "#fff", borderRadius: 10, borderWidth: 0.5, borderColor: I.sep, paddingHorizontal: 10, paddingVertical: 7 }]} />
              ))}
            </View>
          ) : null}
          <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ gap: 6, alignItems: "center" }} keyboardShouldPersistTaps="handled">
            <Text style={t(13, "600", I.secondary)}>I'm on</Text>
            {options.map((o, i) => (
              <Pressable key={i} onPress={() => setSide(i)} style={[chip(side === i), side === i ? { backgroundColor: optColor(kind, i).fg } : null]}>
                <Text numberOfLines={1} style={t(14, "500", side === i ? "#fff" : I.label)}>{o}</Text>
              </Pressable>
            ))}
            <View style={{ width: 6 }} />
            {[50, 100, 250].map((c) => (
              <Pressable key={c} onPress={() => setAmount(c)} style={chip(amount === c)}>
                <Text style={[t(14, "600", amount === c ? "#fff" : I.label), { fontVariant: ["tabular-nums"] }]}>{c}</Text>
              </Pressable>
            ))}
          </ScrollView>
          {err ? <Text style={t(13, "500", I.red)}>{err}</Text> : null}
        </View>
      ) : null}
      <View style={{ flexDirection: "row", alignItems: "flex-end", gap: 8, paddingHorizontal: 10, paddingTop: 8, maxWidth: 620, width: "100%", alignSelf: "center" }}>
        <Pressable onPress={() => setTray(!tray)} disabled={closed} style={{ width: 34, height: 34, borderRadius: 17, backgroundColor: tray ? I.blue : "#E3E3E8", alignItems: "center", justifyContent: "center", opacity: closed ? 0.4 : 1 }}>
          <Text style={[t(22, "400", tray ? "#fff" : "#6E6E73"), { marginTop: -2 }]}>+</Text>
        </Pressable>
        <View style={{ flex: 1, flexDirection: "row", alignItems: "flex-end", borderWidth: 1, borderColor: I.sep, borderRadius: 18, backgroundColor: "#fff", paddingLeft: 12, paddingRight: 3, minHeight: 34 }}>
          <TextInput
            value={text}
            onChangeText={setText}
            editable={!closed}
            multiline
            numberOfLines={1}
            maxLength={140}
            placeholder={closed ? "Betting's closed. Reveal time." : "Bet on someone…"}
            placeholderTextColor={I.secondary}
            style={[t(16), { flex: 1, paddingVertical: 7, minHeight: 34, maxHeight: 100, outlineStyle: "none" } as object]}
          />
          {text.trim() ? (
            <Pressable onPress={send} disabled={busy} style={{ width: 28, height: 28, borderRadius: 14, backgroundColor: I.blue, alignItems: "center", justifyContent: "center", marginBottom: 3, opacity: busy ? 0.5 : 1 }}>
              <Text style={[t(17, "800", "#fff"), { marginTop: -1 }]}>↑</Text>
            </Pressable>
          ) : null}
        </View>
      </View>
    </View>
  );
}

export function Thread({ token, groupId }: { token: string; groupId: Id<"groups"> }) {
  const insets = useSafeAreaInsets();
  const router = useRouter();
  const now = useNow(1000);
  const qnow = useQueryNow();
  const data = useStableQuery(api.chat.thread, { token, groupId, now: qnow }) as Data | null | undefined;
  const [open, setOpen] = useState<Id<"bets"> | null>(null);
  const scroll = useRef<React.ComponentRef<typeof ScrollView>>(null);
  if (data === undefined) return <View style={{ flex: 1, backgroundColor: I.bg }} />;
  if (data === null)
    return (
      <View style={{ flex: 1, backgroundColor: I.bg, padding: 24, paddingTop: 80 }}>
        <Text style={t(17, "400", I.secondary)}>You're not in this group.</Text>
      </View>
    );
  const items = data.items as Item[];
  const left = data.group.revealAt - now;
  const others = data.members.filter((m) => m._id !== data.me._id);
  const senderOf = (it: Item): string => (it.type === "stake" ? it.who?._id ?? "" : it.type === "settled" ? it.subject?._id ?? "" : it.author?._id ?? "");
  return (
    <KeyboardAvoidingView behavior={Platform.OS === "ios" ? "padding" : undefined} style={{ flex: 1, backgroundColor: I.bg }}>
      <View style={{ paddingTop: insets.top + 6, paddingBottom: 8, backgroundColor: I.bar, borderBottomWidth: 0.5, borderBottomColor: I.sep }}>
        <View style={{ flexDirection: "row", alignItems: "center", paddingHorizontal: 8, maxWidth: 620, width: "100%", alignSelf: "center" }}>
          <Pressable onPress={() => (router.canGoBack() ? router.back() : router.replace("/c"))} hitSlop={10} style={{ width: 70 }}>
            <Text style={t(30, "300", I.blue)}>‹</Text>
          </Pressable>
          <Pressable onPress={() => router.push({ pathname: "/c/g/[id]/info", params: { id: groupId } })} style={{ flex: 1, alignItems: "center", gap: 3 }}>
            <Stack faces={others.map((m) => m.emoji)} size={40} />
            <Text numberOfLines={1} style={t(11, "400")}>
              {data.group.name} <Text style={t(11, "400", I.secondary)}>›</Text>
            </Text>
          </Pressable>
          <View style={{ width: 70, alignItems: "flex-end", paddingRight: 6 }}>
            <Text style={[t(15, "600"), { fontVariant: ["tabular-nums"] }]}>{fmt(data.me.points)}</Text>
            <Text style={t(10, "400", I.secondary)}>pts</Text>
          </View>
        </View>
      </View>
      <ScrollView
        ref={scroll}
        onContentSizeChange={() => scroll.current?.scrollToEnd({ animated: false })}
        contentContainerStyle={{ paddingHorizontal: 12, paddingTop: 8, paddingBottom: 16, gap: 3, maxWidth: 620, width: "100%", alignSelf: "center" }}
        keyboardShouldPersistTaps="handled"
      >
        <View style={{ alignItems: "center", paddingVertical: 8, gap: 2 }}>
          <Text style={[t(11, "600", I.secondary), { fontVariant: ["tabular-nums"] }]}>
            {data.group.revealed ? "The reveal is live. Rub the ink." : "Reveal at " + stamp(data.group.revealAt) + " · " + clock(left)}
          </Text>
          <Text style={t(11, "400", I.secondary)}>Bets about you are hidden in invisible ink until then.</Text>
          {data.aboutMe.bets > 0 && !data.group.revealed ? (
            <Pressable onPress={() => router.push({ pathname: "/c/g/[id]/info", params: { id: groupId } })} style={{ marginTop: 6, backgroundColor: I.fill, borderRadius: 99, paddingHorizontal: 12, paddingVertical: 5 }}>
              <Text style={[t(12, "600"), { fontVariant: ["tabular-nums"] }]}>
                🔒 {data.aboutMe.bets} bet{data.aboutMe.bets === 1 ? "" : "s"} riding on you · {data.aboutMe.friends} friend{data.aboutMe.friends === 1 ? "" : "s"} · {fmt(data.aboutMe.points)} pts
              </Text>
            </Pressable>
          ) : null}
        </View>
        {items.length === 0 ? <Text style={[t(13, "400", I.secondary), { textAlign: "center", marginTop: 30 }]}>No bets yet. Type one below. The person it's about won't see it.</Text> : null}
        {items.map((it, idx) => {
          const prev = items[idx - 1];
          const next = items[idx + 1];
          const sender = senderOf(it);
          const mine = sender === data.me._id;
          const showTime = !prev || it.t - prev.t > 10 * 60 * 1000;
          const showName = showTime || !prev || senderOf(prev) !== sender;
          const last = !next || senderOf(next) !== sender || next.t - it.t > 10 * 60 * 1000;
          const time = showTime ? (
            <Text style={[t(11, "400", I.secondary), { textAlign: "center", marginVertical: 10 }]}>
              <Text style={t(11, "600", I.secondary)}>Today</Text> {stamp(it.t)}
            </Text>
          ) : null;
          const gap = !showTime && showName ? <View style={{ height: 8 }} /> : null;
          if (it.type === "bet") {
            const inkedForMe = it.aboutMe && it.status === "open";
            const bubble = (
              <Bubble mine={mine} color={mine ? I.blue : I.gray} tail={last}>
                <Poll b={it} mine={mine} />
              </Bubble>
            );
            return (
              <View key={it._id}>
                {time}
                {gap}
                <Row who={it.author} mine={mine} showName={showName} last={last} faces={it.faces}>
                  {inkedForMe ? (
                    <InvisibleInk name={"@" + data.me.name} canRub hint="">
                      <Pressable onPress={() => setOpen(it._id)}>{bubble}</Pressable>
                    </InvisibleInk>
                  ) : (
                    <Pressable onPress={() => setOpen(it._id)}>{bubble}</Pressable>
                  )}
                </Row>
              </View>
            );
          }
          if (it.type === "sealed")
            return (
              <View key={it._id}>
                {time}
                {gap}
                <Row who={it.author} mine={false} showName={showName} last={last} faces={it.faces}>
                  <InvisibleInk name={"@" + data.me.name} canRub={false} hint={"Unlocks at " + stamp(data.group.revealAt) + " · " + (it.friends === 1 ? "1 friend is in" : it.friends + " friends are in")} />
                </Row>
              </View>
            );
          if (it.type === "stake")
            return (
              <View key={it._id}>
                {time}
                {gap}
                <Row who={it.who} mine={mine} showName={showName} last={last}>
                  <Bubble mine={mine} color={mine ? I.blue : I.gray} tail={last}>
                    <Text style={t(16, "400", mine ? "#fff" : I.label)}>
                      {fmt(it.amount)} on {it.option} <Text style={t(13, "400", mine ? "rgba(255,255,255,0.75)" : I.secondary)}>· {it.question.length > 34 ? it.question.slice(0, 33) + "…" : it.question}</Text>
                    </Text>
                  </Bubble>
                </Row>
              </View>
            );
          return (
            <View key={it._id}>
              {time}
              {gap}
              <Row who={it.subject} mine={mine} showName={showName} last={last}>
                <Bubble mine={mine} color={mine ? I.blue : I.gray} tail={last}>
                  <Text style={t(16, "400", mine ? "#fff" : I.label)}>
                    {it.status === "refunded" ? (it.winner ? "Nobody had it. Refunds all round." : "Vetoed. Refunds all round.") : "It was " + it.winner + ". " + it.question}
                  </Text>
                  {it.payouts.length ? (
                    <Text style={[t(14, "600", mine ? "rgba(255,255,255,0.9)" : I.green), { marginTop: 3, fontVariant: ["tabular-nums"] }]}>
                      {it.payouts.map((p) => p.emoji + " " + p.name + " +" + fmt(p.net)).join("   ")}
                    </Text>
                  ) : null}
                </Bubble>
              </Row>
            </View>
          );
        })}
      </ScrollView>
      <Composer data={data} token={token} />
      {open ? <MarketSheet betId={open} token={token} onClose={() => setOpen(null)} /> : null}
    </KeyboardAvoidingView>
  );
}
