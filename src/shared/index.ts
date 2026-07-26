/**
 * The shared kernel.
 *
 * Everything in this folder is dependency-free with respect to the rest of the
 * application: `shared/` may not import from `core/`, `storage/`, `tools/` or any
 * other module. That rule is what keeps the dependency graph acyclic — every
 * layer is allowed to depend on `shared/`, so if `shared/` depended on anything
 * upward it would close a cycle immediately.
 */

export * from './budget.js';
export * from './errors.js';
export * from './ids.js';
export * from './logger.js';
export * from './paths.js';
export * from './redact.js';
export * from './result.js';
