import Foundation

/// Lossless JSON boundary. Decimal avoids converting yen through Double.
indirect enum KMAPIJSON: Codable, Sendable, Equatable {
    case object([String: KMAPIJSON]), array([KMAPIJSON]), string(String), number(Decimal), bool(Bool), null

    init(from decoder: any Decoder) throws {
        let c = try decoder.singleValueContainer()
        if c.decodeNil() { self = .null }
        else if let v = try? c.decode(Bool.self) { self = .bool(v) }
        else if let v = try? c.decode(String.self) { self = .string(v) }
        else if let v = try? c.decode(Decimal.self) { self = .number(v) }
        else if let v = try? c.decode([String: KMAPIJSON].self) { self = .object(v) }
        else { self = .array(try c.decode([KMAPIJSON].self)) }
    }

    func encode(to encoder: any Encoder) throws {
        var c = encoder.singleValueContainer()
        switch self {
        case .object(let v): try c.encode(v)
        case .array(let v): try c.encode(v)
        case .string(let v): try c.encode(v)
        case .number(let v): try c.encode(v)
        case .bool(let v): try c.encode(v)
        case .null: try c.encodeNil()
        }
    }
}

indirect enum KMAPIShape: Sendable {
    case object([String: KMAPIShape], optional: Set<String> = [])
    case array(KMAPIShape, max: Int)
    case dictionary(KMAPIShape)
    case text(min: Int = 1, max: Int = 500)
    case integer(min: Int = 0, max: Int = 9_007_199_254_740_991)
    case decimal(min: Decimal, max: Decimal)
    case values(Set<String>)
    case nullable(KMAPIShape)
    case boolean, null, date, month, payrollText, any

    /// Domain encoders omit nil optionals; wire responses must still include required nulls.
    var encodingShape: KMAPIShape {
        switch self {
        case .object(let fields, let optional):
            let nullableKeys = fields.compactMap { key, shape -> String? in
                if case .nullable = shape { return key }; return nil
            }
            return .object(fields.mapValues(\.encodingShape), optional: optional.union(nullableKeys))
        case .array(let element, let max): return .array(element.encodingShape, max: max)
        case .nullable(let shape): return .nullable(shape.encodingShape)
        default: return self
        }
    }

    func validate(_ value: KMAPIJSON) throws {
        switch (self, value) {
        case (.object(let fields, let optional), .object(let object)):
            guard Set(object.keys).isSubset(of: Set(fields.keys)),
                  Set(fields.keys).subtracting(optional).isSubset(of: Set(object.keys)) else { throw KMAPIError.invalidResponse }
            for (key, value) in object { try fields[key]!.validate(value) }
        case (.array(let element, let max), .array(let values)):
            guard values.count <= max else { throw KMAPIError.invalidResponse }
            try values.forEach { try element.validate($0) }
        case (.dictionary(let element), .object(let values)):
            guard values.count <= 100 else { throw KMAPIError.invalidResponse }
            try values.values.forEach { try element.validate($0) }
        case (.text(let min, let max), .string(let text)):
            guard text.utf16.count <= max, text.trimmingCharacters(in: .whitespacesAndNewlines).utf16.count >= min else { throw KMAPIError.invalidResponse }
        case (.integer(let min, let max), .number(let number)):
            var input = number, rounded = Decimal()
            NSDecimalRound(&rounded, &input, 0, .plain)
            guard rounded == number, number >= Decimal(min), number <= Decimal(max) else { throw KMAPIError.invalidResponse }
        case (.decimal(let min, let max), .number(let number)):
            guard !number.isNaN, number >= min, number <= max else { throw KMAPIError.invalidResponse }
        case (.values(let allowed), .string(let text)):
            guard allowed.contains(text) else { throw KMAPIError.invalidResponse }
        case (.nullable, .null), (.null, .null), (.boolean, .bool), (.any, _): break
        case (.nullable(let shape), _): try shape.validate(value)
        case (.date, .string(let text)): _ = try KMDate(text)
        case (.month, .string(let text)): _ = try KMYearMonth(text)
        case (.payrollText, .string(let text)):
            try KMAPIShape.text(max: 120).validate(value)
            let normalized = text.precomposedStringWithCompatibilityMapping
            guard normalized.range(of: #"(?:\d[\s-]*){7,}|マイナンバー|個人番号|社員番号|従業員番号|口座番号|生年月日|住所|氏名|https?:|@"#,
                                   options: [.regularExpression, .caseInsensitive]) == nil else { throw KMAPIError.invalidResponse }
        default: throw KMAPIError.invalidResponse
        }
    }
}

/// Check unknown keys and nullable-but-required keys before synthesized Codable decoding.
enum KMAPIValidation {
    static func decode<T: Decodable>(_ type: T.Type, data: Data, shape: KMAPIShape) throws -> T {
        do {
            try shape.validate(JSONDecoder().decode(KMAPIJSON.self, from: data))
            return try KMJSON.decoder().decode(type, from: data)
        } catch { throw KMAPIError.invalidResponse }
    }

    static func request<T: Encodable>(_ value: T, shape: KMAPIShape) throws -> Data {
        do {
            let data = try JSONEncoder().encode(value)
            try shape.validate(JSONDecoder().decode(KMAPIJSON.self, from: data))
            return data
        } catch { throw KMAPIError.invalidRequest }
    }

    static func flow(_ value: UUID) throws {
        guard value.uuidString.range(of: #"^[0-9A-F]{8}-[0-9A-F]{4}-4[0-9A-F]{3}-[89AB][0-9A-F]{3}-[0-9A-F]{12}$"#, options: .regularExpression) != nil else {
            throw KMAPIError.invalidRequest
        }
    }
}
