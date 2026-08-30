from __future__ import annotations

import copy
import contextlib
import hashlib
import io
import json
import os
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from scripts import validate_algorithm_dataset as validator


def _sha256(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def _write(path: Path, data: bytes) -> dict[str, object]:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(data)
    return {
        "uri": path.name,
        "bytes": len(data),
        "sha256": _sha256(data),
    }


class AlgorithmDatasetValidatorTests(unittest.TestCase):
    def setUp(self) -> None:
        self.temporary = tempfile.TemporaryDirectory()
        self.root = Path(self.temporary.name)
        self.manifest_path = self.root / "dataset.json"
        self.output_path = self.root / "reports" / "validation.json"
        self.annotation_path = self.root / "annotation.json"

        license_ref = _write(self.root / "license.txt", b"approved for qualification\n")
        calibration_ref = _write(self.root / "calibration.json", b'{"revision":"cal-r1"}\n')
        artifact_ref = _write(self.root / "sample-depth.bin", b"depth-evidence")
        self.annotation = {
            "schema": "steel.defect-annotation.v1",
            "annotationId": "annotation-001",
            "sampleId": "sample-001",
            "materialId": "material-001",
            "taxonomyRevision": "taxonomy-r1",
            "status": "adjudicated",
            "disposition": "defect",
            "source": "quality-team",
            "annotator": "annotator-1",
            "reviewer": "reviewer-1",
            "adjudicator": "quality-owner-1",
            "createdAt": "2026-08-01T00:00:00Z",
            "reviewedAt": "2026-08-02T00:00:00Z",
            "adjudicatedAt": "2026-08-03T00:00:00Z",
            "disputes": [],
            "defects": [
                {
                    "defectId": "defect-001",
                    "classId": "pit",
                    "roi2d": {
                        "x": 10,
                        "y": 20,
                        "width": 30,
                        "height": 40,
                        "imageWidth": 256,
                        "imageHeight": 128,
                        "contour": [
                            {"x": 10, "y": 20},
                            {"x": 40, "y": 20},
                            {"x": 40, "y": 60},
                        ],
                    },
                    "measurements": [
                        {"kind": "length", "value": 3.2, "unit": "mm"},
                        {"kind": "area", "value": 5.1, "unit": "mm2"},
                    ],
                }
            ],
        }
        annotation_ref = self._write_annotation()
        self.manifest = {
            "schema": "steel.algorithm-dataset.v1",
            "datasetRevision": "qualification-r1",
            "manifestSha256": "0" * 64,
            "createdAt": "2026-08-04T00:00:00Z",
            "source": {
                "name": "frozen-six-camera-qualification",
                "siteId": "sick-array-6",
                "sensorProfile": "Coord3D_C16+Mono8",
            },
            "accessLevel": "restricted",
            "license": {
                "status": "Approved",
                "purposes": ["qualification", "benchmark"],
                "evidence": license_ref,
            },
            "surface": {
                "geometry": "cylinder",
                "coordinateSystem": "steel-standard-surface-v1",
                "lengthUnit": "mm",
                "depthInvalidValue": 0,
                "calibration": {"revision": "cal-r1", **calibration_ref},
            },
            "taxonomy": {
                "revision": "taxonomy-r1",
                "classes": [
                    {"id": "pit", "name": "凹陷"},
                    {"id": "foreign", "name": "凸起"},
                ],
            },
            "splits": [
                {
                    "name": "qualification",
                    "exclusive": True,
                    "samples": [
                        {
                            "sampleId": "sample-001",
                            "materialId": "material-001",
                            "batchId": "batch-001",
                            "acquisitionBatch": "capture-001",
                            "cameraId": "C1",
                            "artifacts": [
                                {
                                    "artifactId": "artifact-001",
                                    "kind": "depth",
                                    **artifact_ref,
                                }
                            ],
                            "annotation": annotation_ref,
                        }
                    ],
                }
            ],
            "expectedStatistics": {
                "sampleCount": 1,
                "materialCount": 1,
                "batchCount": 1,
                "splitCounts": {"qualification": 1},
                "classCounts": {"pit": 1, "foreign": 0},
            },
        }
        self._write_manifest()

    def tearDown(self) -> None:
        self.temporary.cleanup()

    def _write_annotation(self) -> dict[str, object]:
        data = (json.dumps(self.annotation, ensure_ascii=False, indent=2) + "\n").encode("utf-8")
        self.annotation_path.write_bytes(data)
        return {"uri": self.annotation_path.name, "bytes": len(data), "sha256": _sha256(data)}

    def _refresh_annotation_reference(self) -> None:
        self.manifest["splits"][0]["samples"][0]["annotation"] = self._write_annotation()

    def _write_manifest(self) -> None:
        self.manifest["manifestSha256"] = validator.canonical_manifest_sha256(self.manifest)
        self.manifest_path.write_text(
            json.dumps(self.manifest, ensure_ascii=False, indent=2) + "\n",
            encoding="utf-8",
        )

    def _validate(self, *, purpose: str = "qualification") -> dict[str, object]:
        return validator.validate_dataset(self.manifest_path, purpose=purpose)

    @staticmethod
    def _failure_codes(result: dict[str, object]) -> set[str]:
        return {
            item["code"]
            for item in result["checks"]
            if item["status"] == "failed"
        }

    def test_accepts_frozen_qualification_dataset_and_records_all_checks(self) -> None:
        result = self._validate()

        self.assertEqual(result["status"], "pass")
        self.assertEqual(result["code"], 0)
        self.assertEqual(result["manifest"]["datasetRevision"], "qualification-r1")
        self.assertEqual(result["summary"]["sampleCount"], 1)
        self.assertEqual(result["summary"]["classCounts"], {"foreign": 0, "pit": 1})
        self.assertGreater(result["summary"]["checkCount"], 40)
        self.assertEqual(result["summary"]["errorCount"], 0)

    def test_rejects_tampered_input_bytes(self) -> None:
        (self.root / "sample-depth.bin").write_bytes(b"tampered")

        result = self._validate()

        self.assertEqual(result["status"], "fail")
        self.assertIn("file_size_mismatch", self._failure_codes(result))
        self.assertIn("file_sha256_mismatch", self._failure_codes(result))

    def test_rejects_manifest_identity_mismatch(self) -> None:
        self.manifest["datasetRevision"] = "qualification-r2"
        self.manifest_path.write_text(json.dumps(self.manifest), encoding="utf-8")

        result = self._validate()

        self.assertIn("manifest_hash_mismatch", self._failure_codes(result))

    def test_rejects_path_traversal_even_when_target_exists(self) -> None:
        outside = self.root.parent / f"{self.root.name}-outside.bin"
        outside.write_bytes(b"outside")
        try:
            artifact = self.manifest["splits"][0]["samples"][0]["artifacts"][0]
            artifact.update({"uri": f"../{outside.name}", "bytes": 7, "sha256": _sha256(b"outside")})
            self._write_manifest()

            result = self._validate()

            self.assertIn("path_invalid", self._failure_codes(result))
        finally:
            outside.unlink(missing_ok=True)

    def test_rejects_symlink_or_reparse_escape(self) -> None:
        outside_root = self.root.parent / f"{self.root.name}-outside"
        outside_root.mkdir()
        outside_file = outside_root / "escape.bin"
        outside_file.write_bytes(b"escape")
        link = self.root / "linked"
        simulated_reparse = False
        try:
            try:
                os.symlink(outside_root, link, target_is_directory=True)
            except OSError:
                simulated_reparse = True
                link.mkdir()
                (link / "escape.bin").write_bytes(b"escape")
            artifact = self.manifest["splits"][0]["samples"][0]["artifacts"][0]
            artifact.update({"uri": "linked/escape.bin", "bytes": 6, "sha256": _sha256(b"escape")})
            self._write_manifest()

            if simulated_reparse:
                original = validator._has_reparse_component

                def identify_test_reparse(path: Path) -> bool:
                    return Path(path).name == "escape.bin" or original(path)

                with patch.object(
                    validator,
                    "_has_reparse_component",
                    side_effect=identify_test_reparse,
                ):
                    result = self._validate()
            else:
                result = self._validate()

            self.assertIn("path_reparse_forbidden", self._failure_codes(result))
        finally:
            if link.is_symlink():
                link.unlink()
            elif link.is_dir():
                (link / "escape.bin").unlink(missing_ok=True)
                link.rmdir()
            outside_file.unlink(missing_ok=True)
            outside_root.rmdir()

    def test_rejects_blocked_or_unapproved_license_purpose(self) -> None:
        self.manifest["license"]["status"] = "Blocked"
        self.manifest["license"]["purposes"] = ["benchmark"]
        self.manifest["accessLevel"] = "unknown"
        self._write_manifest()

        result = self._validate()
        codes = self._failure_codes(result)

        self.assertIn("license_blocked", codes)
        self.assertIn("license_purpose_forbidden", codes)
        self.assertIn("access_level_invalid", codes)

    def test_rejects_manifest_outside_the_explicit_approved_root(self) -> None:
        approved_root = self.root / "approved-empty-root"
        approved_root.mkdir()

        result = validator.validate_dataset(
            self.manifest_path,
            data_roots=[approved_root],
        )

        self.assertEqual(result["manifest"]["sha256"], "")
        self.assertIn("manifest_file_invalid", self._failure_codes(result))

    def test_rejects_non_adjudicated_qualification_annotation(self) -> None:
        self.annotation.update(
            {
                "status": "reviewed",
                "adjudicator": None,
                "adjudicatedAt": None,
            }
        )
        self._refresh_annotation_reference()
        self._write_manifest()

        result = self._validate()

        self.assertIn("annotation_status_not_adjudicated", self._failure_codes(result))

    def test_rejects_unknown_taxonomy_and_out_of_bounds_geometry(self) -> None:
        defect = self.annotation["defects"][0]
        defect["classId"] = "unknown"
        defect["roi2d"]["x"] = 250
        self._refresh_annotation_reference()
        self._write_manifest()

        result = self._validate()
        codes = self._failure_codes(result)

        self.assertIn("taxonomy_unknown_class", codes)
        self.assertIn("geometry_out_of_bounds", codes)
        self.assertIn("statistics_mismatch", codes)

    def test_rejects_material_and_batch_split_leakage(self) -> None:
        second_artifact = _write(self.root / "second-depth.bin", b"second")
        second_annotation = copy.deepcopy(self.annotation)
        second_annotation["annotationId"] = "annotation-002"
        second_annotation["sampleId"] = "sample-002"
        second_annotation["defects"][0]["defectId"] = "defect-002"
        second_annotation_path = self.root / "annotation-002.json"
        second_data = (json.dumps(second_annotation, ensure_ascii=False) + "\n").encode("utf-8")
        second_annotation_path.write_bytes(second_data)
        second_sample = {
            "sampleId": "sample-002",
            "materialId": "material-001",
            "batchId": "batch-001",
            "acquisitionBatch": "capture-001",
            "cameraId": "C2",
            "artifacts": [
                {"artifactId": "artifact-002", "kind": "depth", **second_artifact}
            ],
            "annotation": {
                "uri": second_annotation_path.name,
                "bytes": len(second_data),
                "sha256": _sha256(second_data),
            },
        }
        self.manifest["splits"].append(
            {"name": "test", "exclusive": True, "samples": [second_sample]}
        )
        self.manifest["expectedStatistics"].update(
            {
                "sampleCount": 2,
                "splitCounts": {"qualification": 1, "test": 1},
                "classCounts": {"pit": 2, "foreign": 0},
            }
        )
        self._write_manifest()

        result = self._validate()
        codes = self._failure_codes(result)

        self.assertIn("material_split_leakage", codes)
        self.assertIn("batch_split_leakage", codes)
        self.assertIn("acquisition_batch_split_leakage", codes)

    def test_rejects_wrong_measurement_unit_and_aggregate_statistics(self) -> None:
        self.annotation["defects"][0]["measurements"][0]["unit"] = "mm2"
        self._refresh_annotation_reference()
        self.manifest["expectedStatistics"]["sampleCount"] = 99
        self._write_manifest()

        result = self._validate()
        codes = self._failure_codes(result)

        self.assertIn("measurement_unit_invalid", codes)
        self.assertIn("statistics_mismatch", codes)

    def test_cli_atomically_writes_pass_and_fail_reports(self) -> None:
        with contextlib.redirect_stdout(io.StringIO()):
            exit_code = validator.main(
                [
                    "--manifest",
                    str(self.manifest_path),
                    "--output",
                    str(self.output_path),
                ]
            )

        self.assertEqual(exit_code, 0)
        saved = json.loads(self.output_path.read_text(encoding="utf-8"))
        self.assertEqual(saved["schema"], "steel.algorithm-dataset-validation.v1")
        self.assertEqual(saved["status"], "pass")
        self.assertEqual(list(self.output_path.parent.glob(".validation.json.*.tmp")), [])

        (self.root / "sample-depth.bin").write_bytes(b"tampered")
        with contextlib.redirect_stdout(io.StringIO()):
            exit_code = validator.main(
                [
                    "--manifest",
                    str(self.manifest_path),
                    "--output",
                    str(self.output_path),
                ]
            )
        self.assertEqual(exit_code, 1)
        saved = json.loads(self.output_path.read_text(encoding="utf-8"))
        self.assertEqual(saved["status"], "fail")

    def test_cli_refuses_to_alias_or_overwrite_the_manifest(self) -> None:
        original = self.manifest_path.read_bytes()
        with contextlib.redirect_stderr(io.StringIO()):
            exit_code = validator.main(
                [
                    "--manifest",
                    str(self.manifest_path),
                    "--output",
                    str(self.manifest_path.parent / "." / self.manifest_path.name),
                ]
            )

        self.assertEqual(exit_code, 2)
        self.assertEqual(self.manifest_path.read_bytes(), original)

    def test_cli_refuses_to_overwrite_any_resolved_source_asset(self) -> None:
        artifact_path = self.root / "sample-depth.bin"
        original = artifact_path.read_bytes()
        with contextlib.redirect_stderr(io.StringIO()), contextlib.redirect_stdout(io.StringIO()):
            exit_code = validator.main(
                [
                    "--manifest",
                    str(self.manifest_path),
                    "--output",
                    str(artifact_path),
                ]
            )

        self.assertEqual(exit_code, 2)
        self.assertEqual(artifact_path.read_bytes(), original)


class ReproducibilitySchemaTests(unittest.TestCase):
    def test_all_proposed_contract_schemas_are_strict_draft_2020_12(self) -> None:
        root = Path(__file__).resolve().parents[1]
        names = [
            "steel.reproduction-manifest.v1.schema.json",
            "steel.algorithm-dataset.v1.schema.json",
            "steel.defect-annotation.v1.schema.json",
            "steel.algorithm-benchmark.v1.schema.json",
            "steel.algorithm-dataset-validation.v1.schema.json",
        ]
        for name in names:
            with self.subTest(name=name):
                payload = json.loads(
                    (root / "packages" / "contracts" / "schemas" / name).read_text(
                        encoding="utf-8"
                    )
                )
                self.assertEqual(
                    payload["$schema"],
                    "https://json-schema.org/draft/2020-12/schema",
                )
                self.assertFalse(payload["additionalProperties"])
                self.assertEqual(payload["$id"], name[: -len(".schema.json")])


if __name__ == "__main__":
    unittest.main()
