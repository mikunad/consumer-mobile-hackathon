import Foundation
import XCTest

final class PickConfirmationStateTests: XCTestCase {
    private func pick(_ option: Int = 0, _ confidence: Double = 0.25) throws -> ConfidencePick {
        try NativeUnitFixture().decode(ConfidencePick.self, ["option": option, "confidence": confidence])
    }

    private func receipt(_ option: Int = 0, _ confidence: Double = 0.25, saved: Bool = true, at: Double = 1_795_000_000_000) -> PickReceipt {
        PickReceipt(saved: saved, option: option, confidence: confidence, updatedAt: at)
    }

    func testActualInitialDraftStateDoesNotClaimServerConfirmation() {
        let state = PickConfirmationState()
        XCTAssertNil(state.confirmed, "[NATIVE-CONFIRM-01]")
        XCTAssertNil(state.pending, "[NATIVE-CONFIRM-02]")
        XCTAssertFalse(state.isUncertain, "[NATIVE-CONFIRM-03]")
        XCTAssertTrue(state.canEdit(serverCanPick: true), "[NATIVE-CONFIRM-04]")
        XCTAssertFalse(state.canEdit(serverCanPick: false), "[NATIVE-CONFIRM-05]")
    }

    func testActualBeginCreatesOnlyPendingSelectionAndDisablesEdits() throws {
        var state = PickConfirmationState()
        try state.begin(option: 0, confidence: 0.25)
        XCTAssertNil(state.confirmed, "[NATIVE-CONFIRM-06] beginning a request is not server success")
        XCTAssertEqual(state.pending, PickConfirmationState.Selection(option: 0, confidence: 0.25), "[NATIVE-CONFIRM-07]")
        XCTAssertFalse(state.canEdit(serverCanPick: true), "[NATIVE-CONFIRM-08]")
        XCTAssertFalse(state.canEdit(serverCanPick: false), "[NATIVE-CONFIRM-09]")
    }

    func testActualBeginRejectsInvalidChoiceConfidenceAndNonfiniteValuesWithoutStateChange() {
        for (option, confidence) in [(-1, 0.25), (2, 0.25), (0, 0), (0, 0.0099), (1, 1.0001), (1, Double.nan), (0, Double.infinity), (1, -Double.infinity)] {
            var state = PickConfirmationState()
            XCTAssertThrowsError(try state.begin(option: option, confidence: confidence), "[NATIVE-CONFIRM-10]") { error in
                XCTAssertEqual((error as? APIError)?.code, "INVALID_INPUT", "[NATIVE-CONFIRM-11]")
            }
            XCTAssertNil(state.pending, "[NATIVE-CONFIRM-12]")
            XCTAssertNil(state.confirmed, "[NATIVE-CONFIRM-13]")
            XCTAssertTrue(state.canEdit(serverCanPick: true), "[NATIVE-CONFIRM-14]")
        }
        for confidence in [0.01, 0.5, 1.0] {
            var state = PickConfirmationState()
            XCTAssertNoThrow(try state.begin(option: 1, confidence: confidence), "[NATIVE-CONFIRM-15]")
        }
    }

    func testActualChangedPendingRequestCannotReplaceChoiceOrConfidence() throws {
        for (option, confidence) in [(1, 0.25), (0, 0.75), (1, 1.0)] {
            var state = PickConfirmationState()
            try state.begin(option: 0, confidence: 0.25)
            XCTAssertThrowsError(try state.begin(option: option, confidence: confidence), "[NATIVE-CONFIRM-16]") { error in
                XCTAssertEqual((error as? APIError)?.code, "CONFLICT", "[NATIVE-CONFIRM-17]")
            }
            XCTAssertEqual(state.pending, PickConfirmationState.Selection(option: 0, confidence: 0.25), "[NATIVE-CONFIRM-18]")
            XCTAssertNil(state.confirmed, "[NATIVE-CONFIRM-19]")
        }
    }

    func testActualUnsolicitedReceiptCannotCreateLocalSuccess() {
        var state = PickConfirmationState()
        XCTAssertThrowsError(try state.accept(receipt()), "[NATIVE-CONFIRM-20]") { error in
            XCTAssertEqual((error as? APIError)?.code, "TRANSPORT", "[NATIVE-CONFIRM-21]")
        }
        XCTAssertNil(state.confirmed, "[NATIVE-CONFIRM-22]")
        XCTAssertNil(state.pending, "[NATIVE-CONFIRM-23]")
    }

    func testActualMatchingServerReceiptConfirmsOnlyThePendingSelection() throws {
        var state = PickConfirmationState()
        try state.begin(option: 0, confidence: 0.25)
        try state.accept(receipt())
        XCTAssertEqual(state.confirmed, PickConfirmationState.Selection(option: 0, confidence: 0.25), "[NATIVE-CONFIRM-24]")
        XCTAssertNil(state.pending, "[NATIVE-CONFIRM-25]")
        XCTAssertFalse(state.isUncertain, "[NATIVE-CONFIRM-26]")
        XCTAssertFalse(state.canEdit(serverCanPick: true), "[NATIVE-CONFIRM-27] stale capability cannot unlock server-confirmed state")
        XCTAssertFalse(state.canEdit(serverCanPick: false), "[NATIVE-CONFIRM-28]")
    }

    func testActualMismatchedUnsavedOrNonfiniteReceiptNeverClaimsConfirmation() throws {
        for response in [receipt(1), receipt(0, 0.75), receipt(saved: false), receipt(at: .nan), receipt(at: .infinity), receipt(at: -.infinity)] {
            var state = PickConfirmationState()
            try state.begin(option: 0, confidence: 0.25)
            XCTAssertThrowsError(try state.accept(response), "[NATIVE-CONFIRM-29]") { error in
                XCTAssertEqual((error as? APIError)?.code, "TRANSPORT", "[NATIVE-CONFIRM-30]")
            }
            XCTAssertNil(state.confirmed, "[NATIVE-CONFIRM-31]")
            XCTAssertEqual(state.pending, PickConfirmationState.Selection(option: 0, confidence: 0.25), "[NATIVE-CONFIRM-32]")
        }
    }

    func testActualAuthoritativeQueryRestoresPersistedPickDespiteErroneousCanPick() throws {
        var state = PickConfirmationState()
        state.resolve(try pick(1, 0.75))
        XCTAssertEqual(state.confirmed, PickConfirmationState.Selection(option: 1, confidence: 0.75), "[NATIVE-CONFIRM-33]")
        XCTAssertFalse(state.canEdit(serverCanPick: true), "[NATIVE-CONFIRM-34]")
        XCTAssertNil(state.pending, "[NATIVE-CONFIRM-35]")
    }

    func testActualQueryBeforeMatchingReceiptRaceKeepsCanonicalConfirmation() throws {
        var state = PickConfirmationState()
        try state.begin(option: 0, confidence: 0.25)
        state.resolve(try pick())
        XCTAssertNoThrow(try state.accept(receipt()), "[NATIVE-CONFIRM-36]")
        XCTAssertEqual(state.confirmed, PickConfirmationState.Selection(option: 0, confidence: 0.25), "[NATIVE-CONFIRM-37]")
        XCTAssertNil(state.pending, "[NATIVE-CONFIRM-38]")
    }

    func testActualQueryWinningDifferentConfirmationCannotBeOverwrittenByStaleReceipt() throws {
        var state = PickConfirmationState()
        try state.begin(option: 0, confidence: 0.25)
        state.resolve(try pick(1, 0.75))
        XCTAssertThrowsError(try state.accept(receipt()), "[NATIVE-CONFIRM-39]")
        XCTAssertEqual(state.confirmed, PickConfirmationState.Selection(option: 1, confidence: 0.75), "[NATIVE-CONFIRM-40]")
        XCTAssertFalse(state.canEdit(serverCanPick: true), "[NATIVE-CONFIRM-41]")
    }

    func testActualLostResponseUncertaintyRetainsOnlyTheSameRetrySelection() throws {
        var state = PickConfirmationState()
        try state.begin(option: 0, confidence: 0.25)
        state.markUncertain()
        XCTAssertTrue(state.isUncertain, "[NATIVE-CONFIRM-42]")
        XCTAssertNil(state.confirmed, "[NATIVE-CONFIRM-43]")
        XCTAssertFalse(state.canEdit(serverCanPick: true), "[NATIVE-CONFIRM-44]")
        XCTAssertThrowsError(try state.begin(option: 1, confidence: 0.25), "[NATIVE-CONFIRM-45]")
        XCTAssertNoThrow(try state.begin(option: 0, confidence: 0.25), "[NATIVE-CONFIRM-46]")
        XCTAssertEqual(state.pending, PickConfirmationState.Selection(option: 0, confidence: 0.25), "[NATIVE-CONFIRM-47]")
        XCTAssertNil(state.confirmed, "[NATIVE-CONFIRM-48]")
        try state.accept(receipt())
        XCTAssertEqual(state.confirmed, PickConfirmationState.Selection(option: 0, confidence: 0.25), "[NATIVE-CONFIRM-49]")
    }

    func testActualDefinitiveRejectionClearsPendingWithoutInventingSuccess() throws {
        var state = PickConfirmationState()
        try state.begin(option: 0, confidence: 0.25)
        state.markUncertain()
        state.reject()
        XCTAssertNil(state.pending, "[NATIVE-CONFIRM-50]")
        XCTAssertNil(state.confirmed, "[NATIVE-CONFIRM-51]")
        XCTAssertFalse(state.isUncertain, "[NATIVE-CONFIRM-52]")
        XCTAssertTrue(state.canEdit(serverCanPick: true), "[NATIVE-CONFIRM-53]")
        XCTAssertFalse(state.canEdit(serverCanPick: false), "[NATIVE-CONFIRM-54]")
    }

    func testActualStaleEmptyReadCannotUnlockConfirmedOrPendingPick() throws {
        var state = PickConfirmationState()
        try state.begin(option: 0, confidence: 0.25)
        state.markUncertain()
        state.resolve(nil)
        XCTAssertTrue(state.isUncertain, "[NATIVE-CONFIRM-55]")
        XCTAssertEqual(state.pending, PickConfirmationState.Selection(option: 0, confidence: 0.25), "[NATIVE-CONFIRM-56]")
        state.resolve(try pick())
        state.resolve(nil)
        state.reject()
        state.markUncertain()
        XCTAssertEqual(state.confirmed, PickConfirmationState.Selection(option: 0, confidence: 0.25), "[NATIVE-CONFIRM-57]")
        XCTAssertFalse(state.canEdit(serverCanPick: true), "[NATIVE-CONFIRM-58]")
        XCTAssertFalse(state.isUncertain, "[NATIVE-CONFIRM-59]")
    }

    func testActualConfirmedStateRejectsRepeatedConfirmEvenWithDifferentChoiceConfidence() throws {
        var state = PickConfirmationState()
        state.resolve(try pick())
        for (option, confidence) in [(0, 0.25), (1, 0.25), (0, 0.75), (1, 1.0)] {
            XCTAssertThrowsError(try state.begin(option: option, confidence: confidence), "[NATIVE-CONFIRM-60]")
            XCTAssertEqual(state.confirmed, PickConfirmationState.Selection(option: 0, confidence: 0.25), "[NATIVE-CONFIRM-61]")
        }
    }

    func testActualIndependentViewStateInstancesDoNotShareAConfirmedPick() throws {
        var first = PickConfirmationState()
        var second = PickConfirmationState()
        first.resolve(try pick())
        XCTAssertNil(second.confirmed, "[NATIVE-CONFIRM-62] independent value state, not an account/card UI identity proof")
        XCTAssertTrue(second.canEdit(serverCanPick: true), "[NATIVE-CONFIRM-63]")
        second.resolve(try pick(1, 0.75))
        XCTAssertEqual(first.confirmed, PickConfirmationState.Selection(option: 0, confidence: 0.25), "[NATIVE-CONFIRM-64]")
        XCTAssertEqual(second.confirmed, PickConfirmationState.Selection(option: 1, confidence: 0.75), "[NATIVE-CONFIRM-65]")
    }
}
