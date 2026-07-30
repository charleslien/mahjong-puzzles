"""Shared JSONL reading for the pipeline stages.

Every stage reads line-delimited JSON that may or may not be gzipped, and each
one had grown its own opener. Two of the three disagreed about how to detect
compression, which is exactly the kind of drift worth removing.

Detection is by magic bytes, not by extension. extract.py learned this the hard
way: the published tenhou-to-mjai dumps keep a `.mjson` extension on gzipped
payloads, so the filename genuinely cannot be trusted. train.py's
`path.endswith(".gz")` check would have opened such a file as text and failed on
the first line.
"""

from __future__ import annotations

import gzip
import json
from typing import Any, Dict, IO, Iterator


def is_gzipped(path: str) -> bool:
    """True when `path` starts with the gzip magic bytes."""
    try:
        with open(path, "rb") as handle:
            return handle.read(2) == b"\x1f\x8b"
    except OSError:
        return False


def open_text(path: str) -> IO[str]:
    """Open a plain or gzipped text file for reading."""
    opener = gzip.open if is_gzipped(path) else open
    return opener(path, "rt", encoding="utf-8")  # type: ignore[operator,return-value]


def iter_records(path: str) -> Iterator[Dict[str, Any]]:
    """Yield each non-blank line of a JSONL file as a dict."""
    with open_text(path) as handle:
        for line in handle:
            line = line.strip()
            if line:
                yield json.loads(line)
