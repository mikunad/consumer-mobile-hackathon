import SwiftUI

struct InkNoise: View {
    var body: some View {
        TimelineView(.animation(minimumInterval: 1 / 15)) { timeline in
            Canvas { ctx, size in
                ctx.fill(Path(CGRect(origin: .zero, size: size)), with: .color(Night.bg))
                let t = timeline.date.timeIntervalSinceReferenceDate
                var rng = SeededRandom(seed: UInt64(t * 15))
                let count = Int(size.width * size.height / 18)
                for _ in 0..<count {
                    let x = CGFloat(rng.next() % 10_000) / 10_000 * size.width
                    let y = CGFloat(rng.next() % 10_000) / 10_000 * size.height
                    let shade = Double(rng.next() % 100) / 100
                    ctx.fill(Path(ellipseIn: CGRect(x: x, y: y, width: 1.4, height: 1.4)), with: .color(Color.white.opacity(0.15 + shade * 0.45)))
                }
                var drift = SeededRandom(seed: 7)
                for _ in 0..<Int(size.width * size.height / 90) {
                    let baseX = CGFloat(drift.next() % 10_000) / 10_000 * size.width
                    let baseY = CGFloat(drift.next() % 10_000) / 10_000 * size.height
                    let speed = 4 + Double(drift.next() % 100) / 100 * 10
                    let phase = Double(drift.next() % 628) / 100
                    let lime = drift.next() % 3 != 0
                    let x = (baseX + CGFloat(t * speed)).truncatingRemainder(dividingBy: max(size.width, 1))
                    let y = baseY + CGFloat(sin(t * 0.8 + phase) * 3)
                    let glow = 0.45 + 0.55 * abs(sin(t * 2 + phase))
                    let color = lime ? Night.lime.opacity(glow) : Color.white.opacity(glow * 0.8)
                    ctx.fill(Path(ellipseIn: CGRect(x: x, y: y, width: 2, height: 2)), with: .color(color))
                }
            }
        }
        .accessibilityHidden(true)
    }
}

struct SeededRandom {
    private var state: UInt64
    init(seed: UInt64) { state = seed &+ 0x9E3779B97F4A7C15 }
    mutating func next() -> UInt64 {
        state &+= 0x9E3779B97F4A7C15
        var z = state
        z = (z ^ (z >> 30)) &* 0xBF58476D1CE4E5B9
        z = (z ^ (z >> 27)) &* 0x94D049BB133111EB
        return z ^ (z >> 31)
    }
}

struct InkBubble: View {
    let name: String
    var height: CGFloat = 88

    var body: some View {
        ZStack(alignment: .topLeading) {
            InkNoise()
            Text("@\(name)")
                .font(Night.mono(.caption))
                .foregroundStyle(Night.lime)
                .padding(.horizontal, 10).padding(.vertical, 5)
                .background(Capsule().fill(Color.black.opacity(0.6)))
                .overlay(Capsule().stroke(Night.lime, lineWidth: 1))
                .shadow(color: Night.lime.opacity(0.4), radius: 8)
                .padding(.horizontal, 12).padding(.vertical, 10)
        }
        .frame(maxWidth: .infinity, minHeight: height, maxHeight: height)
        .clipShape(RoundedRectangle(cornerRadius: 18, style: .continuous))
        .overlay(RoundedRectangle(cornerRadius: 18, style: .continuous).stroke(Night.line, lineWidth: 1))
        .accessibilityElement(children: .ignore)
        .accessibilityLabel("Hidden bet about \(name)")
    }
}

func countdown(to ms: Double, from date: Date) -> String {
    let left = max(0, Int((ms / 1000 - date.timeIntervalSince1970).rounded(.up)))
    return String(format: "%d:%02d:%02d", left / 3600, (left % 3600) / 60, left % 60)
}

struct RubToReveal<Content: View>: View {
    let name: String
    @Binding var uncovered: Bool
    @ViewBuilder var content: Content
    @State private var strokes: [CGPoint] = []

    var body: some View {
        ZStack(alignment: .topLeading) {
            content
                .frame(maxWidth: .infinity, minHeight: 88, alignment: .topLeading)
                .accessibilityHidden(!uncovered)
            if !uncovered {
                InkBubble(name: name)
                    .mask {
                        Canvas { ctx, size in
                            ctx.fill(Path(CGRect(origin: .zero, size: size)), with: .color(.black))
                            ctx.blendMode = .destinationOut
                            for p in strokes {
                                ctx.fill(Path(ellipseIn: CGRect(x: p.x - 24, y: p.y - 24, width: 48, height: 48)), with: .color(.black))
                            }
                        }
                    }
                    .overlay(alignment: .bottomTrailing) {
                        if strokes.isEmpty {
                            Text("Rub to uncover").font(Night.mono(.caption2, .medium)).foregroundStyle(Night.muted).padding(10)
                        }
                    }
                    .highPriorityGesture(
                        DragGesture(minimumDistance: 0)
                            .onChanged { value in
                                strokes.append(value.location)
                                if strokes.count > 60 { withAnimation(.easeOut(duration: 0.4)) { uncovered = true } }
                            }
                    )
                    .transition(.opacity)
                    .accessibilityElement()
                    .accessibilityLabel("Covered by invisible ink")
                    .accessibilityAddTraits(.isButton)
                    .accessibilityAction { uncovered = true }
            }
        }
    }
}
