; JavaScript / JSX
;
; Deliberately NOT a copy of typescript.scm. The JS grammar has no
; `type_identifier`, `interface_declaration`, `implements_clause` or
; `abstract_class_declaration`, and a query naming nodes a grammar does not
; define is rejected wholesale — which silently disabled JavaScript parsing
; entirely rather than degrading it.

; Top-level declarations only. Anchoring to `program` and `export_statement`
; keeps function-local `const`s out of the symbol table; without it, every
; temporary variable was indexed as a project symbol.
(program
  (function_declaration name: (identifier) @name) @definition.function)
(program
  (generator_function_declaration name: (identifier) @name) @definition.function)
(export_statement
  (function_declaration name: (identifier) @name) @definition.function)

(program (class_declaration name: (identifier) @name) @definition.class)
(export_statement (class_declaration name: (identifier) @name) @definition.class)

(method_definition name: (property_identifier) @name) @definition.method
(field_definition property: (property_identifier) @name) @definition.field

; const foo = () => {} / const foo = function () {}
(program
  (lexical_declaration
    (variable_declarator
      name: (identifier) @name
      value: [(arrow_function) (function_expression)])) @definition.function)
(export_statement
  (lexical_declaration
    (variable_declarator
      name: (identifier) @name
      value: [(arrow_function) (function_expression)])) @definition.function)

; Plain top-level constants
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
(class_heritage (identifier) @reference.extends)

; Imports
(import_statement source: (string) @import.source) @import.statement
(export_statement source: (string) @import.source) @import.statement
(call_expression
  function: (identifier) @_require
  arguments: (arguments (string) @import.source)
  (#eq? @_require "require")) @import.statement
