# 1. Use JWT for session tokens

## Status
Accepted

## Context
We need stateless authentication across several services and do not want a
shared session store.

## Decision
Issue short-lived JWTs signed with a shared secret, refreshed every 15 minutes.

## Consequences
Revocation is not immediate. Accepted because token lifetime is short.
