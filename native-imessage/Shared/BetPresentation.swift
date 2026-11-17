import Foundation

enum ConfidenceInput {
    static let range = 1.0...100.0

    static func normalized(_ controlValue: Double) -> Double { controlValue / 100 }

    static func controlValue(for normalized: Double) -> Double { min(100, max(1, normalized * 100)) }

    static func displayValue(for normalized: Double) -> Int { Int((normalized * 100).rounded()) }
}

extension PickReceipt {
    func matches(option: Int?, confidence: Double?) -> Bool {
        saved && self.option == option && self.confidence == confidence && updatedAt.isFinite
    }
}

struct PickConfirmationState {
    struct Selection: Equatable {
        let option: Int
        let confidence: Double
    }

    private(set) var confirmed: Selection?
    private(set) var pending: Selection?
    private(set) var isUncertain = false

    init() {}

    func canEdit(serverCanPick: Bool) -> Bool { serverCanPick && confirmed == nil && pending == nil }

    mutating func begin(option: Int, confidence: Double) throws {
        guard (0...1).contains(option), confidence.isFinite, (0.01...1).contains(confidence) else {
            throw APIError(code: "INVALID_INPUT")
        }
        let selection = Selection(option: option, confidence: confidence)
        guard confirmed == nil, pending == nil || pending == selection else { throw APIError(code: "CONFLICT") }
        pending = selection
        isUncertain = false
    }

    mutating func accept(_ receipt: PickReceipt) throws {
        guard let expected = pending ?? confirmed, receipt.matches(option: expected.option, confidence: expected.confidence) else {
            throw APIError(code: "TRANSPORT")
        }
        confirmed = expected
        self.pending = nil
        isUncertain = false
    }

    mutating func resolve(_ pick: ConfidencePick?) {
        guard let pick else { return }
        confirmed = Selection(option: pick.option, confidence: pick.confidence)
        pending = nil
        isUncertain = false
    }

    mutating func markUncertain() {
        if pending != nil { isUncertain = true }
    }

    mutating func reject() {
        pending = nil
        isUncertain = false
    }
}

enum RevealSchedule {
    static func nextDefault(in timezoneID: String, after now: Date = Date(),
                            calendar: Calendar = Calendar(identifier: .gregorian)) -> Date? {
        guard let timezone = TimeZone(identifier: timezoneID) else { return nil }
        var calendar = calendar
        calendar.timeZone = timezone
        return calendar.nextDate(after: now, matching: DateComponents(hour: 20, minute: 0), matchingPolicy: .nextTime)
    }
}
