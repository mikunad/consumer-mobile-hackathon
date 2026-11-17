import Foundation

private struct DTOField: CodingKey {
    let stringValue: String
    let intValue: Int? = nil
    init?(stringValue: String) { self.stringValue = stringValue }
    init?(intValue: Int) { return nil }
}

private func requireDTOKeys(_ decoder: Decoder, allowed: Set<String>) throws {
    let values = try decoder.container(keyedBy: DTOField.self)
    guard Set(values.allKeys.map(\.stringValue)).isSubset(of: allowed) else { throw NativeError.invalidLink }
}

struct Account: Decodable, Equatable { let id: String; let displayName: String }
struct PolicyStatus: Decodable {
    let status: String
    let version: String?
    let missing: [String]?
    var approved: Bool { status == "approved" && version != nil }
}
struct GroupSummary: Decodable, Identifiable {
    let id: String
    let name: String
    let timezone: String
    let alias: String
    let points: Double
    let streak: Int
}
struct AccountSnapshot: Decodable {
    let account: Account
    let expiresAt: Double
    let groups: [GroupSummary]
    let policy: PolicyStatus
}
struct GroupMember: Decodable, Identifiable {
    let accountId: String
    let alias: String
    let noBets: Bool
    var id: String { accountId }
}
struct GroupInvitation: Decodable, Identifiable {
    let id: String
    let groupName: String
    let expiresAt: Double
}
struct CardMetadata: Decodable {
    let url: String
    let caption: String
    let accessibilityLabel: String
    let subjectAlias: String
    let bettorCount: Int
    let bettorInitials: [String]

    enum CodingKeys: String, CodingKey { case url, caption, accessibilityLabel, subjectAlias, bettorCount, bettorInitials }
    init(from decoder: Decoder) throws {
        try requireDTOKeys(decoder, allowed: ["url", "caption", "accessibilityLabel", "subjectAlias", "bettorCount", "bettorInitials"])
        let values = try decoder.container(keyedBy: CodingKeys.self)
        url = try values.decode(String.self, forKey: .url)
        caption = try values.decode(String.self, forKey: .caption)
        accessibilityLabel = try values.decode(String.self, forKey: .accessibilityLabel)
        subjectAlias = try values.decode(String.self, forKey: .subjectAlias)
        bettorCount = try values.decode(Int.self, forKey: .bettorCount)
        bettorInitials = try values.decode([String].self, forKey: .bettorInitials)
        guard bettorCount >= 0, bettorInitials.count <= bettorCount else { throw NativeError.invalidLink }
    }
}
struct GroupGoal: Decodable {
    let id: String
    let label: String
    let targetPoints: Double
    let confirmedBy: [String]
    let state: String
    let progressPoints: Double
}
struct GroupBoard: Decodable {
    struct Row: Decodable, Identifiable {
        let accountId: String
        let alias: String
        let points: Double
        let streak: Int
        var id: String { accountId }
    }
    let groupId: String
    let rows: [Row]
    let goal: GroupGoal?
    let policy: PolicyStatus
}
struct ConfidencePick: Decodable {
    let option: Int
    let confidence: Double
    let riskPoints: Double?

    enum CodingKeys: String, CodingKey { case option, confidence, riskPoints }
    init(from decoder: Decoder) throws {
        try requireDTOKeys(decoder, allowed: ["option", "confidence", "riskPoints"])
        let values = try decoder.container(keyedBy: CodingKeys.self)
        option = try values.decode(Int.self, forKey: .option)
        confidence = try values.decode(Double.self, forKey: .confidence)
        riskPoints = try values.decodeIfPresent(Double.self, forKey: .riskPoints)
    }
}
struct PickReceipt: Decodable {
    let saved: Bool
    let option: Int
    let confidence: Double
    let updatedAt: Double
}
struct VisiblePick: Decodable, Identifiable {
    let accountId: String
    let alias: String
    let option: Int
    let confidence: Double
    let riskPoints: Double?
    var id: String { accountId }

    enum CodingKeys: String, CodingKey { case accountId, alias, option, confidence, riskPoints }
    init(from decoder: Decoder) throws {
        try requireDTOKeys(decoder, allowed: ["accountId", "alias", "option", "confidence", "riskPoints"])
        let values = try decoder.container(keyedBy: CodingKeys.self)
        accountId = try values.decode(String.self, forKey: .accountId)
        alias = try values.decode(String.self, forKey: .alias)
        option = try values.decode(Int.self, forKey: .option)
        confidence = try values.decode(Double.self, forKey: .confidence)
        riskPoints = try values.decodeIfPresent(Double.self, forKey: .riskPoints)
    }
}
struct BetDetails: Decodable {
    let question: String
    let format: String
    let options: [String]
    let line: Double?
    let canPick: Bool
    let canAnswer: Bool
    let canChallenge: Bool
    let answerDeadline: Double?
    let challengeDeadline: Double?
    let outcome: Int?
    let provisionalOutcome: Int?
    let myPick: ConfidencePick?
    let picks: [VisiblePick]
}
struct NativeBet: Decodable, Identifiable {
    enum Content {
        case sealed(canVeto: Bool)
        case unavailable
        case bet(BetDetails)
    }
    let serverTime: Double
    let groupId: String
    let betId: String
    let state: String
    let cutoffAt: Double
    let revealAt: Double
    let card: CardMetadata
    let content: Content
    var id: String { betId }

    enum CodingKeys: String, CodingKey {
        case serverTime, groupId, betId, state, cutoffAt, revealAt, card, view, canVeto
    }

    init(from decoder: Decoder) throws {
        let values = try decoder.container(keyedBy: CodingKeys.self)
        serverTime = try values.decode(Double.self, forKey: .serverTime)
        groupId = try values.decode(String.self, forKey: .groupId)
        betId = try values.decode(String.self, forKey: .betId)
        state = try values.decode(String.self, forKey: .state)
        cutoffAt = try values.decode(Double.self, forKey: .cutoffAt)
        revealAt = try values.decode(Double.self, forKey: .revealAt)
        card = try values.decode(CardMetadata.self, forKey: .card)
        guard serverTime.isFinite, cutoffAt.isFinite, revealAt.isFinite,
              ["open", "locked", "revealed", "provisional", "finalized", "voided"].contains(state) else {
            throw NativeError.invalidLink
        }
        let view = try values.decode(String.self, forKey: .view)
        let base: Set<String> = ["serverTime", "groupId", "betId", "state", "cutoffAt", "revealAt", "card", "view"]
        if view == "sealed" || view == "unavailable" {
            try requireDTOKeys(decoder, allowed: view == "sealed" ? base.union(["canVeto"]) : base)
            content = view == "sealed" ? .sealed(canVeto: try values.decode(Bool.self, forKey: .canVeto)) : .unavailable
        } else if view == "bet" {
            try requireDTOKeys(decoder, allowed: base.union(["question", "format", "options", "line", "canPick", "canAnswer", "canChallenge", "answerDeadline", "challengeDeadline", "outcome", "provisionalOutcome", "myPick", "picks"]))
            let details = try BetDetails(from: decoder)
            guard details.options.count == 2, details.options[0] != details.options[1],
                  ["yes_no", "over_under", "this_that"].contains(details.format),
                  details.format != "over_under" || details.line?.isFinite == true else { throw NativeError.invalidLink }
            guard details.myPick.map({ (0...1).contains($0.option) && $0.confidence.isFinite && (0...1).contains($0.confidence) }) ?? true,
                  details.picks.allSatisfy({ (0...1).contains($0.option) && $0.confidence.isFinite && (0...1).contains($0.confidence) }),
                  details.line?.isFinite ?? true else { throw NativeError.invalidLink }
            content = .bet(details)
        } else {
            throw NativeError.invalidLink
        }
    }
}
struct BetSuggestion: Decodable, Identifiable {
    let subjectId: String
    let question: String
    let format: String
    let options: [String]
    let line: Double?
    let source: String
    var id: String { subjectId + ":" + question }
}
struct SuggestionsResult: Decodable {
    let suggestions: [BetSuggestion]
    let processing: String
    let readsChat: Bool
}
struct PrivacySettings: Decodable {
    let noBets: Bool
    let blockedTopics: [String]
    let hostedAiConsent: Bool
    let copyDeletionCaveat: String
}
struct CreatedBet: Decodable { let betId: String; let groupId: String; let card: CardMetadata }

struct CreatorTurn: Decodable {
    let id: String
    let groupId: String
    let localDate: String
    let creatorId: String
    let subjectId: String
    let status: String
    let assignedAt: Double
    let passAt: Double
    let canPass: Bool
}
struct WeeklyRecap: Decodable {
    struct Row: Decodable, Identifiable {
        let accountId: String
        let alias: String
        let points: Double
        var id: String { accountId }
    }
    let id: String
    let groupId: String
    let startsAt: Double
    let endsAt: Double
    let rows: [Row]
    let policy: PolicyStatus
}
struct NotificationPreferences: Decodable { let enabled: Bool }
struct NotificationTap: Decodable {
    let kind: String
    let groupId: String?
    let locator: String?

    func validate() throws {
        guard ["turn", "reveal", "result", "recap"].contains(kind), groupId != nil || locator != nil else {
            throw NativeError.invalidLink
        }
        if let groupId { _ = try CardLocator(value: groupId) }
        if let locator { _ = try CardLocator(value: locator) }
    }
}
struct ProofReference: Decodable, Identifiable {
    let id: String
    let contentType: String
    let createdAt: Double
}
struct ConvexBytes: Decodable {
    let data: Data
    enum CodingKeys: String, CodingKey { case bytes = "$bytes" }
    init(from decoder: Decoder) throws {
        let values = try decoder.container(keyedBy: CodingKeys.self)
        let base64 = try values.decode(String.self, forKey: .bytes)
        guard let data = Data(base64Encoded: base64), data.count <= 512 * 1024 else { throw NativeError.invalidLink }
        self.data = data
    }
}
struct PrivateProof: Decodable {
    let id: String
    let contentType: String
    let createdAt: Double
    let bytes: ConvexBytes
}

struct ServerClock {
    let serverTime: Double
    let uptime: TimeInterval
    init(serverTime: Double, uptime: TimeInterval = ProcessInfo.processInfo.systemUptime) {
        self.serverTime = serverTime
        self.uptime = uptime
    }
    func now(uptime: TimeInterval = ProcessInfo.processInfo.systemUptime) -> Double {
        serverTime + max(0, uptime - self.uptime) * 1000
    }
}

extension Array {
    subscript(safe index: Int) -> Element? { indices.contains(index) ? self[index] : nil }
}
