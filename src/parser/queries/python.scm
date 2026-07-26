; Python
(function_definition name: (identifier) @name) @definition.function
(class_definition name: (identifier) @name) @definition.class

; Decorated definitions keep the decorator in range so @app.route is visible.
(decorated_definition
  definition: (function_definition name: (identifier) @name)) @definition.function

; Module-level assignment of a constant
(module
  (expression_statement
    (assignment left: (identifier) @name))) @definition.constant

; References
(call function: (identifier) @reference.call)
(call
  function: (attribute
    object: (identifier) @reference.receiver
    attribute: (identifier) @reference.call))
(class_definition superclasses: (argument_list (identifier) @reference.extends))

; Imports
(import_statement name: (dotted_name) @import.source) @import.statement
(import_from_statement module_name: (dotted_name) @import.source) @import.statement
(import_from_statement module_name: (relative_import) @import.source) @import.statement
