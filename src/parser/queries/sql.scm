; SQL — table and view definitions are the useful symbols here
(create_table (object_reference name: (identifier) @name)) @definition.table
(create_view (object_reference name: (identifier) @name)) @definition.table
(create_function (object_reference name: (identifier) @name)) @definition.function
(invocation (object_reference name: (identifier) @reference.call))
