import SwiftUI

struct BoardView: View {
    @EnvironmentObject var model: AppModel
    let roomId: String
    @State private var board: BoardResult?
    @State private var loaded = false
    @State private var error: String?

    var body: some View {
        Group {
            SheetHeader(leading: "Back", leadingAction: { model.home() }, title: board?.room.name ?? "Board")
            if let board {
                Text("Today's standings").font(Night.question(.largeTitle)).tracking(-0.6)
                SectionTitle(text: "Leaderboard")
                VStack(spacing: 8) {
                    ForEach(Array(board.rows.enumerated()), id: \.element.id) { index, row in
                        let you = row.id == model.me?.user._id
                        HStack(spacing: 12) {
                            Text("\(index + 1)").font(Night.mono(.subheadline)).foregroundStyle(Theme.sub).frame(width: 20)
                            Avatar(name: row.name, size: 32)
                            VStack(alignment: .leading, spacing: 1) {
                                HStack(spacing: 6) {
                                    Text(row.name).font(.body.weight(index == 0 || you ? .semibold : .regular))
                                    if row.streak > 0 { Text("🔥\(row.streak)").font(Night.mono(.caption)) }
                                }
                                Text("\(row.correct)/\(row.called) called").font(.footnote).foregroundStyle(Theme.sub)
                            }
                            Spacer()
                            Text(pts(row.points))
                                .font(Night.mono(.subheadline))
                                .foregroundStyle(Night.lime)
                                .contentTransition(.numericText())
                                .animation(.snappy, value: row.points)
                        }
                        .padding(.horizontal, 14)
                        .frame(minHeight: 56)
                        .background(RoundedRectangle(cornerRadius: 14, style: .continuous).fill(Night.card))
                        .overlay(RoundedRectangle(cornerRadius: 14, style: .continuous).stroke(you ? Night.lime : Night.line, lineWidth: 1))
                        .shadow(color: Night.lime.opacity(you ? 0.25 : 0), radius: 9)
                    }
                }
                PrimaryButton(title: "Send leaderboard") { model.send(Cards.board(board, session: nil)) }
                Footnote(text: "The card shows the top 3 names and points to this chat.")
            } else if loaded && error == nil {
                CardBox { Text("This leaderboard is for another group").font(.headline) }
            } else if error == nil {
                ProgressView().frame(maxWidth: .infinity).padding(40)
            }
            ErrorText(text: error)
        }
        .nightSurface()
        .task { await load() }
    }

    private func load() async {
        guard let token = model.token else { return }
        do {
            board = try await API.query("ext:board", ["token": token, "roomId": roomId])
        } catch {
            self.error = error.localizedDescription
        }
        loaded = true
    }
}
