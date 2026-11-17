import { useEffect, useState } from "react";
import { ScrollView, Text, TextInput, View, Pressable } from "react-native";
import { useAction, useMutation, useQuery } from "convex/react";
import { api } from "@convex/_generated/api";
import { Id } from "@convex/_generated/dataModel";
import { loadPasscode, savePasscode } from "@/lib/identity";
import { C, F, OPTION_COLORS, tnum } from "@/lib/theme";
import { fmt, hourLabel } from "@/lib/time";
import { Button, Card, Tag, s } from "@/components/ui";

const HOUR = 3600 * 1000;

const input = {
  fontFamily: F.bodyMed,
  fontSize: 16,
  color: C.ink,
  backgroundColor: C.paper,
  borderRadius: 10,
  paddingHorizontal: 12,
  paddingVertical: 10,
};

export default function Admin() {
  const [passcode, setPasscode] = useState("");
  const [draft, setDraft] = useState("");
  useEffect(() => {
    loadPasscode().then(setPasscode);
  }, []);
  const ok = useQuery(api.admin.check, { passcode });
  if (!ok) {
    return (
      <View style={[s.screen, s.column, { paddingTop: 80, gap: 12 }]}>
        <Text style={s.h1}>Admin</Text>
        <TextInput
          value={draft}
          onChangeText={setDraft}
          placeholder="Passcode"
          placeholderTextColor={C.faint}
          secureTextEntry
          autoCapitalize="none"
          style={input}
          onSubmitEditing={() => {
            setPasscode(draft);
            savePasscode(draft);
          }}
        />
        <Button
          label="Enter"
          onPress={() => {
            setPasscode(draft);
            savePasscode(draft);
          }}
        />
        {passcode && ok === false ? <Text style={{ color: C.no, fontFamily: F.bodyMed }}>Wrong passcode</Text> : null}
      </View>
    );
  }
  return <AdminPanel passcode={passcode} />;
}

function AdminPanel({ passcode }: { passcode: string }) {
  const rounds = useQuery(api.admin.overview, { passcode });
  const createRound = useMutation(api.admin.createRound);
  const setTimes = useMutation(api.admin.setRoundTimes);
  const [msg, setMsg] = useState<string | null>(null);
  const run = async (f: () => Promise<unknown>) => {
    setMsg(null);
    try {
      await f();
    } catch (e) {
      setMsg(String((e as { data?: string }).data ?? (e as Error).message));
    }
  };
  const [nextHour] = useState(() => Math.ceil((Date.now() + 1) / HOUR) * HOUR);
  return (
    <ScrollView style={s.screen} contentContainerStyle={[s.column, { paddingTop: 24, paddingBottom: 80, gap: 14 }]}>
      <Text style={s.h1}>Admin</Text>
      {msg ? <Text style={{ color: C.no, fontFamily: F.bodyMed }}>{msg}</Text> : null}
      <ChatDemo passcode={passcode} run={run} />
      <View style={{ flexDirection: "row", gap: 8, flexWrap: "wrap" }}>
        <Button small label={"+ Round at " + hourLabel(nextHour)} onPress={() => run(() => createRound({ passcode, opensAt: nextHour }))} />
        <Button
          small
          color={C.tile}
          textColor={C.ink}
          label={"+ Round at " + hourLabel(nextHour + HOUR)}
          onPress={() => run(() => createRound({ passcode, opensAt: nextHour + HOUR }))}
        />
      </View>
      {rounds?.map((r) => (
        <Card key={r._id} style={{ gap: 12 }}>
          <View style={{ flexDirection: "row", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
            <Text style={s.h2}>{r.title}</Text>
            <Text style={[s.sub, tnum]}>
              opens {hourLabel(r.opensAt)}
            </Text>
            <View style={{ flex: 1 }} />
            <Button
              small
              color={C.tile}
              textColor={C.ink}
              label="Open now"
              onPress={() => run(() => setTimes({ passcode, roundId: r._id, opensAt: Date.now(), locksAt: Date.now() + 50 * 60 * 1000 }))}
            />

          </View>
          {r.bets.map((b) => (
            <BetAdmin key={b._id} bet={b} passcode={passcode} run={run} />
          ))}
          <AddBet roundId={r._id} passcode={passcode} run={run} />
          <AiDrafts roundId={r._id} passcode={passcode} />
        </Card>
      ))}
    </ScrollView>
  );
}

type Bet = {
  _id: Id<"bets">;
  counter?: number;
  line?: number;
  question: string;
  options: string[];
  pools: number[];
  status: "open" | "locked" | "settled" | "refunded";
  winningOption?: number;
};

function BetAdmin({ bet, passcode, run }: { bet: Bet; passcode: string; run: (f: () => Promise<unknown>) => Promise<void> }) {
  const settle = useMutation(api.admin.settle);
  const lock = useMutation(api.admin.lockBet);
  const del = useMutation(api.admin.deleteBet);
  const edit = useMutation(api.admin.editBet);
  const [q, setQ] = useState(bet.question);
  const adjust = useMutation(api.admin.adjustCounter);
  const settleCount = useMutation(api.admin.settleFromCounter);
  const [pending, setPending] = useState<number | null>(null);
  const preview = useQuery(api.admin.settlePreview, pending === null ? "skip" : { passcode, betId: bet._id, winningOption: pending });
  const done = bet.status === "settled" || bet.status === "refunded";
  return (
    <View style={{ gap: 8, borderTopWidth: 1.5, borderTopColor: C.line, paddingTop: 10 }}>
      <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
        <TextInput
          value={q}
          onChangeText={setQ}
          onBlur={() => q !== bet.question && run(() => edit({ passcode, betId: bet._id, question: q }))}
          style={[input, { flex: 1, paddingVertical: 6 }]}
        />
        <Tag label={bet.status} />
      </View>
      <Text style={[s.sub, tnum]}>
        {bet.options.map((o, i) => o + ": " + fmt(bet.pools[i])).join(" · ")}
      </Text>
      {bet.counter !== undefined && bet.line !== undefined ? (
        <View style={{ backgroundColor: C.ink, borderRadius: 14, padding: 14, gap: 10 }}>
          <Text style={[s.label, { color: C.faint }]}>Live counter · line {bet.line}</Text>
          <View style={{ flexDirection: "row", alignItems: "center", gap: 14 }}>
            <Pressable
              disabled={done}
              onPress={() => run(() => adjust({ passcode, betId: bet._id, delta: -1 }))}
              style={{ width: 64, height: 64, borderRadius: 14, backgroundColor: "#ffffff22", alignItems: "center", justifyContent: "center" }}
            >
              <Text style={{ fontFamily: F.monoBold, fontSize: 30, color: "#fff" }}>−1</Text>
            </Pressable>
            <Text style={[{ fontFamily: F.monoBold, fontSize: 64, color: bet.counter > bet.line ? C.gold : "#fff", flex: 1, textAlign: "center" }, tnum]}>{bet.counter}</Text>
            <Pressable
              disabled={done}
              onPress={() => run(() => adjust({ passcode, betId: bet._id, delta: 1 }))}
              style={({ pressed }) => ({ width: 96, height: 96, borderRadius: 18, backgroundColor: C.yes, alignItems: "center", justifyContent: "center", transform: [{ scale: pressed ? 0.92 : 1 }] })}
            >
              <Text style={{ fontFamily: F.monoBold, fontSize: 38, color: "#fff" }}>+1</Text>
            </Pressable>
          </View>
          {!done ? (
            <Button small color={C.gold} textColor={C.ink} label={"Settle from count: " + (bet.counter > bet.line ? bet.options[0] : bet.options[1])} onPress={() => run(() => settleCount({ passcode, betId: bet._id }))} />
          ) : null}
        </View>
      ) : null}
      {pending !== null && !done ? (
        <View style={{ backgroundColor: OPTION_COLORS[pending % 4].bg, borderRadius: 12, padding: 12, gap: 8 }}>
          <Text style={[s.body, tnum, { fontFamily: F.bodyBold }]}>
            {preview === undefined
              ? "…"
              : preview?.refund
                ? "Nobody picked " + bet.options[pending] + " → everyone gets refunded"
                : bet.options[pending] + " wins → " + preview?.winners + " players split " + fmt(preview?.total ?? 0) + " pts"}
          </Text>
          {preview?.biggest ? (
            <Text style={[s.sub, tnum]}>
              Biggest win: {preview.biggest.emoji} {preview.biggest.name} +{fmt(preview.biggest.amount)}
            </Text>
          ) : null}
          <Button
            small
            color={OPTION_COLORS[pending % 4].fg}
            label="Confirm & pay out"
            onPress={() => run(async () => { await settle({ passcode, betId: bet._id, winningOption: pending }); setPending(null); })}
          />
        </View>
      ) : null}
      {done ? (
        <Text style={[s.body, { fontFamily: F.bodyBold }]}>
          {bet.status === "refunded" ? "Refunded" : "Result: " + bet.options[bet.winningOption ?? 0]}
        </Text>
      ) : (
        <View style={{ flexDirection: "row", gap: 6, flexWrap: "wrap", alignItems: "center" }}>
          <Text style={s.label}>What happened?</Text>
          {bet.options.map((o, i) => (
            <Button
              key={i}
              small
              color={OPTION_COLORS[i % 4].fg}
              label={(pending === i ? "● " : "") + o}
              onPress={() => setPending(pending === i ? null : i)}
            />
          ))}
          <Button small color={C.tile} textColor={C.ink} label="Refund everyone (void)" onPress={() => run(() => settle({ passcode, betId: bet._id, winningOption: null }))} />
          <Button
            small
            color={C.tile}
            textColor={C.ink}
            label={bet.status === "locked" ? "Unlock" : "Lock"}
            onPress={() => run(() => lock({ passcode, betId: bet._id, locked: bet.status !== "locked" }))}
          />
          <Pressable onLongPress={() => run(() => del({ passcode, betId: bet._id }))}>
            <Text style={[s.sub, { padding: 8 }]}>hold to delete</Text>
          </Pressable>
        </View>
      )}
    </View>
  );
}

function AddBet({ roundId, passcode, run }: { roundId: Id<"rounds">; passcode: string; run: (f: () => Promise<unknown>) => Promise<void> }) {
  const add = useMutation(api.admin.addBet);
  const [question, setQuestion] = useState("");
  const [kind, setKind] = useState<"yesno" | "overunder" | "multi">("yesno");
  const [line, setLine] = useState("3.5");
  const [opts, setOpts] = useState("");
  const submit = () =>
    run(async () => {
      await add({
        passcode,
        roundId,
        question,
        kind,
        line: kind === "overunder" ? Number(line) : undefined,
        options: kind === "multi" ? opts.split(",") : undefined,
      });
      setQuestion("");
      setOpts("");
    });
  return (
    <View style={{ gap: 8, borderTopWidth: 1.5, borderTopColor: C.line, paddingTop: 10 }}>
      <Text style={s.label}>Add a bet</Text>
      <TextInput value={question} onChangeText={setQuestion} placeholder="Question" placeholderTextColor={C.faint} style={input} />
      <View style={{ flexDirection: "row", gap: 6 }}>
        {(["yesno", "overunder", "multi"] as const).map((k) => (
          <Button
            key={k}
            small
            color={kind === k ? C.ink : C.tile}
            textColor={kind === k ? "#fff" : C.ink}
            label={k === "yesno" ? "Yes/No" : k === "overunder" ? "Over/Under" : "Multiple"}
            onPress={() => setKind(k)}
          />
        ))}
      </View>
      {kind === "overunder" ? (
        <TextInput value={line} onChangeText={setLine} placeholder="Line, e.g. 3.5" keyboardType="decimal-pad" style={input} />
      ) : null}
      {kind === "multi" ? (
        <TextInput value={opts} onChangeText={setOpts} placeholder="Options, comma separated" placeholderTextColor={C.faint} style={input} />
      ) : null}
      <Button small label="Add bet" color={C.yes} onPress={submit} disabled={!question.trim()} />
    </View>
  );
}

type Draft = { question: string; kind: "yesno" | "overunder"; line?: number; keep: boolean };

function AiDrafts({ roundId, passcode }: { roundId: Id<"rounds">; passcode: string }) {
  const draft = useAction(api.ai.draftBets);
  const add = useMutation(api.admin.addBet);
  const [open, setOpen] = useState(false);
  const [text, setText] = useState("");
  const [drafts, setDrafts] = useState<Draft[]>([]);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  if (!open) return <Button small color={C.goldSoft} textColor={C.ink} label="✦ Draft bets with AI" onPress={() => setOpen(true)} />;
  const kept = drafts.filter((d) => d.keep && d.question.trim());
  return (
    <View style={{ gap: 8, borderTopWidth: 1.5, borderTopColor: C.line, paddingTop: 10 }}>
      <Text style={s.label}>Draft bets with AI</Text>
      <TextInput
        value={text}
        onChangeText={setText}
        multiline
        placeholder="Paste a transcript, Granola notes, or what's going on in the room"
        placeholderTextColor={C.faint}
        style={[input, { minHeight: 110, textAlignVertical: "top" }]}
      />
      <Button
        small
        label={busy ? "Drafting…" : "Draft 6 bets"}
        disabled={busy || text.trim().length < 10}
        onPress={async () => {
          setBusy(true);
          setMsg(null);
          try {
            const out = await draft({ passcode, text });
            setDrafts(out.map((d) => ({ ...d, keep: true })));
            if (!out.length) setMsg("The model returned no usable bets. Try more detail.");
          } catch (e) {
            setMsg(String((e as { data?: string }).data ?? (e as Error).message));
          } finally {
            setBusy(false);
          }
        }}
      />
      {drafts.map((d, i) => (
        <View key={i} style={{ flexDirection: "row", gap: 6, alignItems: "center" }}>
          <Pressable
            onPress={() => setDrafts(drafts.map((x, j) => (j === i ? { ...x, keep: !x.keep } : x)))}
            style={{ width: 30, height: 30, borderRadius: 8, backgroundColor: d.keep ? C.yes : C.tile, alignItems: "center", justifyContent: "center" }}
          >
            <Text style={{ color: "#fff", fontFamily: F.bodyBold }}>{d.keep ? "✓" : ""}</Text>
          </Pressable>
          <TextInput
            value={d.question}
            onChangeText={(t) => setDrafts(drafts.map((x, j) => (j === i ? { ...x, question: t } : x)))}
            style={[input, { flex: 1, paddingVertical: 6, fontSize: 14 }]}
          />
          <Text style={[s.sub, { width: 64 }]}>{d.kind === "yesno" ? "Yes/No" : "O/U " + d.line}</Text>
        </View>
      ))}
      {kept.length ? (
        <Button
          small
          color={C.yes}
          label={"Add " + kept.length + " to this drop"}
          onPress={async () => {
            try {
              for (const d of kept) await add({ passcode, roundId, question: d.question, kind: d.kind, line: d.line });
              setDrafts([]);
              setText("");
              setMsg("Added " + kept.length + " bets");
            } catch (e) {
              setMsg(String((e as { data?: string }).data ?? (e as Error).message));
            }
          }}
        />
      ) : null}
      {msg ? <Text style={s.sub}>{msg}</Text> : null}
    </View>
  );
}

function ChatDemo({ passcode, run }: { passcode: string; run: (f: () => Promise<unknown>) => Promise<void> }) {
  const st = useQuery(api.chat.demoStatus, { passcode });
  const replay = useMutation(api.chat.demoReplay);
  const restore = useMutation(api.chat.demoRestore);
  const revealAt = useMutation(api.chat.demoRevealAt);
  if (!st) return null;
  return (
    <Card style={{ gap: 10, backgroundColor: C.goldSoft }}>
      <Text style={s.h2}>Friend-group demo · {st.group.name}</Text>
      <Text style={[s.sub, tnum]}>
        Reveal {new Date(st.group.revealAt).toLocaleTimeString([], { hour: "numeric", minute: "2-digit", second: "2-digit" })} · {st.bets} bets · {st.settled} called · {st.members} people
      </Text>
      <View style={{ flexDirection: "row", gap: 8, flexWrap: "wrap" }}>
        <Button small label="Replay: reveal in 60s" onPress={() => run(() => replay({ passcode, inSeconds: 60 }))} />
        <Button small color={C.tile} textColor={C.ink} label="Replay: reveal now" onPress={() => run(() => replay({ passcode, inSeconds: 0 }))} />
        <Button small color={C.tile} textColor={C.ink} label="Reveal now (no reset)" onPress={() => run(() => revealAt({ passcode, at: Date.now() }))} />
        <Button small color={C.tile} textColor={C.ink} label="Reveal back to 5:00 PM" onPress={() => run(() => revealAt({ passcode, at: Date.UTC(2026, 10, 16, 1, 0, 0) }))} />
      </View>
      {st.snapshots.map((sn) => (
        <View key={sn._id} style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
          <Text style={[s.sub, { flex: 1 }]}>
            {new Date(sn.t).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })} · {sn.label}
          </Text>
          <Button small color={C.tile} textColor={C.ink} label="Restore" onPress={() => run(() => restore({ passcode, snapshotId: sn._id }))} />
        </View>
      ))}
    </Card>
  );
}
