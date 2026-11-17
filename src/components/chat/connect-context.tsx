import { ScrollView, Text, View } from "react-native";
import { C } from "@/lib/theme";
import { Button, Wordmark, s } from "@/components/ui";

export function ConnectContext({ onDone }: { onDone: () => void }) {
  return (
    <ScrollView style={s.screen} contentContainerStyle={[s.column, { paddingTop: 56, paddingBottom: 32, gap: 20 }]}>
      <Wordmark size={26} />
      <View style={{ gap: 12 }}>
        <Text style={s.h1}>Start with your own words.</Text>
        <Text style={[s.body, { color: C.sub, lineHeight: 24 }]}>
          Called It does not read your chats, contacts, photos, or screenshots. This legacy preview does not request access to them.
        </Text>
        <Text style={[s.body, { color: C.sub, lineHeight: 24 }]}>
          The iOS beta is being prepared around templates, eligible past group bets, and optional context you type yourself. There is no on-device model here.
        </Text>
        <Text style={[s.body, { color: C.sub, lineHeight: 24 }]}>
          Hosted AI suggestions require separate consent before typed context is sent to a provider. This screen does not enable that service or upload any context.
        </Text>
      </View>
      <Button label="Continue" onPress={onDone} color={C.ink} />
    </ScrollView>
  );
}
