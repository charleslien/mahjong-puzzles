"""Subprocess bridge to akochan.

akochan exposes two ways to get an expected-value breakdown of the legal actions
at a position, and this module implements both because they are only equivalent
under conditions worth pinning down in a test:

  `mjai_log <file> <seat> <last-index>`   one evaluation, one process (the fast
                                          path, used for everything)
  `pipe_detailed <tactics> <seat>`        a long-lived process fed mjai events on
                                          stdin, evaluating at every decision it
                                          passes (the reference path)

`pipe_detailed` is how akochan plays live, so it is the authoritative behaviour —
but it evaluates *every* decision in the stream it is given, and a position deep
in a hanchan sits behind hundreds of them. Measured on a 671-event prefix: 80s
via pipe_detailed against 0.37s via mjai_log, a 218x difference, with bit-identical
output once the two are given matching input. `test_akochan.py` asserts that
equivalence so the fast path cannot quietly drift from the real one.

Getting them to agree took two corrections, both of which produced plausible
wrong numbers rather than errors:

1. **Record scope.** `pipe_detailed` truncates its game record to the current hand
   at every `start_kyoku`, keeping only the leading `start_game`. Handing
   `mjai_log` a whole-hanchan prefix therefore evaluates a *different* record.
   `kyoku_prefix` builds exactly what pipe_detailed would have retained.

2. **The placement-point scale.** `mjai_log` ignores its command line and loads
   tactics from the hardcoded path `setup_mjai.json`, so it silently ran on
   akochan's default `jun_pt` of [90, 30, -30, -90] while the other path used
   ours. That is not a rescaling: the objective changes, so the *ranking* changes
   too — in one test position the 2nd and 3rd best discards swapped. Both paths
   are now pinned to Tenhou houou's actual [90, 45, 0, -135], matching what the
   model's value head was trained on. `_install_tactics` writes that file,
   preserving upstream's copy alongside it.

Two further things fail quietly if you get them wrong:

  - **Working directory.** akochan reads its parameter tables from paths like
    `params/rank_prob/ako/para1_9000.txt`, relative to the process's working
    directory. Spawned elsewhere it reads none and keeps going. Every spawn here
    sets cwd, and `probe()` checks a known position returns a sane spread rather
    than trusting an exit code.

  - **No decision point.** akochan only evaluates when the seat draws, or when
    another seat discards or adds to a pon. A discard the seat makes immediately
    after its *own* call matches none of those, and akochan returns nothing.
    That surfaces as `NoEvaluationPoint`, never as another position's numbers.
"""

from __future__ import annotations

import json
import os
import selectors
import shutil
import subprocess
import tempfile
from typing import Any, Dict, List, Optional, Sequence

# Tenhou houou 4-player placement points, matching train.PLACEMENT_POINTS. Every
# EV in this pipeline is denominated in these units.
JUN_PT = [90, 45, 0, -135]

# akochan's default tactics with jun_pt replaced. Every other key is copied from
# upstream's setup_mjai.json; "ako" selects akochan's own trained estimators.
TACTICS = {
    "tactics": {
        "base": "default",
        "jun_pt": JUN_PT,
        "jun_est": "ako",
        "use_agari_coeff_tp_fnm": 0,
        "use_agari_coeff_tp_an": 8,
        "tsumo_num_est": "ako",
        "tsumo_num_ratio": 1.0,
        "use_other_end_ar": False,
        "other_end_prob_est": "ako",
        "other_end_est_begin": 0,
        "tenpai_prob_est": "ako",
        "tenpai_after_est": "ako",
        "tenpai_after_est_begin": 0,
        "tenpai_after_use_other_reach": True,
        "agari_prob_est": "ako",
        "my_keiten_prob_est": "ako",
        "other_keiten_prob_est": "ako",
        "inclusive_fold_est": "ako",
        "ron_ratio_est": "ako",
        "ryukyoku_prob_est": "ako",
        "result_other_est": "ako",
        "tas_est": "ako",
        "mc_init": "ako",
        "sbr_est": "ako",
        "katachi_est": "ako",
        "houjuu_est": "ako",
    }
}

# Path mjai_log hardcodes, and where _install_tactics writes.
TACTICS_FILENAME = "setup_mjai.json"
UPSTREAM_TACTICS_BACKUP = "setup_mjai.upstream.json"
# Separate copy for pipe_detailed, which does take a command-line path.
PIPELINE_TACTICS_FILENAME = "setup_mjai_pipeline.json"

DEFAULT_TIMEOUT = 300.0


class AkochanNotAvailable(RuntimeError):
    """Raised when no usable akochan build is present."""


class NoEvaluationPoint(RuntimeError):
    """Raised when akochan's interface offers no decision point for a position."""


class AkochanError(RuntimeError):
    """Raised when akochan fails, dies, or returns something unparseable."""


def triggers_evaluation(event: Dict[str, Any], seat: int) -> bool:
    """Whether akochan evaluates a decision for `seat` at this event.

    Mirrors the dispatch shared by main.cpp's pipe_detailed and analyze.cpp, kept
    in one place so the prediction cannot disagree with itself.
    """
    kind = event.get("type")
    if kind == "error":
        return False
    actor = event.get("actor")
    if actor is None:
        return False
    if int(actor) == seat:
        return kind == "tsumo"
    return kind in ("dahai", "kakan")


def kyoku_prefix(history: Sequence[Dict[str, Any]]) -> List[Dict[str, Any]]:
    """The record `pipe_detailed` would hold after consuming `history`.

    That is: the opening `start_game`, then everything from the last
    `start_kyoku` onwards. Sending more changes akochan's answer (see the module
    docstring), and sending no `start_game` at all is undefined behaviour rather
    than an error — pipe_detailed truncates to `begin() + 1` on `start_kyoku`,
    which on an empty record reads past the end.
    """
    if not history:
        return []

    start_game = history[0] if history[0].get("type") == "start_game" else None
    last_kyoku = 0
    for index, event in enumerate(history):
        if event.get("type") == "start_kyoku":
            last_kyoku = index

    prefix = list(history[last_kyoku:])
    if start_game is not None and last_kyoku > 0:
        prefix.insert(0, start_game)
    return prefix


class AkochanEngine:
    """Evaluates positions with akochan."""

    def __init__(
        self,
        binary_path: str,
        work_dir: Optional[str] = None,
        timeout: float = DEFAULT_TIMEOUT,
    ) -> None:
        self.binary_path = os.path.abspath(binary_path)
        if not os.path.exists(self.binary_path):
            raise AkochanNotAvailable(
                "no akochan binary at {}; build it with scripts/build-akochan.sh".format(
                    self.binary_path
                )
            )
        # Default to the binary's own directory, which is where params/ lives.
        self.work_dir = os.path.abspath(work_dir or os.path.dirname(self.binary_path))
        if not os.path.isdir(os.path.join(self.work_dir, "params")):
            raise AkochanNotAvailable(
                "no params/ directory under {}; akochan reads its parameter tables "
                "relative to the working directory and would silently read none".format(
                    self.work_dir
                )
            )

        self.timeout = timeout
        self._install_tactics()
        self._scratch = tempfile.mkdtemp(prefix="akochan-")
        self._prefix_path = os.path.join(self._scratch, "prefix.jsonl")

        self._process: Optional[subprocess.Popen] = None
        self._seat: Optional[int] = None
        self.evaluations = 0

    def _install_tactics(self) -> None:
        """Write our tactics where both akochan modes will read them.

        mjai_log ignores its arguments and loads TACTICS_FILENAME, so the file has
        to be replaced rather than passed. Upstream's version is preserved beside
        it on first run.
        """
        target = os.path.join(self.work_dir, TACTICS_FILENAME)
        backup = os.path.join(self.work_dir, UPSTREAM_TACTICS_BACKUP)
        if os.path.exists(target) and not os.path.exists(backup):
            shutil.copy(target, backup)
        with open(target, "w", encoding="utf-8") as handle:
            json.dump(TACTICS, handle)

        self._tactics_path = os.path.join(self.work_dir, PIPELINE_TACTICS_FILENAME)
        with open(self._tactics_path, "w", encoding="utf-8") as handle:
            json.dump(TACTICS, handle)

    # -- fast path ---------------------------------------------------------

    def evaluate(self, history: Sequence[Dict[str, Any]], seat: int) -> List[Dict[str, Any]]:
        """Evaluate the final decision in `history` for `seat`.

        `history` must be a real prefix of an mjai log ending at the event that
        creates the decision. Returns [{"id", "tile", "ev", "moves"}] best-first,
        with `ev` in placement points on the JUN_PT scale.
        """
        prefix = self._check(history, seat)

        with open(self._prefix_path, "w", encoding="utf-8") as handle:
            for event in prefix:
                handle.write(json.dumps(event, separators=(",", ":")) + "\n")

        completed = subprocess.run(
            [
                self.binary_path,
                "mjai_log",
                self._prefix_path,
                str(seat),
                str(len(prefix) - 1),
            ],
            cwd=self.work_dir,
            capture_output=True,
            text=True,
            timeout=self.timeout,
        )
        if completed.returncode != 0:
            raise AkochanError(
                "akochan exited {}: {}".format(
                    completed.returncode, (completed.stderr or "").strip()[:400]
                )
            )

        lines = [line for line in completed.stdout.splitlines() if line.strip()]
        if not lines:
            raise AkochanError("akochan produced no output")

        self.evaluations += 1
        # mjai_log echoes the record and a progress line before the review.
        return self._parse(lines[-1])

    def _check(
        self,
        history: Sequence[Dict[str, Any]],
        seat: int,
    ) -> List[Dict[str, Any]]:
        if not history:
            raise ValueError("empty history")
        if not triggers_evaluation(history[-1], seat):
            raise NoEvaluationPoint(
                "akochan does not evaluate a {} by actor {} for seat {}".format(
                    history[-1].get("type"), history[-1].get("actor"), seat
                )
            )
        prefix = kyoku_prefix(history)
        if len(prefix) < 2:
            raise NoEvaluationPoint("no start_kyoku in history")
        return prefix

    # -- reference path ----------------------------------------------------

    def evaluate_streaming(
        self,
        history: Sequence[Dict[str, Any]],
        seat: int,
    ) -> List[Dict[str, Any]]:
        """Evaluate via `pipe_detailed`, the mode akochan uses to play.

        Authoritative but far slower, because it evaluates every decision in the
        stream and only the last one is wanted. Kept so the fast path has
        something to be tested against.
        """
        self._check(history, seat)
        process = self._process_for(seat)
        assert process.stdin is not None

        expected = 0
        try:
            for event in history:
                process.stdin.write(json.dumps(event, separators=(",", ":")) + "\n")
                if triggers_evaluation(event, seat):
                    expected += 1
            process.stdin.flush()
        except (BrokenPipeError, OSError) as exc:
            raise AkochanError("akochan stdin closed: {}".format(exc)) from exc

        # Read every line the stream owes us and keep the last. Reading fewer
        # leaves the process desynchronised for the next call.
        last = ""
        for _ in range(expected):
            last = self._read_line(process)
        self.evaluations += 1
        return self._parse(last)

    def _spawn(self, seat: int) -> subprocess.Popen:
        process = subprocess.Popen(
            [
                self.binary_path,
                "pipe_detailed",
                os.path.basename(self._tactics_path),
                str(seat),
            ],
            cwd=self.work_dir,
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
            bufsize=1,
        )
        self._seat = seat
        return process

    def _process_for(self, seat: int) -> subprocess.Popen:
        if self._process is not None and self._seat == seat and self._process.poll() is None:
            return self._process
        self._close_process()
        self._process = self._spawn(seat)
        return self._process

    def _read_line(self, process: subprocess.Popen) -> str:
        """Read one stdout line with a deadline.

        A bare readline() would hang forever if akochan emitted nothing, which is
        the difference between a slow batch and a stuck one.
        """
        assert process.stdout is not None
        selector = selectors.DefaultSelector()
        selector.register(process.stdout, selectors.EVENT_READ)
        try:
            if not selector.select(self.timeout):
                raise AkochanError("akochan produced no output within {}s".format(self.timeout))
        finally:
            selector.close()

        line = process.stdout.readline()
        if not line:
            raise AkochanError("akochan exited (code {})".format(process.poll()))
        return line

    # -- lifecycle ---------------------------------------------------------

    def _close_process(self) -> None:
        process = self._process
        self._process = None
        self._seat = None
        if process is None:
            return
        try:
            if process.stdin:
                process.stdin.close()
            process.wait(timeout=5)
        except (subprocess.TimeoutExpired, OSError):
            process.kill()
            try:
                process.wait(timeout=5)
            except subprocess.TimeoutExpired:
                pass
        finally:
            for stream in (process.stdout, process.stderr):
                if stream is not None:
                    try:
                        stream.close()
                    except OSError:
                        pass

    def close(self) -> None:
        self._close_process()
        shutil.rmtree(self._scratch, ignore_errors=True)

    def __enter__(self) -> "AkochanEngine":
        return self

    def __exit__(self, *exc: Any) -> None:
        self.close()

    # -- parsing -----------------------------------------------------------

    @staticmethod
    def _parse(line: str) -> List[Dict[str, Any]]:
        try:
            payload = json.loads(line)
        except json.JSONDecodeError as exc:
            raise AkochanError("unparseable akochan output: {!r}".format(line[:200])) from exc
        if not isinstance(payload, list):
            raise AkochanError("expected a JSON array, got {}".format(type(payload).__name__))

        actions: List[Dict[str, Any]] = []
        for entry in payload:
            moves = entry.get("moves") or []
            review = entry.get("review") or {}
            if "pt_exp_total" not in review:
                continue
            first = moves[0] if moves else {}
            ev = float(review["pt_exp_total"])
            kind = first.get("type")

            if kind == "dahai":
                tile = first.get("pai")
                actions.append(
                    {"id": "discard:{}".format(tile), "tile": tile, "ev": ev, "moves": moves}
                )
            elif kind == "reach":
                # A declaration is always a pair: `reach` then the discard it is
                # declared on. The tile matters — a riichi puzzle compares
                # declaring against playing on, and the two lines may not even
                # want the same tile.
                declared_on = next(
                    (move.get("pai") for move in moves if move.get("type") == "dahai"),
                    None,
                )
                actions.append(
                    {"id": "riichi", "tile": declared_on, "ev": ev, "moves": moves, "kind": "reach"}
                )
            else:
                # Calls and wins also appear, carrying an EV but no discard.
                actions.append(
                    {"id": kind or "unknown", "tile": None, "ev": ev, "moves": moves, "kind": kind}
                )

        actions.sort(key=lambda action: -action["ev"])
        return actions

    # -- self-check --------------------------------------------------------

    def probe(self) -> List[Dict[str, Any]]:
        """Evaluate a fixed opening position and check the result is sane.

        A wrong working directory does not raise — akochan reads no parameters and
        carries on — so checking an exit code proves nothing. This checks that
        several discards came back with differing expected values.
        """
        actions = self.evaluate(PROBE_HISTORY, 0)
        if len(actions) < 2:
            raise AkochanNotAvailable(
                "akochan returned {} action(s) for a 14-tile hand; expected "
                "several".format(len(actions))
            )
        if len({round(action["ev"], 6) for action in actions}) < 2:
            raise AkochanNotAvailable(
                "akochan returned identical EVs for every discard, which usually "
                "means its parameter tables were not found (working directory "
                "{})".format(self.work_dir)
            )
        return actions


PROBE_HISTORY: List[Dict[str, Any]] = [
    {
        "type": "start_game",
        "names": ["a", "b", "c", "d"],
        "kyoku_first": 0,
        "aka_flag": True,
    },
    {
        "type": "start_kyoku",
        "bakaze": "E",
        "dora_marker": "4p",
        "kyoku": 1,
        "honba": 0,
        "kyotaku": 0,
        "oya": 0,
        "scores": [25000, 25000, 25000, 25000],
        "tehais": [
            ["1m", "6m", "6m", "8m", "9m", "5p", "8p", "9p", "4s", "S", "S", "W", "F"],
            ["1m", "3m", "3m", "5m", "9m", "4p", "6p", "7p", "2s", "6s", "8s", "E", "C"],
            ["2m", "4m", "7m", "8m", "1p", "2p", "3p", "5p", "7s", "9s", "N", "P", "C"],
            ["3m", "5m", "5m", "7m", "2p", "6p", "9p", "1s", "3s", "5s", "6s", "E", "F"],
        ],
    },
    {"type": "tsumo", "actor": 0, "pai": "8p"},
]
