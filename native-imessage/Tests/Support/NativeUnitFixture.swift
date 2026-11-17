import Foundation

struct NativeUnitFixture {
    let namespace = "e2e_" + UUID().uuidString.replacingOccurrences(of: "-", with: "").lowercased()
    let serverTime = 1_795_000_000_000.0

    var values: [String: Any] {
        [
            "CalledItBuildChannel": "qa", "CalledItReleaseEnvironment": "staging",
            "CalledItSourceRevision": String(repeating: "a", count: 40),
            "CalledItExpectedBackendSourceRevision": String(repeating: "b", count: 40),
            "CalledItExpectedBackendDeploymentID": "synthetic-" + namespace,
            "CalledItExpectedBackendConfigVersion": "unit-v0.2",
            "CalledItAPIURL": "https://api.calledit-unit.invalid",
            "CalledItWebURL": "https://cards.calledit-unit.invalid",
            "CalledItExpectedAPIHost": "api.calledit-unit.invalid",
            "CalledItExpectedCardHost": "cards.calledit-unit.invalid",
            "CalledItAppGroup": "group.com.mikunad.calledit.qa.unit." + namespace,
            "CalledItKeychainGroup": "UNREGISTERED.com.mikunad.calledit.qa.unit." + namespace,
            "CalledItFixtureMode": false
        ]
    }

    func configuration() throws -> RuntimeConfiguration {
        try RuntimeConfiguration(values: values)
    }

    var attestation: [String: Any] {
        ["app": "called-it", "contractVersion": "v0.2", "schemaVersion": "v0.2",
         "environment": "staging", "sourceSha": String(repeating: "b", count: 40),
         "deploymentId": "synthetic-" + namespace, "configVersion": "unit-v0.2", "testAdapters": false]
    }

    var bet: [String: Any] {
        ["serverTime": serverTime, "groupId": namespace + "_g1", "betId": namespace + "_b1",
         "state": "open", "cutoffAt": serverTime + 60_000, "revealAt": serverTime + 120_000,
         "card": ["url": "https://cards.calledit-unit.invalid/c/opaque_QA_card_01",
                  "caption": "Secret bet on Sage", "accessibilityLabel": "Called It card about Sage",
                  "subjectAlias": "Sage", "bettorCount": 2, "bettorInitials": ["C", "F"]],
         "view": "sealed", "canVeto": true]
    }

    func openBet(format: String = "yes_no") -> [String: Any] {
        var result = bet
        result["view"] = "bet"
        result.removeValue(forKey: "canVeto")
        result["question"] = "SECRET_QUESTION_" + namespace
        result["format"] = format
        result["options"] = ["PRIVATE_A_" + namespace, "PRIVATE_B_" + namespace]
        result["canPick"] = true
        result["canAnswer"] = false
        result["canChallenge"] = false
        result["picks"] = [] as [String]
        if format == "over_under" { result["line"] = 2.5 }
        return result
    }

    func decode<T: Decodable>(_ type: T.Type, _ object: Any) throws -> T {
        try JSONDecoder().decode(type, from: JSONSerialization.data(withJSONObject: object, options: [.sortedKeys]))
    }
}
