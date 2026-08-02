; Go
(function_declaration name: (identifier) @name) @definition.function
(method_declaration name: (field_identifier) @name) @definition.method
(type_declaration
  (type_spec name: (type_identifier) @name type: (struct_type))) @definition.struct
(type_declaration
  (type_spec name: (type_identifier) @name type: (interface_type))) @definition.interface
(type_declaration
  (type_spec name: (type_identifier) @name)) @definition.type
(const_declaration (const_spec name: (identifier) @name)) @definition.constant
(var_declaration (var_spec name: (identifier) @name)) @definition.variable

; References
(call_expression function: (identifier) @reference.call)
(call_expression
  function: (selector_expression
    operand: (identifier) @reference.receiver
    field: (field_identifier) @reference.call))
(composite_literal type: (type_identifier) @reference.instantiate)

; Imports
(import_spec path: (interpreted_string_literal) @import.source) @import.statement
