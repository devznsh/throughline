; C#
(class_declaration name: (identifier) @name) @definition.class
(interface_declaration name: (identifier) @name) @definition.interface
(struct_declaration name: (identifier) @name) @definition.struct
(enum_declaration name: (identifier) @name) @definition.enum
(record_declaration name: (identifier) @name) @definition.struct
(method_declaration name: (identifier) @name) @definition.method
(constructor_declaration name: (identifier) @name) @definition.constructor
(property_declaration name: (identifier) @name) @definition.property
(namespace_declaration name: (identifier) @name) @definition.namespace

(invocation_expression function: (identifier) @reference.call)
(invocation_expression
  function: (member_access_expression
    expression: (identifier) @reference.receiver
    name: (identifier) @reference.call))
(object_creation_expression type: (identifier) @reference.instantiate)

(using_directive (qualified_name) @import.source) @import.statement
(using_directive (identifier) @import.source) @import.statement
