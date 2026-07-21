import json
import math
import os
import tempfile
import unittest
from pathlib import Path

import bkv_d3img as subject
import bkv_legacy_import as legacy_import
import test_bkv_legacy_import as legacy_tests


class D3ImageProbeTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.root = Path(self.temporary.name)

    def tearDown(self):
        self.temporary.cleanup()

    def write(self, name: str, payload: bytes) -> Path:
        path = self.root / name
        path.write_bytes(payload)
        return path

    def test_truncated_header_is_invalid_without_an_exception(self):
        probe = subject.probe_d3img(self.write("truncated.d3img", b"3DI"))
        self.assertEqual(probe.schema, "steel.bkv-d3img-probe.v1")
        self.assertEqual(probe.status, "invalid")
        self.assertEqual(probe.reason, "truncated_header")

    def test_unknown_magic_is_stably_unsupported(self):
        probe = subject.probe_d3img(self.write("unknown.d3img", b"PNG123" + b"\0" * 64))
        self.assertEqual(probe.status, "unsupported")
        self.assertEqual(probe.reason, "unsupported_magic")

    def test_observed_legacy_magic_is_probe_only(self):
        path = self.write("legacy.d3img", b"3DImg\0" + bytes(range(64)))
        probe = subject.probe_d3img(path)
        self.assertEqual(probe.status, "unsupported")
        self.assertEqual(probe.reason, "no_evidenced_decoder")
        self.assertEqual(probe.magicHex, "3344496d6700")
        self.assertEqual(len(probe.sha256), 64)
        with self.assertRaisesRegex(subject.UnsupportedFormatError, "no evidenced decoder"):
            subject.decode_d3img(path, subject.UNSUPPORTED_EVIDENCE_CONTRACT)

    def test_contract_rejects_absurd_dimensions_and_multiplication_overflow(self):
        base = subject.unsupported_contract_template()
        for width, height, reason in (
            (subject.MAX_DIMENSION + 1, 1, "dimension_out_of_range"),
            (subject.MAX_DIMENSION, subject.MAX_DIMENSION, "pixel_count_out_of_range"),
        ):
            contract = dict(base, width=width, height=height)
            with self.subTest(reason=reason):
                with self.assertRaisesRegex(subject.InvalidContractError, reason):
                    subject.validate_evidence_contract(contract)

    def test_contract_rejects_unsupported_magic_and_version(self):
        base = subject.unsupported_contract_template()
        for changes, reason in (
            ({"magicHex": "000000000000"}, "unsupported_magic"),
            ({"version": 999}, "unsupported_version"),
        ):
            with self.subTest(reason=reason):
                with self.assertRaisesRegex(subject.InvalidContractError, reason):
                    subject.validate_evidence_contract(dict(base, **changes))

    def test_contract_rejects_non_finite_statistics(self):
        base = subject.unsupported_contract_template()
        for value in (math.nan, math.inf, -math.inf):
            with self.subTest(value=value):
                contract = dict(base, statistics={"minimum": value, "maximum": 1.0})
                with self.assertRaisesRegex(subject.InvalidContractError, "non_finite_statistics"):
                    subject.validate_evidence_contract(contract)

    def test_cli_writes_structured_probe_and_returns_two(self):
        source = self.write("legacy.d3img", b"3DImg\0" + b"\0" * 64)
        output = self.root / "probe.json"
        result = subject.main(["probe", "--input", str(source), "--json", str(output)])
        self.assertEqual(result, 2)
        document = json.loads(output.read_text(encoding="utf-8"))
        self.assertEqual(document["schema"], "steel.bkv-d3img-probe.v1")
        self.assertEqual(document["status"], "unsupported")

    def test_cli_never_overwrites_input_via_same_path_or_relative_alias(self):
        source = self.write("legacy.d3img", b"3DImg\0" + b"source-bytes")
        original = source.read_bytes()
        aliases = [source, self.root / "child" / ".." / source.name]
        (self.root / "child").mkdir()
        hardlink = self.root / "hardlink.d3img"
        try:
            os.link(source, hardlink)
        except OSError:
            pass
        else:
            aliases.append(hardlink)
        for output in aliases:
            with self.subTest(output=output):
                result = subject.main(
                    ["probe", "--input", str(source), "--json", str(output)]
                )
                self.assertEqual(result, 2)
                self.assertEqual(source.read_bytes(), original)

    def test_staging_diagnostic_uses_manifest_status_vocabulary(self):
        source = self.write("legacy.d3img", b"3DImg\0" + b"\0" * 64)
        diagnostic = legacy_import._depth_decode_evidence(source)
        self.assertEqual(diagnostic["status"], "unsupported")
        self.assertEqual(diagnostic["reason"], "no_evidenced_decoder")
        self.assertEqual(diagnostic["probeSchema"], "steel.bkv-d3img-probe.v1")

    def test_batch_content_id_binds_depth_decode_evidence(self):
        archives = {
            name: {"size": 1, "sha256": character * 64}
            for name, character in (
                ("database-zip", "a"),
                ("image-part1", "b"),
                ("image-part2", "c"),
            )
        }
        artifact = {
            "memberPath": "image_copy/CamImageSource1/1893700/3D/0000.d3img",
            "sha256": "d" * 64,
            "extension": ".d3img",
            "depthDecode": {"status": "unsupported", "reason": "no_evidenced_decoder"},
        }
        arguments = {
            "source_archives": archives,
            "normalization_sha256": "e" * 64,
            "result_evidence": {},
            "seq_nos": list(legacy_import.TARGET_SEQ_NOS),
        }
        first = legacy_import._compute_batch_content_id(artifacts=[artifact], **arguments)
        changed = dict(artifact)
        changed["depthDecode"] = {"status": "decoded", "reason": "future-contract"}
        second = legacy_import._compute_batch_content_id(artifacts=[changed], **arguments)
        self.assertNotEqual(first, second)

    def _stage_fixture(self, *, depth_payload=b"depth-one"):
        fixture = legacy_tests.ExtractionTests(methodName="runTest")
        fixture.setUp()
        self.addCleanup(fixture.tearDown)
        key = "image_copy/CamImageSource1/1893700/3D/one.d3img"
        fixture.payloads[key] = depth_payload
        fixture._use_complete_target_coverage()
        return fixture, fixture._stage()

    def test_invalid_depth_forces_partial_but_unsupported_can_remain_ready(self):
        _, unsupported_batch = self._stage_fixture(depth_payload=b"depth-one")
        unsupported = json.loads(
            (unsupported_batch / "manifest.json").read_text(encoding="utf-8")
        )
        self.assertEqual(unsupported["status"], "ready")
        self.assertEqual(
            next(
                item["depthDecode"]["status"]
                for item in unsupported["artifacts"]
                if item["extension"] == ".d3img"
            ),
            "unsupported",
        )

        fixture, invalid_batch = self._stage_fixture(depth_payload=b"3DI")
        invalid = json.loads(
            (invalid_batch / "manifest.json").read_text(encoding="utf-8")
        )
        self.assertEqual(invalid["status"], "partial")
        self.assertFalse(invalid["importEligible"])
        self.assertTrue(invalid["reviewRequired"])
        self.assertFalse(
            legacy_import.batch_is_importable(
                invalid_batch,
                expected_content_id=invalid["batchContentId"],
                **fixture._deep_kwargs(),
            )
        )

    def test_batch_verifier_rejects_all_depth_diagnostic_tampering(self):
        _, batch = self._stage_fixture()
        manifest_path = batch / "manifest.json"
        base_manifest_bytes = manifest_path.read_bytes()
        base = json.loads(base_manifest_bytes)
        depth = next(item for item in base["artifacts"] if item["extension"] == ".d3img")
        depth_path = batch / Path(depth["path"])
        base_depth_bytes = depth_path.read_bytes()

        mutations = {
            "status": lambda manifest: next(
                item for item in manifest["artifacts"] if item["extension"] == ".d3img"
            )["depthDecode"].update(status="decoded"),
            "reason": lambda manifest: next(
                item for item in manifest["artifacts"] if item["extension"] == ".d3img"
            )["depthDecode"].update(reason="forged"),
            "parserVersion": lambda manifest: next(
                item for item in manifest["artifacts"] if item["extension"] == ".d3img"
            )["depthDecode"].update(parserVersion="forged/99"),
            "originalSha256": lambda manifest: next(
                item for item in manifest["artifacts"] if item["extension"] == ".d3img"
            )["depthDecode"].update(originalSha256="0" * 64),
            "non-depth injection": lambda manifest: next(
                item for item in manifest["artifacts"] if item["extension"] == ".jpg"
            ).update(depthDecode=dict(depth["depthDecode"])),
        }
        for label, mutate in mutations.items():
            with self.subTest(label=label):
                manifest = json.loads(base_manifest_bytes)
                mutate(manifest)
                manifest_path.write_text(json.dumps(manifest), encoding="utf-8")
                with self.assertRaises(ValueError):
                    legacy_import._verify_staged_batch(batch, deep_source=False)
                manifest_path.write_bytes(base_manifest_bytes)

        depth_path.write_bytes(base_depth_bytes + b"tampered")
        with self.assertRaises(ValueError):
            legacy_import._verify_staged_batch(batch, deep_source=False)


if __name__ == "__main__":
    unittest.main()
