"""Convert the trusted legacy EfficientNet defect classifiers to ONNX.

This is an offline migration utility.  TensorFlow and the legacy application
source are needed only while exporting; the capture service loads the emitted
ONNX graph through ONNX Runtime and does not import legacy application code.
"""

from __future__ import annotations

import argparse
import hashlib
import os
import sys
from pathlib import Path


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as source:
        for chunk in iter(lambda: source.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def main() -> int:
    parser = argparse.ArgumentParser(
        description="Export one trusted legacy EfficientNetB3 weights file to ONNX"
    )
    parser.add_argument("--legacy-root", type=Path, required=True)
    parser.add_argument("--weights", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--classes", type=int, required=True)
    parser.add_argument("--image-size", type=int, default=224)
    parser.add_argument("--opset", type=int, default=13)
    args = parser.parse_args()

    legacy_root = args.legacy_root.resolve()
    weights = args.weights.resolve()
    output = args.output.resolve()
    if not weights.is_file():
        raise FileNotFoundError(weights)
    if not (legacy_root / "hkj_ibkvision").is_dir():
        raise FileNotFoundError(legacy_root / "hkj_ibkvision")

    # Conversion is deterministic and CPU-only.  Keeping TensorFlow away from
    # the online GPU also prevents it from reserving capture-time VRAM.
    os.environ.setdefault("CUDA_VISIBLE_DEVICES", "-1")
    os.environ.setdefault("TF_CPP_MIN_LOG_LEVEL", "2")
    sys.path.insert(0, str(legacy_root))

    import numpy as np
    import onnx
    import tensorflow as tf
    import tf2onnx

    from hkj_ibkvision.hkj_inference.classifier_efficient.x_interface import (
        ClassifierEfficient,
    )

    classifier = ClassifierEfficient(
        args.image_size,
        args.image_size,
        args.classes,
        "efficient_d3",
        str(weights),
    )
    model = classifier.load_model()
    if model is None:
        raise RuntimeError(f"legacy classifier weights could not be loaded: {weights}")

    signature = (
        tf.TensorSpec(
            (None, args.image_size, args.image_size, 3),
            tf.float32,
            name="images",
        ),
    )
    output.parent.mkdir(parents=True, exist_ok=True)
    graph, _ = tf2onnx.convert.from_keras(
        model,
        input_signature=signature,
        opset=args.opset,
        output_path=str(output),
    )
    onnx.checker.check_model(graph)

    probe = np.zeros(
        (1, args.image_size, args.image_size, 3), dtype=np.float32
    )
    reference = model(probe, training=False).numpy()
    print(f"output={output}")
    print(f"source_sha256={sha256_file(weights)}")
    print(f"output_sha256={sha256_file(output)}")
    print(f"input={model.input_shape} output={model.output_shape}")
    print(
        "zero_probe="
        f"class:{int(reference.argmax(axis=1)[0])} "
        f"confidence:{float(reference.max()):.9f}"
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
