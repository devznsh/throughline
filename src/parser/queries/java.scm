; Java
(class_declaration name: (identifier) @name) @definition.class
(interface_declaration name: (identifier) @name) @definition.interface
(enum_declaration name: (identifier) @name) @definition.enum
(record_declaration name: (identifier) @name) @definition.struct
(method_declaration name: (identifier) @name) @definition.method
(constructor_declaration name: (identifier) @name) @definition.constructor
(field_declaration (variable_declarator name: (identifier) @name)) @definition.field

(method_invocation name: (identifier) @reference.call)
(method_invocation object: (identifier) @reference.receiver name: (identifier) @reference.call)
(object_creation_expression type: (type_identifier) @reference.instantiate)
(superclass (type_identifier) @reference.extends)
(super_interfaces (type_list (type_identifier) @reference.implements))

(import_declaration (scoped_identifier) @import.source) @import.statement
