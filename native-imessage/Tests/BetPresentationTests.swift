import Foundation
import XCTest

final class BetPresentationTests: XCTestCase {
    private func date(_ text: String) throws -> Date {
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return try XCTUnwrap(formatter.date(from: text))
    }

    func testActualConfidenceControlRangeRejectsOutOfRangeAndNonfiniteValues() {
        XCTAssertEqual(ConfidenceInput.range, 1.0...100.0, "[NATIVE-CONFIDENCE-01]")
        for value in [1.0, 50.0, 100.0] {
            XCTAssertTrue(ConfidenceInput.range.contains(value), "[NATIVE-CONFIDENCE-02]")
        }
        for value in [0.0, 0.999, 100.001, Double.nan, Double.infinity, -Double.infinity] {
            XCTAssertFalse(ConfidenceInput.range.contains(value), "[NATIVE-CONFIDENCE-03]")
        }
    }

    func testActualConfidenceConversionPreservesNormalizedWireUnitsWithoutRewardMath() {
        for (control, wire) in [(1.0, 0.01), (25.0, 0.25), (50.0, 0.5), (99.0, 0.99), (100.0, 1.0)] {
            XCTAssertEqual(ConfidenceInput.normalized(control), wire, "[NATIVE-CONFIDENCE-04]")
            XCTAssertEqual(ConfidenceInput.controlValue(for: wire), control, "[NATIVE-CONFIDENCE-05]")
            XCTAssertEqual(ConfidenceInput.displayValue(for: wire), Int(control), "[NATIVE-CONFIDENCE-06]")
        }
        XCTAssertEqual(ConfidenceInput.normalized(50.5), 0.505, "[NATIVE-CONFIDENCE-07] conversion does not invent final reward rounding")
        XCTAssertEqual(ConfidenceInput.controlValue(for: 0.505), 50.5, "[NATIVE-CONFIDENCE-08]")
        XCTAssertEqual(ConfidenceInput.displayValue(for: 0.505), 51, "[NATIVE-CONFIDENCE-09] presentation rounding only, not a scoring oracle")
    }

    func testActualRestoredControlValueClampsToTheDisplayedRange() {
        for (wire, control) in [(-1.0, 1.0), (0.0, 1.0), (0.005, 1.0), (1.01, 100.0), (2.0, 100.0)] {
            XCTAssertEqual(ConfidenceInput.controlValue(for: wire), control, "[NATIVE-CONFIDENCE-10]")
        }
    }

    func testActualNonfiniteConfidenceKeepsConvexWireEncodingButCannotEnterControlRange() throws {
        for (value, expected) in [(Double.nan, "AAAAAAAA+H8="), (Double.infinity, "AAAAAAAA8H8="), (-Double.infinity, "AAAAAAAA8P8=")] {
            XCTAssertFalse(ConfidenceInput.range.contains(value), "[NATIVE-CONFIDENCE-11] nonfinite values cannot enter the actual confidence control")
            let arguments: [String: Any] = ["confidence": ConfidenceInput.normalized(value)]
            let encoded = try XCTUnwrap(try ConvexJSON.encode(arguments) as? [String: Any])
            let confidence = try XCTUnwrap(encoded["confidence"] as? [String: String])
            XCTAssertEqual(confidence, ["$float": expected], "[NATIVE-CONFIDENCE-12] canonical IEEE-754 little-endian wire value, not permission to place a pick")
            XCTAssertTrue(JSONSerialization.isValidJSONObject(encoded), "[NATIVE-CONFIDENCE-13]")
        }
    }

    func testActualPickReceiptRequiresSavedAndExactlyMatchingRequest() throws {
        let receipt = try NativeUnitFixture().decode(PickReceipt.self, ["saved": true, "option": 1, "confidence": 0.75, "updatedAt": 1_794_845_000_000.0])
        XCTAssertTrue(receipt.matches(option: 1, confidence: 0.75), "[NATIVE-RECEIPT-01]")
        XCTAssertFalse(receipt.matches(option: 0, confidence: 0.75), "[NATIVE-RECEIPT-02]")
        XCTAssertFalse(receipt.matches(option: 1, confidence: 0.74), "[NATIVE-RECEIPT-03]")
        XCTAssertFalse(receipt.matches(option: nil, confidence: 0.75), "[NATIVE-RECEIPT-04]")
        XCTAssertFalse(receipt.matches(option: 1, confidence: nil), "[NATIVE-RECEIPT-05]")
        XCTAssertFalse(receipt.matches(option: nil, confidence: nil), "[NATIVE-RECEIPT-06]")
        XCTAssertFalse(PickReceipt(saved: false, option: 1, confidence: 0.75, updatedAt: 1).matches(option: 1, confidence: 0.75), "[NATIVE-RECEIPT-07]")
    }

    func testActualPickReceiptRejectsNonfiniteServerTimeAndMalformedWireFields() {
        for time in [Double.nan, Double.infinity, -Double.infinity] {
            XCTAssertFalse(PickReceipt(saved: true, option: 0, confidence: 0.5, updatedAt: time).matches(option: 0, confidence: 0.5), "[NATIVE-RECEIPT-08]")
        }
        let fixture = NativeUnitFixture()
        let valid: [String: Any] = ["saved": true, "option": 0, "confidence": 0.5, "updatedAt": 1_794_845_000_000.0]
        for key in valid.keys {
            var missing = valid
            missing.removeValue(forKey: key)
            XCTAssertThrowsError(try fixture.decode(PickReceipt.self, missing), "[NATIVE-RECEIPT-09]")
            var wrongType = valid
            wrongType[key] = "SYNTHETIC_WRONG_TYPE"
            XCTAssertThrowsError(try fixture.decode(PickReceipt.self, wrongType), "[NATIVE-RECEIPT-10]")
        }
    }

    func testActualDefaultRevealUsesGroupTimezoneInsteadOfSuppliedCalendarTimezone() throws {
        var deviceCalendar = Calendar(identifier: .gregorian)
        deviceCalendar.timeZone = try XCTUnwrap(TimeZone(identifier: "Asia/Tokyo"))
        let now = try date("2026-11-16T18:30:00.000Z")
        let next = RevealSchedule.nextDefault(in: "America/Los_Angeles", after: now, calendar: deviceCalendar)
        XCTAssertEqual(next, try date("2026-11-17T04:00:00.000Z"), "[NATIVE-REVEAL-01]")
        XCTAssertEqual(RevealSchedule.nextDefault(in: "Asia/Tokyo", after: now), try date("2026-11-17T11:00:00.000Z"), "[NATIVE-REVEAL-02]")
        XCTAssertEqual(RevealSchedule.nextDefault(in: "Asia/Kolkata", after: try date("2026-11-16T12:00:00.000Z")), try date("2026-11-16T14:30:00.000Z"), "[NATIVE-REVEAL-03]")
    }

    func testActualDefaultRevealIsStrictlyFutureAtTheLocal20Boundary() throws {
        for (now, expected) in [
            ("2026-11-17T03:59:59.999Z", "2026-11-17T04:00:00.000Z"),
            ("2026-11-17T04:00:00.000Z", "2026-11-18T04:00:00.000Z"),
            ("2026-11-17T04:00:00.001Z", "2026-11-18T04:00:00.000Z")
        ] {
            XCTAssertEqual(RevealSchedule.nextDefault(in: "America/Los_Angeles", after: try date(now)), try date(expected), "[NATIVE-REVEAL-04]")
        }
    }

    func testActualDefaultRevealUsesCalendarDaysAcrossSpringAndFallDST() throws {
        for (now, expected) in [
            ("2026-03-08T04:00:00.000Z", "2026-03-09T03:00:00.000Z"),
            ("2026-11-01T03:00:00.000Z", "2026-11-02T04:00:00.000Z")
        ] {
            XCTAssertEqual(RevealSchedule.nextDefault(in: "America/Los_Angeles", after: try date(now)), try date(expected), "[NATIVE-REVEAL-05]")
        }
    }

    func testActualDefaultRevealRejectsAnUnknownGroupTimezone() throws {
        let now = try date("2026-11-16T18:30:00.000Z")
        XCTAssertNil(RevealSchedule.nextDefault(in: "Not/A_Timezone", after: now), "[NATIVE-REVEAL-06]")
        XCTAssertNil(RevealSchedule.nextDefault(in: "", after: now), "[NATIVE-REVEAL-07]")
    }
}
