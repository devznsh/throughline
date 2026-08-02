; Kotlin
(function_declaration (simple_identifier) @name) @definition.function
(class_declaration (type_identifier) @name) @definition.class
(object_declaration (type_identifier) @name) @definition.class
(property_declaration (variable_declaration (simple_identifier) @name)) @definition.property

(call_expression (simple_identifier) @reference.call)
(import_header (identifier) @import.source) @import.statement
