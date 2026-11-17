import { useState } from "react";
import { Text, TextInput, View } from "react-native";
import { useMutation } from "convex/react";
import { api } from "@convex/_generated/api";
import { newToken, useIdentity } from "@/lib/identity";
import { isSingleEmoji, lastGrapheme } from "@/lib/emoji";
import { C, F } from "@/lib/theme";
import { Button, Wordmark, s } from "@/components/ui";

export function ChatJoin() {
  const { token, setToken } = useIdentity();
  const join = useMutation(api.users.join);
  const [name, setName] = useState("");
  const [emoji, setEmoji] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const clean = name.replace(/^@+/, "").trim();
  const ready = clean.length >= 2 && isSingleEmoji(emoji);
  const submit = async () => {
    if (!ready || busy) return;
    setBusy(true);
    setErr(null);
    const t = token ?? newToken();
    try {
      await join({ name: clean, emoji, token: t });
      setToken(t);
    } catch (e) {
      setErr(String((e as { data?: string }).data ?? (e as Error).message));
    } finally {
      setBusy(false);
    }
  };
  return (
    <View style={[s.screen, s.column, { paddingTop: 72, gap: 22 }]}>
      <Wordmark size={24} />
      <View style={{ gap: 6 }}>
        <Text style={[s.h1, { fontSize: 40, lineHeight: 42 }]}>Your friends are already talking about you.</Text>
        <Text style={s.sub}>Might as well get in on it.</Text>
      </View>
      <View style={{ flexDirection: "row", gap: 10, alignItems: "center" }}>
        <View style={{ flex: 1, flexDirection: "row", alignItems: "center", backgroundColor: C.card, borderRadius: 14, borderWidth: 1.5, borderColor: C.line, paddingHorizontal: 14, height: 64 }}>
          <Text style={{ fontFamily: F.display, fontSize: 24, color: C.faint }}>@</Text>
          <TextInput
            value={clean}
            onChangeText={(t) => setName(t.replace(/\s+/g, "_").toLowerCase())}
            placeholder="username"
            placeholderTextColor={C.faint}
            autoCapitalize="none"
            autoCorrect={false}
            maxLength={20}
            onSubmitEditing={submit}
            style={{ flex: 1, fontFamily: F.display, fontSize: 24, color: C.ink, paddingLeft: 2, height: 60 }}
          />
        </View>
        <TextInput
          value={emoji}
          onChangeText={(t) => {
            const g = lastGrapheme(t);
            setEmoji(isSingleEmoji(g) ? g : "");
          }}
          caretHidden
          autoCorrect={false}
          accessibilityLabel="Your emoji"
          style={{
            width: 64,
            height: 64,
            borderRadius: 14,
            borderWidth: 2,
            borderStyle: emoji ? "solid" : "dashed",
            borderColor: emoji ? C.ink : C.faint,
            backgroundColor: emoji ? C.goldSoft : C.card,
            textAlign: "center",
            fontSize: 34,
            color: C.ink,
          }}
        />
      </View>
      <Text style={[s.sub, { marginTop: -12, textAlign: "right" }]}>tap the square, then 😀 on your keyboard</Text>
      {err ? <Text style={{ color: C.no, fontFamily: F.bodyMed }}>{err}</Text> : null}
      <Button label={busy ? "Joining…" : "I'm in"} disabled={!ready || busy} onPress={submit} />
      <Text style={[s.sub, { textAlign: "center", fontSize: 13 }]}>Joining means you&apos;re OK getting roasted by your crew. You can veto any bet about you at the reveal.</Text>
    </View>
  );
}
