"""The placement-point scale, in one stdlib-only place.

Every expected value in this project is denominated in Tenhou houou placement
points, and two independent things have to agree on what those are: the value
head is regressed on them, and akochan is told them through its `jun_pt`
tactics. Changing `jun_pt` is not a rescaling — the objective changes, so the
ranking changes with it, and in one sampled position the 2nd and 3rd best
discards swapped. `test_akochan.py` compares the two declarations for exactly
that reason.

This module exists so that comparison does not need a GPU stack. The constant
used to live in `train.py`, which raises `SystemExit(2)` at import when torch is
missing — so the test that pins the scale could not run anywhere torch was not
installed, which is to say in CI, which is to say it had never once run there.
`train.py` is a consumer of the scale, not its owner.
"""

from __future__ import annotations

#: Standard uma with the 4th-place penalty folded in, so the value head learns
#: something interpretable.
PLACEMENT_POINTS = (90.0, 45.0, 0.0, -135.0)
