#if QA && targetEnvironment(simulator)
import SwiftUI

struct QADiagnosticsView: View {
    var body: some View {
        TimelineView(.periodic(from: .now, by: 0.5)) { _ in
            let configuration = try? Config.load()
            VStack(alignment: .leading, spacing: 2) {
                value("buildChannel", Bundle.main.object(forInfoDictionaryKey: "CalledItBuildChannel") as? String ?? "missing")
                value("bundleID", Bundle.main.bundleIdentifier ?? "missing")
                value("fixtureMode", configuration?.qaContext != nil ? "true" : "false")
                value("endpointPolicy", configuration?.qaContext != nil ? "loopback_only" : configuration == nil ? "unconfigured" : "attestation_required")
                value("sessionStorage", configuration?.qaContext != nil ? "qa_shared_keychain_run_scoped" : "qa_shared_keychain")
                if let configuration, let qa = configuration.qaContext {
                    value("runID", qa.runID)
                    value("manifestSHA256", qa.manifestSHA256)
                    value("simulatorUDID", qa.simulatorUDID)
                    value("fixtureSetID", qa.fixtureSetID)
                    value("apiOrigin", configuration.apiURL.absoluteString)
                    value("cardOrigin", configuration.cardBaseURL.absoluteString)
                    value("attestationState", QARuntimeTelemetry.shared.state(for: qa))
                } else {
                    value("runID", "none")
                    value("attestationState", "not_attested")
                }
            }
            .font(.caption2.monospaced())
            .foregroundStyle(.secondary)
        }
    }

    private func value(_ name: String, _ text: String) -> some View {
        Text(text).accessibilityIdentifier("qa.runtime." + name)
    }
}
#endif
