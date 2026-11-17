import { useEffect, useState, useSyncExternalStore } from "react";
import { Animated, Platform, Pressable, Share, Text, View, StyleProp, ViewStyle } from "react-native";
import AsyncStorage from "@react-native-async-storage/async-storage";
import { C, F, tnum } from "@/lib/theme";
import { fmt } from "@/lib/time";
import { SITE_URL } from "@/lib/convex";

export type TileState = "won" | "lost" | "skip" | "pending" | "void" | "hidden" | "empty";

const LETTERS = "CALLED".split("");
const SKIP = "#A59E92";
const native = Platform.OS !== "web";

export function tileOf(status: string, winningOption: number | undefined, myOption: number | undefined): TileState {
  if (status === "refunded") return "void";
  if (status !== "settled") return "pending";
  if (myOption === undefined) return "skip";
  return myOption === winningOption ? "won" : "lost";
}

export function isResolved(status: string) {
  return status === "settled" || status === "refunded";
}

export function padTiles(tiles: TileState[]) {
  return LETTERS.map((_, i) => tiles[i] ?? "empty");
}

export function signed(n: number) {
  return (n > 0 ? "+" : n < 0 ? "\u2212" : "") + fmt(Math.abs(n));
}

const EMOJI: Record<TileState, string> = {
  won: "\u{1F7E9}",
  lost: "\u{1F7E5}",
  skip: "\u2B1C",
  void: "\u2B1C",
  pending: "\u2B1B",
  hidden: "\u2B1B",
  empty: "\u2B1C",
};

export function shareText(title: string, tiles: TileState[], net: number) {
  const row = padTiles(tiles).map((t) => EMOJI[t]).join("");
  return "Called It \u00B7 " + title + "  " + row + "  " + signed(net) + " pts\n" + SITE_URL;
}

export async function shareDrop(text: string) {
  if (Platform.OS === "web") {
    const nav = (globalThis as { navigator?: { clipboard?: { writeText: (t: string) => Promise<void> } } }).navigator;
    if (nav?.clipboard) {
      try {
        await nav.clipboard.writeText(text);
        return "copied" as const;
      } catch {}
    }
  }
  await Share.share({ message: text });
  return "shared" as const;
}

export function ShareButton({
  text,
  label = "Copy my drop",
  dark = true,
  small,
  style,
}: {
  text: string;
  label?: string;
  dark?: boolean;
  small?: boolean;
  style?: StyleProp<ViewStyle>;
}) {
  const [done, setDone] = useState(false);
  useEffect(() => {
    if (!done) return;
    const id = setTimeout(() => setDone(false), 1800);
    return () => clearTimeout(id);
  }, [done]);
  return (
    <Pressable
      onPress={async () => {
        if ((await shareDrop(text)) === "copied") setDone(true);
      }}
      style={({ pressed }) => [
        {
          backgroundColor: dark ? C.ink : "transparent",
          borderWidth: dark ? 0 : 1.5,
          borderColor: C.line,
          borderRadius: small ? 10 : 14,
          paddingVertical: small ? 7 : 15,
          paddingHorizontal: small ? 11 : 22,
          alignItems: "center",
          transform: [{ scale: pressed ? 0.97 : 1 }],
        },
        style,
      ]}
    >
      <Text style={{ fontFamily: F.bodyBold, fontSize: small ? 13 : 16, color: dark ? "#fff" : C.ink }}>
        {done ? "Copied" : label}
      </Text>
    </Pressable>
  );
}

const KEY = "calledit.revealed";
let revealed: Set<string> | null = null;
let loading = false;
const listeners = new Set<() => void>();
const notify = () => listeners.forEach((l) => l());

function load() {
  if (revealed || loading) return;
  loading = true;
  AsyncStorage.getItem(KEY)
    .then((raw) => {
      revealed = new Set<string>(raw ? JSON.parse(raw) : []);
    })
    .catch(() => {
      revealed = new Set<string>();
    })
    .finally(notify);
}

export function markRevealed(ids: string[]) {
  const next = new Set(revealed ?? []);
  let changed = false;
  for (const id of ids)
    if (!next.has(id)) {
      next.add(id);
      changed = true;
    }
  if (!changed) return;
  revealed = next;
  AsyncStorage.setItem(KEY, JSON.stringify([...next]));
  notify();
}

export function useRevealed() {
  load();
  return useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    () => revealed,
    () => revealed,
  );
}

type Palette = { bg: string; border: string; fg: string };

function palette(state: TileState, dark: boolean): Palette {
  switch (state) {
    case "won":
      return { bg: C.yes, border: C.yes, fg: "#fff" };
    case "lost":
      return { bg: C.no, border: C.no, fg: "#fff" };
    case "skip":
      return { bg: SKIP, border: SKIP, fg: "#fff" };
    case "void":
      return dark ? { bg: "#34312C", border: "#34312C", fg: "#6E685F" } : { bg: C.tile, border: C.tile, fg: C.faint };
    case "hidden":
      return dark ? { bg: C.gold, border: C.gold, fg: C.ink } : { bg: C.card, border: "#8F887C", fg: C.ink };
    case "pending":
      return dark ? { bg: "transparent", border: "#4A463F", fg: "#8A8378" } : { bg: C.card, border: C.line, fg: C.sub };
    case "empty":
      return dark ? { bg: "transparent", border: "#36332E", fg: "#4A463F" } : { bg: "transparent", border: C.line, fg: C.line };
  }
}

export function Tile({
  letter,
  state,
  size = 34,
  delay = 0,
  from,
  dark = false,
}: {
  letter: string;
  state: TileState;
  size?: number;
  delay?: number;
  from?: TileState;
  dark?: boolean;
}) {
  const [shown, setShown] = useState<TileState>(from ?? state);
  const [flip] = useState(() => new Animated.Value(1));
  const [pop] = useState(() => new Animated.Value(1));
  useEffect(() => {
    if (state === shown) return;
    const anim = Animated.sequence([
      Animated.delay(delay),
      Animated.timing(flip, { toValue: 0, duration: 170, useNativeDriver: native }),
    ]);
    anim.start(({ finished }) => {
      if (!finished) return;
      setShown(state);
      Animated.parallel([
        Animated.timing(flip, { toValue: 1, duration: 170, useNativeDriver: native }),
        Animated.sequence([
          Animated.timing(pop, { toValue: 1.08, duration: 120, useNativeDriver: native }),
          Animated.timing(pop, { toValue: 1, duration: 140, useNativeDriver: native }),
        ]),
      ]).start();
    });
    return () => anim.stop();
  }, [state, shown, delay, flip, pop]);
  const p = palette(shown, dark);
  return (
    <Animated.View
      style={{
        width: size,
        height: size * 1.08,
        borderRadius: size * 0.18,
        backgroundColor: p.bg,
        borderWidth: Math.max(1.5, size * 0.055),
        borderColor: p.border,
        alignItems: "center",
        justifyContent: "center",
        transform: [{ scaleY: flip }, { scale: pop }],
      }}
    >
      <Text style={{ fontFamily: F.display, fontSize: size * 0.56, color: p.fg, marginTop: -size * 0.04 }}>{letter}</Text>
    </Animated.View>
  );
}

export function Scorecard({
  tiles,
  size = 34,
  gap,
  stagger,
  from,
  dark,
}: {
  tiles: TileState[];
  size?: number;
  gap?: number;
  stagger?: number;
  from?: TileState;
  dark?: boolean;
}) {
  return (
    <View style={{ flexDirection: "row", gap: gap ?? size * 0.14 }}>
      {padTiles(tiles).map((t, i) => (
        <Tile key={i} letter={LETTERS[i]} state={t} size={size} delay={stagger ? 250 + i * stagger : 0} from={from} dark={dark} />
      ))}
    </View>
  );
}

export function NetText({ net, size = 18, played = true }: { net: number; size?: number; played?: boolean }) {
  return (
    <Text style={[{ fontFamily: F.monoBold, fontSize: size, color: !played ? C.faint : net > 0 ? C.yes : net < 0 ? C.no : C.sub, letterSpacing: -0.5 }, tnum]}>
      {played ? signed(net) : "\u2014"}
    </Text>
  );
}

export const LETTER_AT = LETTERS;
