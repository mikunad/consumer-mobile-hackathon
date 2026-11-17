import CoreFoundation
import Foundation

enum ConvexJSON {
    static func encode(_ value: Any, depth: Int = 0) throws -> Any {
        guard depth <= 64 else { throw APIError(code: "INVALID_INPUT") }
        if value is NSNull { return NSNull() }
        if let data = value as? Data { return ["$bytes": data.base64EncodedString()] }
        if let string = value as? String { return string }
        if let number = value as? NSNumber {
            if CFGetTypeID(number) == CFBooleanGetTypeID() { return number.boolValue }
            let double = number.doubleValue
            if !double.isFinite || (double == 0 && double.sign == .minus) {
                var bits = double.bitPattern.littleEndian
                let data = withUnsafeBytes(of: &bits) { Data($0) }
                return ["$float": data.base64EncodedString()]
            }
            return number
        }
        if let array = value as? [Any] { return try array.map { try encode($0, depth: depth + 1) } }
        if let object = value as? [String: Any] {
            var encoded: [String: Any] = [:]
            for key in object.keys.sorted() {
                guard key.utf8.count <= 1024, !key.hasPrefix("$"), key.utf8.allSatisfy({ (32..<127).contains($0) }),
                      let value = object[key] else { throw APIError(code: "INVALID_INPUT") }
                encoded[key] = try encode(value, depth: depth + 1)
            }
            return encoded
        }
        throw APIError(code: "INVALID_INPUT")
    }
}
