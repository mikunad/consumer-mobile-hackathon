import { ReactNode, useEffect, useRef, useState } from "react";
import { Animated, Easing, Pressable, StyleProp, Text, TextStyle, ViewStyle } from "react-native";
import { F } from "@/lib/theme";
import { fmt } from "@/lib/time";
import { SYS } from "./ios";

export const N = {
  bg: "#0B0D0C",
  card: "#151917",
  raised: "#1C221F",
  line: "#26302B",
  lime: "#C6FF3D",
  red: "#FF4D5E",
  gold: "#F5C542",
  blue: "#5AA9FF",
  mut: "#8A968F",
  text: "#FFFFFF",
};

export function nightOpt(kind: string, i: number) {
  if (kind === "multi") return [N.lime, N.blue, N.gold, N.red][i] ?? N.lime;
  return i === 0 ? N.lime : N.red;
}

export function nt(size: number, weight: TextStyle["fontWeight"] = "400", color: string = N.text): TextStyle {
  return { fontFamily: SYS, fontSize: size, fontWeight: weight, color, letterSpacing: size >= 20 ? -0.4 : -0.1 };
}

export function mono(size: number, color: string = N.text, bold = false): TextStyle {
  return { fontFamily: bold ? F.monoBold : F.mono, fontSize: size, color, fontVariant: ["tabular-nums"] };
}

export function label(color: string = N.mut): TextStyle {
  return { fontFamily: F.mono, fontSize: 11, color, letterSpacing: 1.4, textTransform: "uppercase" };
}

export function Ticker({ value, style, prefix = "", suffix = "", format = fmt, duration = 700 }: { value: number; style?: StyleProp<TextStyle>; prefix?: string; suffix?: string; format?: (n: number) => string; duration?: number }) {
  const [shown, setShown] = useState(value);
  const from = useRef(value);
  useEffect(() => {
    const start = from.current;
    if (start === value) return;
    const t0 = Date.now();
    let raf = 0;
    const step = () => {
      const p = Math.min(1, (Date.now() - t0) / duration);
      const v = start + (value - start) * (1 - Math.pow(1 - p, 3));
      from.current = v;
      setShown(v);
      if (p < 1) raf = requestAnimationFrame(step);
    };
    raf = requestAnimationFrame(step);
    return () => cancelAnimationFrame(raf);
  }, [value, duration]);
  return <Text style={style}>{prefix + format(Math.round(shown)) + suffix}</Text>;
}

export function Bounce({ onPress, disabled, style, children, accessibilityLabel }: { onPress?: () => void; disabled?: boolean; style?: StyleProp<ViewStyle>; children: ReactNode; accessibilityLabel?: string }) {
  const s = useRef(new Animated.Value(1)).current;
  const to = (v: number) => Animated.spring(s, { toValue: v, useNativeDriver: true, speed: 40, bounciness: v === 1 ? 14 : 0 }).start();
  return (
    <Pressable onPress={onPress} disabled={disabled} onPressIn={() => to(0.94)} onPressOut={() => to(1)} accessibilityRole="button" accessibilityLabel={accessibilityLabel}>
      <Animated.View style={[style, { transform: [{ scale: s }] }]}>{children}</Animated.View>
    </Pressable>
  );
}

export function LiveDot({ color = N.lime }: { color?: string }) {
  const o = useRef(new Animated.Value(1)).current;
  useEffect(() => {
    const loop = Animated.loop(
      Animated.sequence([
        Animated.timing(o, { toValue: 0.2, duration: 700, easing: Easing.inOut(Easing.quad), useNativeDriver: true }),
        Animated.timing(o, { toValue: 1, duration: 700, easing: Easing.inOut(Easing.quad), useNativeDriver: true }),
      ]),
    );
    loop.start();
    return () => loop.stop();
  }, [o]);
  return <Animated.View style={{ width: 6, height: 6, borderRadius: 3, backgroundColor: color, opacity: o }} />;
}

export function Glow({ children, color = N.lime, style }: { children: ReactNode; color?: string; style?: StyleProp<ViewStyle> }) {
  const a = useRef(new Animated.Value(0)).current;
  useEffect(() => {
    Animated.spring(a, { toValue: 1, useNativeDriver: true, speed: 12, bounciness: 10 }).start();
  }, [a]);
  return (
    <Animated.View
      style={[
        { shadowColor: color, shadowOpacity: 0.55, shadowRadius: 24, shadowOffset: { width: 0, height: 0 }, opacity: a, transform: [{ scale: a.interpolate({ inputRange: [0, 1], outputRange: [0.8, 1] }) }] },
        style,
      ]}
    >
      {children}
    </Animated.View>
  );
}
