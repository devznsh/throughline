; TypeScript / TSX — shared capture vocabulary, see src/parser/treesitter/host.ts
(function_declaration name: (identifier) @name) @definition.function
(generator_function_declaration name: (identifier) @name) @definition.function
(class_declaration name: (type_identifier) @name) @definition.class
(abstract_class_declaration name: (type_identifier) @name) @definition.class
(interface_declaration name: (type_identifier) @name) @definition.interface
(enum_declaration name: (identifier) @name) @definition.enum
(type_alias_declaration name: (type_identifier) @name) @definition.type
(module name: (identifier) @name) @definition.namespace

(method_definition name: (property_identifier) @name) @definition.method
(public_field_definition name: (property_identifier) @name) @definition.field

; const foo = () => {}  and  const foo = function () {}
(lexical_declaration
  (variable_declarator
    name: (identifier) @name
    value: [(arrow_function) (function_expression)])) @definition.function

; Top-level and exported constants only. Matching at any scope indexed every
; function-local temporary as a project symbol, which buried real definitions
; under names like `lines`, `parser` and `reason`.
(program
  (lexical_declaration (variable_declarator name: (identifier) @name)) @definition.constant)
(export_statement
  (lexical_declaration (variable_declarator name: (identifier) @name)) @definition.constant)
(program
  (variable_declaration (variable_declarator name: (identifier) @name)) @definition.variable)

; References
(call_expression function: (identifier) @reference.call)
(call_expression
  function: (member_expression
    object: (identifier) @reference.receiver
    property: (property_identifier) @reference.call))
(new_expression constructor: (identifier) @reference.instantiate)
(extends_clause value: (identifier) @reference.extends)
(implements_clause (type_identifier) @reference.implements)

; Imports and re-exports
(import_statement source: (string) @import.source) @import.statement
(export_statement source: (string) @import.source) @import.statement
(call_expression
  function: (identifier) @_require
  arguments: (arguments (string) @import.source)
  (#eq? @_require "require")) @import.statement
