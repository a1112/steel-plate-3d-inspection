"""Explicit capture runtime modes and the hardware-free offline backend."""

from __future__ import annotations

from typing import Literal, cast


RuntimeMode = Literal["online", "offline", "simulation"]
RUNTIME_MODES: tuple[RuntimeMode, ...] = ("online", "offline", "simulation")


def normalize_runtime_mode(
    value: str | None,
    *,
    history_only: bool = False,
) -> RuntimeMode:
    """Return one canonical mode while preserving the legacy history flag."""

    if history_only:
        if value and value.strip().lower() not in {"", "offline"}:
            raise ValueError("--history-only cannot be combined with a non-offline mode")
        return "offline"
    normalized = (value or "online").strip().lower()
    if normalized not in RUNTIME_MODES:
        raise ValueError(
            f"capture runtime mode must be one of {', '.join(RUNTIME_MODES)}"
        )
    return cast(RuntimeMode, normalized)


class NullCaptureBackend:
    """Backend used by offline mode; it never imports or initializes GenTL."""

    started = False

    def start(self) -> None:
        return None

    def connect(self, _camera: object) -> object:
        raise RuntimeError("offline mode does not connect capture devices")

    def close(self) -> None:
        return None
