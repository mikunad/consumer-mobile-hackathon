import SwiftUI

extension Color {
    init(hex: UInt32) {
        self.init(red: Double((hex >> 16) & 0xFF) / 255, green: Double((hex >> 8) & 0xFF) / 255, blue: Double(hex & 0xFF) / 255)
    }
}

enum Night {
    static let bg = Color(hex: 0x0B0D0C)
    static let card = Color(hex: 0x151917)
    static let line = Color(hex: 0x26302B)
    static let lime = Color(hex: 0xC6FF3D)
    static let red = Color(hex: 0xFF4D5E)
    static let gold = Color(hex: 0xF5C542)
    static let muted = Color(hex: 0x8A968F)
    static let text = Color.white

    static func mono(_ style: Font.TextStyle, _ weight: Font.Weight = .bold) -> Font {
        .system(style, design: .monospaced, weight: weight)
    }

    static func question(_ style: Font.TextStyle) -> Font {
        .system(style, weight: .bold)
    }

    static func side(_ i: Int) -> Color { i == 0 ? lime : red }
}

enum Theme {
    static let page = Night.bg
    static let pageUI = Night.bg
    static let ink = Night.text
    static let sub = Night.muted
    static let accent = Night.lime
    static let green = Night.lime
    static let red = Night.red
    static let bubble = Color(hex: 0xE9E9EB)
    static let gold = Night.gold
    static let line = Night.line
    static let yesSoft = Night.card
    static let avatars: [Color] = [0xE07B2E, 0x3E8E5E, 0x6E5BD3, 0xC44E7A, 0xA8714F, 0x4E86D6].map { Color(hex: $0) }

    static func verdict(_ i: Int) -> Color { i == 0 ? green : red }

    static func avatarColor(_ seed: String) -> Color {
        let sum = seed.unicodeScalars.reduce(0) { ($0 &* 31 &+ Int($1.value)) & 0xFFFF }
        return avatars[sum % avatars.count]
    }
}

struct NightSurface: ViewModifier {
    func body(content: Content) -> some View {
        content
            .foregroundStyle(Night.text)
            .environment(\.colorScheme, .dark)
            .tint(Night.lime)
    }
}

extension View {
    func nightSurface() -> some View { modifier(NightSurface()) }
}

struct PressBounce: ButtonStyle {
    var scale: CGFloat = 0.96

    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .scaleEffect(configuration.isPressed ? scale : 1)
            .animation(.spring(response: 0.28, dampingFraction: 0.5), value: configuration.isPressed)
    }
}

struct MonoLabel: View {
    let text: String
    var color: Color = Night.muted
    var style: Font.TextStyle = .caption2

    var body: some View {
        Text(text.uppercased())
            .font(Night.mono(style, .semibold))
            .tracking(0.9)
            .foregroundStyle(color)
            .lineLimit(1)
    }
}

struct LiveDot: View {
    var color: Color = Night.lime
    @State private var dim = false

    var body: some View {
        Circle()
            .fill(color)
            .frame(width: 7, height: 7)
            .shadow(color: color.opacity(dim ? 0.2 : 0.8), radius: dim ? 1 : 4)
            .opacity(dim ? 0.35 : 1)
            .scaleEffect(dim ? 0.8 : 1)
            .onAppear {
                withAnimation(.easeInOut(duration: 0.7).repeatForever(autoreverses: true)) { dim = true }
            }
            .accessibilityHidden(true)
    }
}

struct OddsBar: View {
    let label: String
    let pct: Double
    let index: Int

    var body: some View {
        let color = Night.side(index)
        let fraction = min(1, max(0, pct / 100))
        HStack {
            Text(label).font(.subheadline.weight(.semibold)).foregroundStyle(Night.text).lineLimit(1)
            Spacer(minLength: 8)
            Text("\(Int(pct.rounded()))%")
                .font(Night.mono(.subheadline))
                .foregroundStyle(color)
                .contentTransition(.numericText())
                .animation(.snappy, value: Int(pct.rounded()))
        }
        .padding(.horizontal, 12)
        .frame(minHeight: 38)
        .background(alignment: .leading) {
            GeometryReader { geo in
                LinearGradient(colors: [color.opacity(0.08), color.opacity(0.32)], startPoint: .leading, endPoint: .trailing)
                    .frame(width: geo.size.width * fraction)
                    .overlay(alignment: .trailing) { Rectangle().fill(color).frame(width: 2) }
                    .animation(.spring(response: 0.5, dampingFraction: 0.8), value: fraction)
            }
        }
        .background(Night.card)
        .clipShape(RoundedRectangle(cornerRadius: 10, style: .continuous))
    }
}

struct Avatar: View {
    var name: String?
    var emoji: String?
    var size: CGFloat = 32
    var ring: Color? = nil

    var body: some View {
        let seed = name ?? emoji ?? "?"
        ZStack {
            Circle().fill(Theme.avatarColor(seed))
            if let name, !name.isEmpty {
                Text(String(name.prefix(1)).uppercased())
                    .font(.system(size: size * 0.45, weight: .semibold))
                    .foregroundStyle(.white)
            } else {
                Image(systemName: "person.fill").font(.system(size: size * 0.45)).foregroundStyle(.white)
            }
        }
        .frame(width: size, height: size)
        .overlay(Circle().stroke(ring ?? .clear, lineWidth: 3).padding(-4))
        .shadow(color: (ring ?? .clear).opacity(0.5), radius: ring == nil ? 0 : 8)
    }
}

struct CIAvatar: View {
    var size: CGFloat = 32

    var body: some View {
        ZStack {
            Circle().fill(Color.black)
            Text("CI").font(.system(size: size * 0.38, weight: .heavy)).foregroundStyle(Theme.gold)
        }
        .frame(width: size, height: size)
        .overlay(Circle().stroke(Night.line, lineWidth: 1))
    }
}

struct AvatarStack: View {
    let people: [(name: String?, emoji: String?)]
    var size: CGFloat = 28

    var body: some View {
        HStack(spacing: -size * 0.3) {
            ForEach(Array(people.prefix(6).enumerated()), id: \.offset) { _, p in
                Avatar(name: p.name, emoji: p.emoji, size: size)
                    .overlay(Circle().stroke(Night.bg, lineWidth: 2))
            }
        }
    }
}

struct SheetHeader: View {
    var leading: String?
    var leadingAction: (() -> Void)?
    let title: String
    var trailing: String?
    var trailingBold = false
    var trailingAction: (() -> Void)?

    var body: some View {
        ZStack {
            Text(title)
                .font(Night.mono(.caption))
                .tracking(1)
                .textCase(.uppercase)
                .foregroundStyle(Night.text)
                .lineLimit(1)
                .padding(.horizontal, 80)
            HStack {
                if let leading { Button(leading) { leadingAction?() }.font(.body).foregroundStyle(Theme.accent) }
                Spacer()
                if let trailing {
                    if let trailingAction {
                        Button(trailing, action: trailingAction)
                            .font(.body.weight(trailingBold ? .semibold : .regular))
                            .foregroundStyle(Theme.accent)
                    } else {
                        Text(trailing)
                            .font(Night.mono(.caption2, .semibold))
                            .tracking(0.8)
                            .textCase(.uppercase)
                            .foregroundStyle(Theme.sub)
                    }
                }
            }
        }
        .padding(.bottom, 4)
    }
}

struct CardBox<Content: View>: View {
    var padding: CGFloat = 14
    @ViewBuilder var content: Content

    var body: some View {
        VStack(alignment: .leading, spacing: 10) { content }
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(padding)
            .background(RoundedRectangle(cornerRadius: 16, style: .continuous).fill(Night.card))
            .overlay(RoundedRectangle(cornerRadius: 16, style: .continuous).stroke(Night.line, lineWidth: 1))
            .nightSurface()
    }
}

struct InsetRow<Content: View>: View {
    var last = false
    @ViewBuilder var content: Content

    var body: some View {
        VStack(spacing: 0) {
            HStack { content }
                .padding(.horizontal, 16)
                .frame(minHeight: 44)
                .padding(.vertical, 6)
            if !last { Rectangle().fill(Night.line).frame(height: 1).padding(.leading, 16) }
        }
    }
}

struct InsetGroup<Content: View>: View {
    @ViewBuilder var content: Content

    var body: some View {
        VStack(spacing: 0) { content }
            .background(RoundedRectangle(cornerRadius: 16, style: .continuous).fill(Night.card))
            .clipShape(RoundedRectangle(cornerRadius: 16, style: .continuous))
            .overlay(RoundedRectangle(cornerRadius: 16, style: .continuous).stroke(Night.line, lineWidth: 1))
            .nightSurface()
    }
}

struct PrimaryButton: View {
    let title: String
    var color: Color = Theme.accent
    var busy = false
    let action: () -> Void

    var body: some View {
        Button(action: action) {
            ZStack {
                Text(title).opacity(busy ? 0 : 1)
                if busy { ProgressView().tint(.black) }
            }
            .font(.system(.headline, weight: .heavy))
            .tracking(0.3)
            .frame(maxWidth: .infinity, minHeight: 50)
            .background(RoundedRectangle(cornerRadius: 14, style: .continuous).fill(color))
            .foregroundStyle(Color.black)
            .shadow(color: color.opacity(0.35), radius: 15)
        }
        .buttonStyle(PressBounce(scale: 0.97))
        .disabled(busy)
    }
}

struct SoftButton: View {
    let title: String
    let action: () -> Void

    var body: some View {
        Button(action: action) {
            Text(title)
                .font(.body.weight(.semibold))
                .frame(maxWidth: .infinity, minHeight: 44)
                .background(RoundedRectangle(cornerRadius: 12, style: .continuous).fill(Night.card))
                .overlay(RoundedRectangle(cornerRadius: 12, style: .continuous).stroke(Night.line, lineWidth: 1))
                .foregroundStyle(Theme.accent)
        }
        .buttonStyle(PressBounce())
    }
}

struct ErrorText: View {
    let text: String?

    var body: some View {
        if let text {
            Text(text).font(.footnote.weight(.medium)).foregroundStyle(Theme.red)
        }
    }
}

struct SectionTitle: View {
    let text: String

    var body: some View {
        Text(text.uppercased())
            .font(Night.mono(.caption2, .semibold))
            .tracking(0.9)
            .foregroundStyle(Theme.sub)
            .padding(.leading, 16)
            .padding(.top, 6)
    }
}

struct Footnote: View {
    let text: String

    var body: some View {
        Text(text).font(.footnote).foregroundStyle(Theme.sub).padding(.horizontal, 16)
    }
}

struct Chip: View {
    let title: String
    let on: Bool
    var color: Color = Theme.accent
    let action: () -> Void

    var body: some View {
        Button(action: action) {
            Text(title)
                .font(Night.mono(.subheadline))
                .lineLimit(1)
                .padding(.horizontal, 14)
                .padding(.vertical, 9)
                .background(RoundedRectangle(cornerRadius: 10, style: .continuous).fill(on ? color : Night.card))
                .overlay(RoundedRectangle(cornerRadius: 10, style: .continuous).stroke(on ? color : Night.line, lineWidth: 1))
                .foregroundStyle(on ? Color.black : Night.text)
                .animation(.snappy, value: on)
        }
        .buttonStyle(PressBounce(scale: 0.92))
    }
}

struct QuestionBubble: View {
    let text: String

    var body: some View {
        Text(text)
            .font(Night.question(.body))
            .tracking(-0.2)
            .foregroundStyle(Night.text)
            .padding(.horizontal, 14).padding(.vertical, 10)
            .background(RoundedRectangle(cornerRadius: 18, style: .continuous).fill(Night.card))
            .overlay(RoundedRectangle(cornerRadius: 18, style: .continuous).stroke(Night.line, lineWidth: 1))
            .fixedSize(horizontal: false, vertical: true)
    }
}
