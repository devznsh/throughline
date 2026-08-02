/**
 * A minimal `Result` type.
 *
 * Rationale: indexing a large repository touches tens of thousands of files, any
 * of which may be malformed, unreadable, or use syntax the grammar cannot handle.
 * Throwing on the first failure would abort a 40-minute index run. Every
 * per-item operation in the pipeline therefore returns a `Result`, and only
 * genuinely unrecoverable conditions (corrupt database, missing workspace) throw.
 *
 * Exceptions are still used at process boundaries; this type is for *expected*
 * partial failure, not for control flow in general.
 */

export interface Ok<T> {
  readonly ok: true;
  readonly value: T;
}

export interface Err<E> {
  readonly ok: false;
  readonly error: E;
}

export type Result<T, E = Error> = Ok<T> | Err<E>;

export function ok<T>(value: T): Ok<T> {
  return { ok: true, value };
}

export function err<E>(error: E): Err<E> {
  return { ok: false, error };
}

export function isOk<T, E>(result: Result<T, E>): result is Ok<T> {
  return result.ok;
}

export function isErr<T, E>(result: Result<T, E>): result is Err<E> {
  return !result.ok;
}

/** Returns the value, or `fallback` if the result is an error. */
export function unwrapOr<T, E>(result: Result<T, E>, fallback: T): T {
  return result.ok ? result.value : fallback;
}

/**
 * Returns the value or throws. Use only where a failure genuinely cannot be
 * handled locally — never inside a per-file loop.
 */
export function unwrap<T, E>(result: Result<T, E>): T {
  if (result.ok) return result.value;
  throw result.error instanceof Error ? result.error : new Error(String(result.error));
}

export function mapOk<T, U, E>(result: Result<T, E>, fn: (value: T) => U): Result<U, E> {
  return result.ok ? ok(fn(result.value)) : result;
}

export function mapErr<T, E, F>(result: Result<T, E>, fn: (error: E) => F): Result<T, F> {
  return result.ok ? result : err(fn(result.error));
}

/**
 * Splits a batch of results into successes and failures. This is the workhorse
 * of the indexing pipeline: parse everything, keep what worked, report the rest.
 */
export function partition<T, E>(results: readonly Result<T, E>[]): {
  values: T[];
  errors: E[];
} {
  const values: T[] = [];
  const errors: E[] = [];
  for (const result of results) {
    if (result.ok) values.push(result.value);
    else errors.push(result.error);
  }
  return { values, errors };
}

/** Runs a synchronous function, converting a thrown value into an `Err`. */
export function attempt<T>(fn: () => T): Result<T, unknown> {
  try {
    return ok(fn());
  } catch (error: unknown) {
    return err(error);
  }
}

/** Runs an async function, converting a rejection into an `Err`. */
export async function attemptAsync<T>(fn: () => Promise<T>): Promise<Result<T, unknown>> {
  try {
    return ok(await fn());
  } catch (error: unknown) {
    return err(error);
  }
}
