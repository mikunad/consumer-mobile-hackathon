import { ReactNode, useCallback, useEffect, useMemo, useState } from "react";
import { Animated, Easing, PanResponder, Pressable, Text, View } from "react-native";
import { I, t } from "./ios";

const DOTS = 90;

function Particles({ width, height }: { width: number; height: number }) {
  const [phases] = useState(() => [0, 1, 2].map(() => new Animated.Value(0)));
  useEffect(() => {
    const loops = phases.map((p, i) =>
      Animated.loop(
        Animated.sequence([
          Animated.timing(p, { toValue: 1, duration: 900 + i * 350, easing: Easing.inOut(Easing.quad), useNativeDriver: true }),
          Animated.timing(p, { toValue: 0, duration: 900 + i * 350, easing: Easing.inOut(Easing.quad), useNativeDriver: true }),
        ]),
      ),
    );
    loops.forEach((l) => l.start());
    return () => loops.forEach((l) => l.stop());
  }, [phases]);
  const dots = useMemo(
    () =>
      Array.from({ length: DOTS }, (_, i) => ({
        x: ((i * 37 + 11) % DOTS) / DOTS * width,
        y: ((i * 53 + 7) % DOTS) / DOTS * height,
        r: 1 + (i % 10) / 10 * 1.8,
        g: i % 3,
        dx: ((i * 7) % 17 - 8) / 2,
        dy: ((i * 11) % 17 - 8) / 2,
        dark: i % 3 !== 0,
      })),
    [width, height],
  );
  return (
    <>
      {dots.map((d, i) => {
        const p = phases[d.g];
        return (
          <Animated.View
            key={i}
            style={{
              position: "absolute",
              left: d.x,
              top: d.y,
              width: d.r * 2,
              height: d.r * 2,
              borderRadius: d.r,
              backgroundColor: d.dark ? "#3A3A3C" : "#8E8E93",
              opacity: p.interpolate({ inputRange: [0, 1], outputRange: i % 2 ? [0.15, 0.95] : [0.9, 0.2] }),
              transform: [
                { translateX: p.interpolate({ inputRange: [0, 1], outputRange: [0, d.dx] }) },
                { translateY: p.interpolate({ inputRange: [0, 1], outputRange: [0, d.dy] }) },
              ],
            }}
          />
        );
      })}
    </>
  );
}

export function InvisibleInk({
  name,
  canRub,
  children,
  width = 250,
  height = 64,
  hint,
}: {
  name: string;
  canRub: boolean;
  children?: ReactNode;
  width?: number;
  height?: number;
  hint: string;
}) {
  const [gone, setGone] = useState(false);
  const [tip, setTip] = useState(false);
  const [fade] = useState(() => new Animated.Value(1));
  const uncover = useCallback(() => {
    Animated.timing(fade, { toValue: 0, duration: 700, useNativeDriver: true }).start(() => setGone(true));
  }, [fade]);
  const pan = useMemo(
    () =>
      PanResponder.create({
        onStartShouldSetPanResponder: () => true,
        onMoveShouldSetPanResponder: () => true,
        onPanResponderGrant: () => {
          if (!canRub) setTip(true);
        },
        onPanResponderMove: (_, gesture) => {
          if (!canRub) return;
          const distance = Math.hypot(gesture.dx, gesture.dy);
          fade.setValue(Math.max(0.15, 1 - distance / 70));
          if (distance > 50) uncover();
        },
        onPanResponderRelease: (_, gesture) => {
          if (canRub && Math.hypot(gesture.dx, gesture.dy) <= 50) Animated.timing(fade, { toValue: 1, duration: 300, useNativeDriver: true }).start();
          setTimeout(() => setTip(false), 1600);
        },
      }),
    [canRub, fade, uncover],
  );
  if (gone && children) return <>{children}</>;
  return (
    <View>
      <View>
      {children ? <View style={{ opacity: 0 }}>{children}</View> : <View style={{ width, height }} />}
      <Animated.View
        {...pan.panHandlers}
        style={{ position: "absolute", left: 0, top: 0, right: 0, bottom: 0, borderRadius: 18, overflow: "hidden", backgroundColor: "#E9E9EB", opacity: fade, alignItems: "flex-start", justifyContent: "flex-start", padding: 12 }}
      >
        <Particles width={width} height={height} />
        <Text style={t(17, "600", "#0A7AFF")}>{name}</Text>
      </Animated.View>
      </View>
      {tip || canRub || hint ? (
        <Pressable onLongPress={canRub ? uncover : undefined}>
          <Text style={[t(11, "500", I.secondary), { marginTop: 4, marginLeft: 4 }]}>{canRub ? "Rub to reveal" : hint}</Text>
        </Pressable>
      ) : null}
    </View>
  );
}
