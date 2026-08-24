#!/usr/bin/env python3
"""Export a trusted legacy YOLOv5 checkpoint to a self-contained ONNX model.

The legacy checkpoint contains pickled Python module references, so its original
YOLOv5 source tree is required only during this one-time conversion.  Online
inference consumes the resulting ONNX file and does not import the legacy code.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import sys
from pathlib import Path
from typing import Any


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        for block in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(block)
    return digest.hexdigest()


def export_model(
    checkpoint_path: Path,
    legacy_code_root: Path,
    output_path: Path,
    *,
    image_size: int = 640,
    opset: int = 12,
    dynamic_batch: bool = True,
) -> dict[str, Any]:
    if not checkpoint_path.is_file():
        raise FileNotFoundError(checkpoint_path)
    if not (legacy_code_root / "models" / "yolo.py").is_file():
        raise FileNotFoundError(
            f"legacy code root does not contain models/yolo.py: {legacy_code_root}"
        )
    sys.path.insert(0, str(legacy_code_root))

    import onnx
    import torch

    # This script must only be used for locally controlled checkpoints. PyTorch
    # checkpoints are pickle payloads and are not safe to load from strangers.
    checkpoint = torch.load(
        checkpoint_path,
        map_location="cpu",
        weights_only=False,
    )
    if not isinstance(checkpoint, dict):
        raise ValueError("legacy checkpoint must be a dictionary")
    model = checkpoint.get("ema") or checkpoint.get("model")
    if model is None:
        raise ValueError("legacy checkpoint has neither ema nor model")
    model = model.float().eval()
    for module in model.modules():
        if hasattr(module, "inplace"):
            module.inplace = False

    class PredictionOnly(torch.nn.Module):
        def __init__(self, inner: torch.nn.Module) -> None:
            super().__init__()
            self.inner = inner

        def forward(self, image: torch.Tensor) -> torch.Tensor:
            output = self.inner(image)
            if isinstance(output, (list, tuple)):
                return output[0]
            return output

    wrapper = PredictionOnly(model)
    dummy = torch.zeros((1, 3, image_size, image_size), dtype=torch.float32)
    output_path.parent.mkdir(parents=True, exist_ok=True)
    with torch.inference_mode():
        output = wrapper(dummy)
        if output.ndim != 3 or output.shape[0] != 1 or output.shape[2] < 6:
            raise ValueError(f"unexpected YOLO output shape: {tuple(output.shape)}")
        torch.onnx.export(
            wrapper,
            dummy,
            output_path,
            input_names=["images"],
            output_names=["predictions"],
            opset_version=opset,
            do_constant_folding=True,
            dynamic_axes=(
                {
                    "images": {0: "batch"},
                    "predictions": {0: "batch"},
                }
                if dynamic_batch
                else None
            ),
        )
    onnx_model = onnx.load(str(output_path))
    onnx.checker.check_model(onnx_model)
    names = list(getattr(model, "names", []))
    return {
        "source": str(checkpoint_path),
        "sourceSha256": sha256_file(checkpoint_path),
        "output": str(output_path),
        "outputSha256": sha256_file(output_path),
        "imageSize": image_size,
        "opset": opset,
        "inputShape": [None if dynamic_batch else 1, 3, image_size, image_size],
        "outputShape": [None if dynamic_batch else 1, *[int(value) for value in output.shape[1:]]],
        "dynamicBatch": dynamic_batch,
        "classNames": names,
        "parameterCount": sum(parameter.numel() for parameter in model.parameters()),
    }


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--checkpoint", required=True)
    parser.add_argument("--legacy-code-root", required=True)
    parser.add_argument("--output", required=True)
    parser.add_argument("--image-size", type=int, default=640)
    parser.add_argument("--opset", type=int, default=12)
    parser.add_argument(
        "--static-batch",
        action="store_true",
        help="retain a fixed batch dimension of one (dynamic batch is the default)",
    )
    args = parser.parse_args()
    result = export_model(
        Path(args.checkpoint).resolve(),
        Path(args.legacy_code_root).resolve(),
        Path(args.output).resolve(),
        image_size=max(32, args.image_size),
        opset=max(11, args.opset),
        dynamic_batch=not args.static_batch,
    )
    print(json.dumps(result, ensure_ascii=False, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
