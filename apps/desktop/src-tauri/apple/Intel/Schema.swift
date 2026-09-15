// Turns the request's JSON-schema subset into a runtime generation schema,
// so the web app decides the shape of every answer without a Swift change.
// Supported: objects of string, number, integer, boolean, string-enum,
// array and object properties, each with a description; "required" marks
// the rest optional; arrays take minItems and maxItems; "order" fixes the
// property order the model sees.
//
// Every object below the root becomes a named dependency that the parent
// refers to by name. The framework decodes arrays of objects reliably only
// in that form; an object schema written inline where an array's items go
// produced answers it could not decode.

import Foundation
#if canImport(FoundationModels)
import FoundationModels

struct IntelSchemaError: Error {
    let detail: String
}

@available(macOS 26, iOS 26, *)
enum IntelSchema {
    static func build(_ json: [String: Any]) throws -> GenerationSchema {
        var dependencies: [DynamicGenerationSchema] = []
        let root = try dynamic(json, name: (json["title"] as? String) ?? "Answer", root: true, dependencies: &dependencies)
        return try GenerationSchema(root: root, dependencies: dependencies)
    }

    private static func dynamic(
        _ json: [String: Any],
        name: String,
        root: Bool,
        dependencies: inout [DynamicGenerationSchema]
    ) throws -> DynamicGenerationSchema {
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
                        schema: try dynamic(spec, name: name + "." + key, root: false, dependencies: &dependencies),
                        isOptional: !required.contains(key)))
            }
            let object = DynamicGenerationSchema(name: name, properties: properties)
            if root {
                return object
            }
            dependencies.append(object)
            return DynamicGenerationSchema(referenceTo: name)
        case "array":
            let items = (json["items"] as? [String: Any]) ?? ["type": "string"]
            return DynamicGenerationSchema(
                arrayOf: try dynamic(items, name: name + "Item", root: false, dependencies: &dependencies),
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
