// Turns the request's JSON-schema subset into a runtime generation schema,
// so the web app decides the shape of every answer without a Swift change.
// Supported: objects of string, number, integer, boolean, string-enum and
// array properties, each with a description; "required" marks the rest
// optional; arrays take minItems and maxItems; "order" fixes the property
// order the model sees.

import Foundation
#if canImport(FoundationModels)
import FoundationModels

struct IntelSchemaError: Error {
    let detail: String
}

@available(macOS 26, iOS 26, *)
enum IntelSchema {
    static func build(_ json: [String: Any]) throws -> GenerationSchema {
        let root = try dynamic(json, name: (json["title"] as? String) ?? "Answer")
        return try GenerationSchema(root: root, dependencies: [])
    }

    private static func dynamic(_ json: [String: Any], name: String) throws -> DynamicGenerationSchema {
        let type = (json["type"] as? String) ?? "string"
        switch type {
        case "object":
            let declared = (json["properties"] as? [String: [String: Any]]) ?? [:]
            let required = Set((json["required"] as? [String]) ?? [])
            let order = (json["order"] as? [String]) ?? declared.keys.sorted()
            var properties: [DynamicGenerationSchema.Property] = []
            for key in order {
                guard let spec = declared[key] else {
                    continue
                }
                properties.append(
                    DynamicGenerationSchema.Property(
                        name: key,
                        description: spec["description"] as? String,
                        schema: try dynamic(spec, name: name + "." + key),
                        isOptional: !required.contains(key)))
            }
            return DynamicGenerationSchema(name: name, properties: properties)
        case "array":
            let items = (json["items"] as? [String: Any]) ?? ["type": "string"]
            return DynamicGenerationSchema(
                arrayOf: try dynamic(items, name: name + "[]"),
                minimumElements: json["minItems"] as? Int,
                maximumElements: json["maxItems"] as? Int)
        case "string":
            if let choices = json["enum"] as? [String], !choices.isEmpty {
                return DynamicGenerationSchema(name: name, anyOf: choices)
            }
            return DynamicGenerationSchema(type: String.self)
        case "number":
            return DynamicGenerationSchema(type: Double.self)
        case "integer":
            return DynamicGenerationSchema(type: Int.self)
        case "boolean":
            return DynamicGenerationSchema(type: Bool.self)
        default:
            throw IntelSchemaError(detail: "unsupported schema type \(type)")
        }
    }
}
#endif
