; Rust
(function_item name: (identifier) @name) @definition.function
(struct_item name: (type_identifier) @name) @definition.struct
(enum_item name: (type_identifier) @name) @definition.enum
(trait_item name: (type_identifier) @name) @definition.interface
(type_item name: (type_identifier) @name) @definition.type
(const_item name: (identifier) @name) @definition.constant
(static_item name: (identifier) @name) @definition.constant
(mod_item name: (identifier) @name) @definition.module

(call_expression function: (identifier) @reference.call)
(call_expression
  function: (field_expression
    value: (identifier) @reference.receiver
    field: (field_identifier) @reference.call))
(impl_item trait: (type_identifier) @reference.implements)

(use_declaration argument: (scoped_identifier) @import.source) @import.statement
(use_declaration argument: (identifier) @import.source) @import.statement
