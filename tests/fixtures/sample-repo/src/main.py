"""Sidecar worker, present so the fixture is genuinely polyglot."""
from typing import Optional


def process_queue(batch_size: int = 10) -> Optional[int]:
    """Drains the pending queue."""
    processed = 0
    for _ in range(batch_size):
        if not _has_work():
            break
        processed += 1
    return processed


def _has_work() -> bool:
    return False
