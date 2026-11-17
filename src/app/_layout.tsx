import { ScrollView, StyleSheet, Text, View } from "react-native";

export default function RootLayout() {
  return (
    <ScrollView style={styles.page} contentContainerStyle={styles.container}>
      <View style={styles.content}>
        <Text accessibilityRole="header" style={styles.title}>Called It</Text>
        <Text style={styles.description}>Private group predictions in Messages.</Text>
        <Text style={styles.body}>
          Friends make predictions about each other, pick a side, and come back for the reveal.
        </Text>
        <View style={styles.notice}>
          <Text style={styles.status}>The invited iOS beta is being prepared.</Text>
          <Text style={styles.body}>
            This page is informational only. Sign-in and predictions are not available on the web.
          </Text>
        </View>
      </View>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  page: { flex: 1, backgroundColor: "#F2F2F7" },
  container: { flexGrow: 1, justifyContent: "center", paddingHorizontal: 24, paddingVertical: 64 },
  content: { width: "100%", maxWidth: 480, alignSelf: "center", gap: 20 },
  title: { fontSize: 36, fontWeight: "700", color: "#1C1C1E" },
  description: { fontSize: 22, fontWeight: "600", lineHeight: 30, color: "#1C1C1E" },
  body: { fontSize: 17, lineHeight: 25, color: "#48484A" },
  notice: { backgroundColor: "#FFFFFF", borderRadius: 16, padding: 20, gap: 12 },
  status: { fontSize: 17, fontWeight: "600", lineHeight: 25, color: "#1C1C1E" },
});
