; C / C++
(function_definition declarator: (function_declarator declarator: (identifier) @name)) @definition.function
(function_definition
  declarator: (function_declarator
    declarator: (qualified_identifier name: (identifier) @name))) @definition.method
(class_specifier name: (type_identifier) @name) @definition.class
(struct_specifier name: (type_identifier) @name) @definition.struct
(enum_specifier name: (type_identifier) @name) @definition.enum
(type_definition declarator: (type_identifier) @name) @definition.type
(namespace_definition name: (namespace_identifier) @name) @definition.namespace

(call_expression function: (identifier) @reference.call)
(call_expression
  function: (field_expression
    argument: (identifier) @reference.receiver
    field: (field_identifier) @reference.call))
(base_class_clause (type_identifier) @reference.extends)

(preproc_include path: (string_literal) @import.source) @import.statement
(preproc_include path: (system_lib_string) @import.source) @import.statement
