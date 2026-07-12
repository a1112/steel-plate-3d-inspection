import argparse
import hashlib
import json
import os
from pathlib import Path
import signal
import socket
import stat
import subprocess
import tempfile
import threading
import time
import urllib.error
import urllib.parse
import urllib.request


def require(condition, message):
    if not condition:
        raise AssertionError(message)


def free_port():
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as listener:
        listener.bind(("127.0.0.1", 0))
        return listener.getsockname()[1]


class CaptureService:
    def __init__(self, executable, root, delay_ms, queue_items=4,
                 calibration_fail_ip="", crash_operation_id="",
                 crash_phase="", crash_camera_index=0):
        self.port = free_port()
        self.root = Path(root)
        environment = os.environ.copy()
        environment.update(
            CAPTURE_STORAGE_ROOT=str(self.root),
            CAPTURE_CONFIG_ROOT=str(self.root / "config"),
            CAPTURE_STORAGE_WORKERS="1",
            CAPTURE_STORAGE_QUEUE_ITEMS=str(queue_items),
            CAPTURE_STORAGE_QUEUE_BYTES=str(128 * 1024 * 1024),
            CAPTURE_STORAGE_PENDING_TICKETS="4",
            CAPTURE_STORAGE_ENQUEUE_TIMEOUT_MS="5000",
            CAPTURE_SIMULATED_STORAGE_DELAY_MS=str(delay_ms),
            CAPTURE_SIMULATED_CALIBRATION_FAIL_IP=calibration_fail_ip,
        )
        if crash_operation_id and crash_phase and crash_camera_index:
            environment.update(
                CAPTURE_CALIBRATION_CRASH_CONFIRMATION=(
                    "ALLOW CONTROLLED CAMERA CALIBRATION PROCESS CRASH"
                ),
                CAPTURE_CALIBRATION_CRASH_OPERATION_ID=crash_operation_id,
                CAPTURE_CALIBRATION_CRASH_PHASE=crash_phase,
                CAPTURE_CALIBRATION_CRASH_CAMERA_INDEX=str(crash_camera_index),
            )
        self.process = subprocess.Popen(
            [str(executable), "--port", str(self.port), "--driver", "simulated"],
            env=environment,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
            creationflags=subprocess.CREATE_NEW_PROCESS_GROUP,
        )
        deadline = time.monotonic() + 10
        while time.monotonic() < deadline:
            try:
                health = self.request("/health", timeout=0.5)
                require(health.get("driverMode") == "simulated", "isolated service did not use simulated driver")
                return
            except Exception:
                if self.process.poll() is not None:
                    raise RuntimeError(f"capture service exited during startup: {self.process.returncode}")
                time.sleep(0.05)
        raise RuntimeError("capture service did not become ready")

    def request(self, path, body=None, timeout=20):
        payload = None if body is None else json.dumps(body).encode("utf-8")
        request = urllib.request.Request(
            f"http://127.0.0.1:{self.port}{path}",
            data=payload,
            headers={"Content-Type": "application/json"},
            method="GET" if payload is None else "POST",
        )
        with urllib.request.urlopen(request, timeout=timeout) as response:
            return json.loads(response.read())

    def capture_file(self, path, timeout=10):
        encoded = urllib.parse.quote(str(path), safe="")
        with urllib.request.urlopen(
            f"http://127.0.0.1:{self.port}/api/capture/file?path={encoded}",
            timeout=timeout,
        ) as response:
            return response.status, response.read()

    def stop(self, timeout=10):
        if self.process.poll() is None:
            self.process.send_signal(signal.CTRL_BREAK_EVENT)
        self.process.wait(timeout=timeout)
        require(self.process.returncode == 0, f"graceful shutdown returned {self.process.returncode}")

    def kill(self):
        if self.process.poll() is None:
            self.process.kill()
            self.process.wait(timeout=5)


def rejected_json(service, path, body, expected_status):
    try:
        service.request(path, body)
    except urllib.error.HTTPError as error:
        payload = json.loads(error.read())
        require(error.code == expected_status,
                f"{path} returned HTTP {error.code}, expected {expected_status}")
        return payload
    raise AssertionError(f"{path} was not rejected with HTTP {expected_status}")


def capture_body(output_dir, rounds):
    return {
        "ips": [f"192.168.200.{number}" for number in range(101, 105)],
        "expectedCameras": 4,
        "rounds": rounds,
        "width": 160,
        "lines": 96,
        "intervalMs": 0,
        "retries": 0,
        "outputDir": str(output_dir),
    }


def calibration_artifacts(root):
    folder = Path(root) / "calibration-contract"
    folder.mkdir(parents=True, exist_ok=True)
    array_xml = folder / "ArrayCalibration.corrected.xml"
    camera_one = folder / "camera-101.xml"
    camera_two = folder / "camera-102.xml"
    array_xml.write_text(
        "<ArrayCalib-parameter><SN_1><CalibParam><Matrix0>1,0,0,0</Matrix0>"
        "<BlendMethod>0</BlendMethod></CalibParam></SN_1></ArrayCalib-parameter>",
        encoding="utf-8",
    )
    camera_one.write_text("<CameraCalibration><Dir X='1'/></CameraCalibration>", encoding="utf-8")
    camera_two.write_text("<CameraCalibration><Dir X='2'/></CameraCalibration>", encoding="utf-8")
    return array_xml, camera_one, camera_two


def calibration_apply_body(root, dry_run=False):
    array_xml, camera_one, camera_two = calibration_artifacts(root)
    ips = ["192.168.200.101", "192.168.200.102"]
    body = {
        "path": str(array_xml),
        "ips": ips,
        "expectedCameras": 2,
        "requireAllMapped": True,
        "persistActive": False,
        "dryRun": dry_run,
        "atomic": True,
        "cameraCalibrations": [
            {"ip": ips[0], "path": str(camera_one), "artifactType": "camera-sdk"},
            {"ip": ips[1], "path": str(camera_two), "artifactType": "camera-sdk"},
        ],
    }
    if not dry_run:
        body["confirmation"] = "APPLY CAMERA CALIBRATION SET"
    return body


def frame_transaction_and_overlap(executable, root):
    service = CaptureService(executable, root, delay_ms=50)
    try:
        started = time.monotonic()
        summary = service.request(
            "/api/capture/continuous-test",
            capture_body(Path(root) / "pipeline", rounds=3),
            timeout=30,
        )
        elapsed = time.monotonic() - started
        require(summary.get("code") == 0, "continuous capture failed")
        require(summary.get("attempts") == 12, "unexpected attempt count")
        require(summary.get("completeFrames") == 12, "frame transaction count is incomplete")
        require(summary.get("metadataFrames") == 12, "metadata-last commits are incomplete")
        require(summary.get("storageAsyncFrames") == 12, "frames did not use storage tickets")
        require(summary.get("captureStorageOverlappedRounds", 0) > 0, "capture and storage did not overlap")
        require(elapsed < 10, "bounded pipeline test took unexpectedly long")

        queue = service.request("/api/storage/status")["queue"]
        require(queue.get("simulatedStorageDelayMs") == 50, "test storage delay is not observable")
        require(queue.get("highWaterItems", 0) > 1, "queue did not retain multiple frame transactions")
        require(queue.get("pendingItems") == 0, "queue did not drain before the response")

        tickets = set()
        metadata_paths = set()
        for frame in summary["results"]:
            require(frame.get("completeFrame"), "response exposed an incomplete frame")
            require(frame.get("depthPersistenceMode") == "simulated-owned-pixels16", "unexpected simulated persistence mode")
            tickets.add(frame["storageTicketId"])
            for key in ("depthOutput", "intensityOutput", "metadataOutput"):
                require(Path(frame[key]).is_file(), f"missing {key}")
            metadata_path = Path(frame["metadataOutput"])
            metadata_paths.add(str(metadata_path))
            metadata = json.loads(metadata_path.read_text(encoding="utf-8"))
            require(metadata.get("schema") == "steel.capture.frame.v2", "wrong frame schema")
            require(metadata.get("completeFrame") is True, "metadata committed an incomplete frame")
            require(metadata.get("metadataCommit") == "last", "metadata was not the final commit marker")
        require(len(tickets) == 12, "storage ticket IDs are not unique")
        require(len(metadata_paths) == 12, "frame outputs reused metadata paths")
        allowed_status, allowed_body = service.capture_file(summary["results"][0]["depthOutput"])
        require(allowed_status == 200 and allowed_body, "capture file under storage root was not served")
        try:
            service.capture_file(Path(__file__).resolve())
            raise AssertionError("capture file endpoint exposed a file outside configured roots")
        except urllib.error.HTTPError as error:
            require(error.code == 403, "outside capture file should be rejected with HTTP 403")

        dry_run_body = calibration_apply_body(root, dry_run=True)
        dry_run = service.request("/api/calibration/apply-all", dry_run_body)
        require(dry_run.get("code") == 0 and dry_run.get("dryRun") is True,
                "calibration dry-run preflight failed")
        require(dry_run.get("saveToDevice") is False, "saveToDevice must default to false")
        require(dry_run.get("rollbackToken") == "", "dry-run must not allocate a rollback token")
        capabilities = dry_run.get("contractCapabilities", {})
        require(capabilities.get("rollbackTokenDurability") == "cross-restart-file-only"
                and capabilities.get("rollbackFileFingerprint") == "sha256+size"
                and capabilities.get("rollbackManifest") == "atomic-write-ahead-v1"
                and capabilities.get("rollbackRestartRecovery") is True
                and capabilities.get("rollbackRecoveryFence") is True
                and capabilities.get("calibrationCrashFailpoint")
                == "explicit-env-operation-phase-camera-bound-v1"
                and capabilities.get("rollbackRecoveryStatus") == 423,
                "capture capabilities do not advertise durable file-only rollback")
        require(all(item.get("attempted") is False for item in dry_run["results"]),
                "dry-run made a camera SDK call")
        invalid_operation = dict(dry_run_body)
        invalid_operation["operationId"] = "bad\noperation"
        invalid_operation_result = service.request(
            "/api/calibration/apply-all", invalid_operation
        )
        require(invalid_operation_result.get("code") == 400,
                "calibration provider accepted an unsafe operationId")
        duplicate_targets = dict(dry_run_body)
        duplicate_targets["ips"] = [
            dry_run_body["ips"][0],
            dry_run_body["ips"][0],
            dry_run_body["ips"][1],
        ]
        duplicate_result = service.request(
            "/api/calibration/apply-all", duplicate_targets
        )
        require(duplicate_result.get("code") == 49009,
                "duplicate target camera IP did not fail preflight")
        require(len(duplicate_result.get("results", [])) == 2,
                "duplicate target IP was not reduced to unique camera results")
        duplicate_camera = next(
            item for item in duplicate_result["results"]
            if item.get("ip") == dry_run_body["ips"][0]
        )
        require(duplicate_camera.get("preflightCode") == 49009,
                "duplicate target IP was not explicit in the per-camera result")
        require(not any(item.get("ip") == "*" for item in duplicate_result["results"]),
                "expectedCameras was not evaluated against unique target IPs")
        duplicate_artifacts = json.loads(json.dumps(dry_run_body))
        duplicate_artifacts["cameraCalibrations"][1]["path"] = (
            duplicate_artifacts["cameraCalibrations"][0]["path"]
        )
        duplicate_artifact_result = service.request(
            "/api/calibration/apply-all", duplicate_artifacts
        )
        require(duplicate_artifact_result.get("code") == 49009,
                "one SDK calibration artifact was accepted for multiple cameras")
        duplicate_artifact_items = [
            item for item in duplicate_artifact_result.get("results", [])
            if item.get("preflightCode") == 49009
            and "distinct SDK calibration artifact" in item.get("message", "")
        ]
        require(len(duplicate_artifact_items) == 2,
                "duplicate SDK artifact was not explicit for both camera mappings")
        single_ip = dry_run_body["ips"][0]
        single_path = dry_run_body["cameraCalibrations"][0]["path"]
        single_dry = service.request(
            "/api/calibration/load",
            {"ip": single_ip, "path": single_path, "dryRun": True},
        )
        require(single_dry.get("code") == 0 and single_dry.get("dryRun") is True,
                "single-camera dry-run unexpectedly required confirmation")
        single_unconfirmed = service.request(
            "/api/calibration/load", {"ip": single_ip, "path": single_path}
        )
        require(single_unconfirmed.get("code") == 49012,
                "single-camera apply accepted a missing confirmation")
        single_applied = service.request(
            "/api/calibration/load",
            {
                "ip": single_ip,
                "path": single_path,
                "confirmation": "APPLY CAMERA CALIBRATION",
            },
        )
        require(single_applied.get("code") == 0 and single_applied.get("applied") == 1,
                "single-camera confirmed apply failed")
        single_rollback = service.request(
            "/api/calibration/rollback",
            {
                "rollbackToken": single_applied["rollbackToken"],
                "confirmation": "ROLLBACK CAMERA CALIBRATION",
            },
        )
        require(single_rollback.get("code") == 0,
                "single-camera rollback failed")
        roi_unconfirmed = service.request(
            "/api/roi/load", {"ip": single_ip, "path": single_path}
        )
        require(roi_unconfirmed.get("code") == 49012,
                "ROI apply accepted a missing confirmation")
        roi_applied = service.request(
            "/api/roi/load",
            {
                "ip": single_ip,
                "path": single_path,
                "confirmation": "APPLY CAMERA ROI",
            },
        )
        require(roi_applied.get("code") == 0 and roi_applied.get("roiCode") == 0,
                "confirmed simulated ROI apply failed")
        external_roi = Path(root).parent / "external-roi.xml"
        external_roi.write_text("<Roi><Enabled>1</Enabled></Roi>", encoding="utf-8")
        roi_external_denied = service.request(
            "/api/roi/load",
            {
                "ip": single_ip,
                "path": str(external_roi),
                "confirmation": "APPLY CAMERA ROI",
            },
        )
        require(roi_external_denied.get("code") == 403,
                "ROI path outside storage/config bypassed allowExternal=false")
        roi_external_allowed = service.request(
            "/api/roi/load",
            {
                "ip": single_ip,
                "path": str(external_roi),
                "allowExternal": True,
                "confirmation": "APPLY CAMERA ROI",
            },
        )
        require(roi_external_allowed.get("code") == 0,
                "explicit external ROI maintenance path was not accepted")
        validation = service.request(
            "/api/capture/depth-map",
            {
                "ip": single_ip,
                "lines": 32,
                "width": 64,
                "output": "maintenance/validation-frame.png",
                "calibrationMaintenanceRecord": True,
            },
        )
        require(validation.get("code") == 0,
                "calibration validation frame capture failed")
        maintenance_record = Path(root) / "maintenance" / "calibration-records.jsonl"
        require(maintenance_record.is_file(),
                "calibration maintenance record was not persisted")
        maintenance_actions = {
            json.loads(line)["action"]
            for line in maintenance_record.read_text(encoding="utf-8").splitlines()
            if line.strip()
        }
        require({"calibration-apply", "calibration-rollback", "roi-apply", "validation-frame"}
                <= maintenance_actions,
                "calibration maintenance record is missing an operator action")
        device_dry_run = dict(dry_run_body)
        device_dry_run["saveToDevice"] = True
        device_unconfirmed = service.request("/api/calibration/apply-all", device_dry_run)
        require(device_unconfirmed.get("code") == 49012,
                "saveToDevice accepted a missing deviceConfirmation phrase")

        array_misuse = dict(dry_run_body)
        array_misuse["cameraCalibrations"] = [
            {"ip": ip, "path": dry_run_body["path"], "artifactType": "camera-sdk"}
            for ip in dry_run_body["ips"]
        ]
        rejected = service.request("/api/calibration/apply-all", array_misuse)
        require(rejected.get("code") == 49009 and rejected.get("applied") == 0,
                "array reconstruction XML was not rejected as a camera SDK file")
        require(all(item.get("preflightCode") == 49008 for item in rejected["results"]),
                "array/camera artifact mismatch was not explicit per camera")

        confirmed_body = calibration_apply_body(root, dry_run=False)
        profile_name = "calibration-contract-test"
        profile_before = {
            "name": profile_name,
            "arrayCalibrationFile": "",
            "activeCalibration": {},
        }
        saved_profile = service.request(
            "/api/config/profile/save",
            {
                "name": profile_name,
                "profileJson": json.dumps(profile_before),
                "makeActive": False,
            },
        )
        require(saved_profile.get("code") == 0, "calibration test profile could not be saved")
        confirmed_body["name"] = profile_name
        confirmed_body["persistActive"] = True
        confirmed_body["operationId"] = "calop-apply-contract-001"
        unconfirmed_body = dict(confirmed_body)
        unconfirmed_body.pop("confirmation")
        unconfirmed = service.request("/api/calibration/apply-all", unconfirmed_body)
        require(unconfirmed.get("code") == 49012,
                "direct calibration apply accepted a missing confirmation phrase")
        applied = service.request("/api/calibration/apply-all", confirmed_body)
        require(applied.get("code") == 0 and applied.get("applied") == 2,
                "per-camera simulated calibration apply failed")
        require(applied.get("operationId") == confirmed_body["operationId"],
                "calibration apply response lost its operationId")
        require(all(item.get("operationId") == confirmed_body["operationId"]
                    for item in applied.get("results", [])),
                "per-camera calibration evidence lost its operationId")
        rollback_token = applied.get("rollbackToken", "")
        require(rollback_token, "successful calibration apply did not return rollbackToken")
        active_after_apply = service.request(
            f"/api/calibration/active?profile={profile_name}"
        )
        require(active_after_apply.get("artifactKind") == "array-reconstruction",
                "successful apply did not persist the array reconstruction pointer")
        require(active_after_apply.get("activeCalibration", {}).get("operationId")
                == confirmed_body["operationId"],
                "active calibration metadata lost the apply operationId")
        rollback_unconfirmed = service.request(
            "/api/calibration/rollback", {"rollbackToken": rollback_token}
        )
        require(rollback_unconfirmed.get("code") == 49012,
                "direct calibration rollback accepted a missing confirmation phrase")
        rollback_operation_id = "calop-rollback-contract-001"
        rollback = service.request(
            "/api/calibration/rollback",
            {
                "rollbackToken": rollback_token,
                "operationId": rollback_operation_id,
                "confirmation": "ROLLBACK CAMERA CALIBRATION",
            },
        )
        require(rollback.get("code") == 0 and rollback.get("complete") is True,
                "manual calibration rollback failed")
        require(len(rollback.get("results", [])) == 2,
                "manual rollback did not report every camera")
        require(rollback.get("rolledBack") == 2 and rollback.get("failed") == 0,
                "manual rollback aggregate counters are incomplete")
        require(rollback.get("operationId") == rollback_operation_id
                and rollback.get("applyOperationId") == confirmed_body["operationId"],
                "manual rollback response lost operation correlation")
        require(all(item.get("rollbackCode") == 0 and item.get("rolledBack") is True
                    for item in rollback["results"]),
                "manual rollback per-camera schema is incomplete")
        require(all(item.get("operationId") == rollback_operation_id
                    for item in rollback["results"]),
                "manual rollback per-camera evidence lost its operationId")
        correlated_records = [
            json.loads(line)
            for line in maintenance_record.read_text(encoding="utf-8").splitlines()
            if line.strip()
        ]
        require(any(record.get("action") == "calibration-apply"
                    and record.get("operationId") == confirmed_body["operationId"]
                    for record in correlated_records),
                "maintenance JSONL lost the apply operationId")
        require(any(record.get("action") == "calibration-rollback"
                    and record.get("operationId") == rollback_operation_id
                    for record in correlated_records),
                "maintenance JSONL lost the rollback operationId")
        status_after_rollback = service.request(
            f"/api/calibration/status?ip={single_ip}"
        )
        require(status_after_rollback.get("operationId") == rollback_operation_id,
                "calibration status lost the most recent operationId")
        active_after_rollback = service.request(
            f"/api/calibration/active?profile={profile_name}"
        )
        require(active_after_rollback.get("calibrationFile") == "",
                "manual rollback did not restore the previous profile file state")

        generation_body = calibration_apply_body(root, dry_run=False)
        generation_body["persistActive"] = False
        first_generation = service.request(
            "/api/calibration/apply-all", generation_body
        )
        second_generation = service.request(
            "/api/calibration/apply-all", generation_body
        )
        require(first_generation.get("code") == 0 and second_generation.get("code") == 0,
                "calibration generation binding setup failed")
        stale_generation = service.request(
            "/api/calibration/rollback",
            {
                "rollbackToken": first_generation["rollbackToken"],
                "confirmation": "ROLLBACK CAMERA CALIBRATION",
            },
        )
        require(stale_generation.get("code") == 49010,
                "stale rollback token was not bound to the current calibration generation")
        require(stale_generation.get("attempted") is False
                and stale_generation.get("sideEffects") is False,
                "stale generation rejection did not prove zero SDK writes")
        current_generation = service.request(
            "/api/calibration/rollback",
            {
                "rollbackToken": second_generation["rollbackToken"],
                "confirmation": "ROLLBACK CAMERA CALIBRATION",
            },
        )
        require(current_generation.get("code") == 0,
                "current calibration generation rollback failed")

        persistent_body = calibration_apply_body(root, dry_run=False)
        persistent_body["operationId"] = "calop-restart-durable-001"
        persistent_body["saveToDevice"] = True
        persistent_body["deviceConfirmation"] = "PERSIST CAMERA PARAMETERS"
        for mapping in persistent_body["cameraCalibrations"]:
            mapping["rollbackPath"] = mapping["path"]
        persistent_apply = service.request(
            "/api/calibration/apply-all", persistent_body
        )
        require(persistent_apply.get("code") == 0,
                 "persistent calibration rollback fingerprint setup failed")
        manifest_paths = list(
            (Path(root) / "config" / "calibration-rollbacks"
             / persistent_apply["rollbackToken"]).rglob("manifest.json")
        )
        require(len(manifest_paths) == 1,
                "durable calibration apply did not publish one token manifest")
        manifest = json.loads(manifest_paths[0].read_text(encoding="utf-8"))
        require(manifest.get("phase") == "applied"
                and manifest.get("consumed") is False
                and manifest.get("durable") is True,
                "rollback manifest was not finalized as an unconsumed applied record")
        require(manifest.get("operationId") == persistent_body["operationId"],
                "rollback manifest lost apply operation correlation")
        require(len(manifest.get("cameras", [])) == 2
                and all(item.get("attempted") is True
                        and len(item.get("sha256", "")) == 64
                        and item.get("size", 0) > 0
                        for item in manifest["cameras"]),
                "rollback manifest lost per-camera SN/hash/size/attempt evidence")
        staged_paths = [Path(item["stagedPreviousPath"])
                        for item in manifest["cameras"]]
        staged_contents = [path.read_bytes() for path in staged_paths]
        require(all(path.is_file() for path in staged_paths),
                "durable rollback staged previous files are missing")
        require(all(hashlib.sha256(contents).hexdigest() == item["sha256"]
                    and len(contents) == item["size"]
                    for contents, item in zip(staged_contents, manifest["cameras"])),
                "rollback manifest SHA-256/size does not match staged contents")

        original_paths = [Path(mapping["rollbackPath"])
                          for mapping in persistent_body["cameraCalibrations"]]
        original_paths[0].write_text(
            original_paths[0].read_text(encoding="utf-8")
            + "<!-- caller source changed after apply -->",
            encoding="utf-8",
        )
        original_paths[1].unlink()
        require([path.read_bytes() for path in staged_paths] == staged_contents,
                "caller rollbackPath mutation changed an immutable staged previous file")

        # Simulate a process crash after write-ahead attempted markers were
        # durable but before the provider could finalize the applied phase.
        manifest["phase"] = "applying"
        manifest_paths[0].write_text(
            json.dumps(manifest, separators=(",", ":")), encoding="utf-8"
        )

        service.stop()
        service = CaptureService(executable, root, delay_ms=50)
        recovery_health = service.request("/health")
        require(recovery_health.get("recoveryRequired") is True
                and recovery_health.get("invalidManifest") is False
                and recovery_health.get("pendingRecoveryCount", 0) >= 1
                and recovery_health.get("sdkReady") is False
                and recovery_health.get("ready") is False,
                "applying manifest did not close provider readiness after restart")
        restart_ips = capture_body(Path(root) / "restart-connect", rounds=1)["ips"]
        reconnected = service.request(
            "/api/cameras/connect-all",
            {"ips": restart_ips, "expectedCameras": 4},
        )
        require(reconnected.get("code") == 0 and reconnected.get("connected") == 4,
                "restart rollback cameras did not reconnect")

        blocked_capture = rejected_json(
            service,
            "/api/capture/depth-map",
            {
                "ip": persistent_body["ips"][0],
                "lines": 16,
                "width": 32,
                "output": "recovery-fence-must-not-write.png",
            },
            423,
        )
        blocked_apply = rejected_json(
            service, "/api/calibration/apply-all", persistent_body, 423
        )
        require(blocked_capture.get("code") == 423
                and blocked_apply.get("code") == 423
                and blocked_capture.get("recoveryRequired") is True
                and blocked_apply.get("recoveryRequired") is True,
                "calibration recovery fence did not reject new capture/apply writes")
        require(not (Path(root) / "recovery-fence-must-not-write.png").exists(),
                "recovery-fenced capture wrote an artifact")

        staged_paths[0].chmod(stat.S_IREAD | stat.S_IWRITE)
        staged_paths[0].write_bytes(staged_contents[0] + b"<!-- staged tamper -->")
        changed_staged = service.request(
            "/api/calibration/rollback",
            {
                "rollbackToken": persistent_apply["rollbackToken"],
                "operationId": "calop-restart-hash-check-001",
                "confirmation": "ROLLBACK CAMERA CALIBRATION",
            },
        )
        require(changed_staged.get("code") == 49010,
                "changed staged previous file was not rejected before device writes")
        require(changed_staged.get("attempted") is False
                and changed_staged.get("sideEffects") is False,
                "staged hash rejection did not prove zero SDK writes")
        health_after_hash_rejection = service.request("/health")
        require(health_after_hash_rejection.get("recoveryRequired") is True,
                "failed recovery unexpectedly opened provider readiness")
        staged_paths[0].write_bytes(staged_contents[0])
        staged_paths[0].chmod(stat.S_IREAD)
        restored_rollback = service.request(
            "/api/calibration/rollback",
            {
                "rollbackToken": persistent_apply["rollbackToken"],
                "operationId": "calop-restart-rollback-001",
                "confirmation": "ROLLBACK CAMERA CALIBRATION",
            },
        )
        require(restored_rollback.get("code") == 0
                and restored_rollback.get("complete") is True
                and restored_rollback.get("rolledBack") == 2,
                "clean-restart file-only rollback could not restore every camera")
        require(all("previous-sdk-file" in item.get("rollbackMode", "")
                    or item.get("rollbackMode") == "simulated-process-state"
                    for item in restored_rollback.get("results", [])),
                "restart rollback did not use the recovered file-only record")
        consumed_manifest = json.loads(
            manifest_paths[0].read_text(encoding="utf-8")
        )
        require(consumed_manifest.get("consumed") is True
                and consumed_manifest.get("phase") == "rolled-back",
                "successful restart rollback did not consume its durable manifest")
        recovered_health = service.request("/health")
        require(recovered_health.get("recoveryRequired") is False
                and recovered_health.get("invalidManifest") is False
                and recovered_health.get("pendingRecoveryCount") == 0
                and recovered_health.get("sdkReady") is True
                and recovered_health.get("ready") is True,
                "successful rollback did not reopen provider readiness")

        actual_crash_operation = "calop-actual-process-crash-001"
        actual_crash_body = calibration_apply_body(root, dry_run=False)
        actual_crash_body["operationId"] = actual_crash_operation
        for mapping in actual_crash_body["cameraCalibrations"]:
            mapping["rollbackPath"] = mapping["path"]
        service.stop()
        service = CaptureService(
            executable,
            root,
            delay_ms=50,
            crash_operation_id=actual_crash_operation,
            crash_phase="apply-after-sdk",
            crash_camera_index=1,
        )
        armed_health = service.request("/health")
        require(armed_health.get("calibrationCrashFailpointArmed") is True
                and armed_health.get("calibrationCrashOperationId")
                == actual_crash_operation
                and armed_health.get("calibrationCrashPhase") == "apply-after-sdk"
                and armed_health.get("calibrationCrashCameraIndex") == 1,
                "controlled crash failpoint was not operation/phase/camera bound")
        service.request(
            "/api/cameras/connect-all",
            {"ips": actual_crash_body["ips"], "expectedCameras": 2},
        )
        try:
            service.request("/api/calibration/apply-all", actual_crash_body)
            raise AssertionError("controlled calibration failpoint did not terminate the provider")
        except Exception:
            pass
        deadline = time.monotonic() + 5
        while service.process.poll() is None and time.monotonic() < deadline:
            time.sleep(0.05)
        require(service.process.poll() == 197,
                "controlled calibration failpoint did not use the dedicated exit code")

        actual_manifests = [
            path for path in (Path(root) / "config" / "calibration-rollbacks").rglob("manifest.json")
            if json.loads(path.read_text(encoding="utf-8")).get("operationId")
            == actual_crash_operation
        ]
        require(len(actual_manifests) == 1,
                "actual process crash did not retain one durable manifest")
        actual_manifest = json.loads(actual_manifests[0].read_text(encoding="utf-8"))
        require(actual_manifest.get("phase") == "applying"
                and actual_manifest.get("cameras", [])[0].get("attempted") is True,
                "actual process crash did not preserve the applying checkpoint")

        service = CaptureService(executable, root, delay_ms=50)
        actual_recovery_health = service.request("/health")
        require(actual_recovery_health.get("calibrationCrashFailpointArmed") is False
                and actual_recovery_health.get("recoveryRequired") is True,
                "unarmed restart did not enter calibration recovery fence")
        service.request(
            "/api/cameras/connect-all",
            {"ips": actual_crash_body["ips"], "expectedCameras": 2},
        )
        actual_recovery = service.request(
            "/api/calibration/rollback",
            {
                "rollbackToken": actual_manifest["token"],
                "operationId": "calop-actual-process-crash-recovery-001",
                "confirmation": "ROLLBACK CAMERA CALIBRATION",
            },
        )
        require(actual_recovery.get("code") == 0
                and actual_recovery.get("complete") is True
                and actual_recovery.get("applyOperationId") == actual_crash_operation,
                "actual process crash could not be recovered from staged files")
        reconnected_after_crash_drill = service.request(
            "/api/cameras/connect-all",
            {"ips": restart_ips, "expectedCameras": 4},
        )
        require(reconnected_after_crash_drill.get("code") == 0
                and reconnected_after_crash_drill.get("connected") == 4,
                "crash drill did not restore the four-camera test topology")

        service.request(
            "/api/steel/event",
            {
                "cmd": "steelIn",
                "value": 1,
                "id": "MAT-PIPELINE",
                "autoCapture": True,
                "width": 160,
                "lines": 96,
                "intervalMs": 0,
                "retries": 0,
            },
        )
        deadline = time.monotonic() + 10
        while time.monotonic() < deadline:
            production = service.request("/api/steel/status")
            if production.get("captureSuccessCount", 0) >= 4:
                break
            time.sleep(0.05)
        else:
            raise AssertionError("production pipeline did not complete a frame round")
        service.request("/api/steel/event", {"cmd": "steelIn", "value": 0})
        deadline = time.monotonic() + 10
        while time.monotonic() < deadline:
            production = service.request("/api/steel/status")
            if not production.get("productionCaptureRunning"):
                break
            time.sleep(0.05)
        else:
            raise AssertionError("production pipeline did not stop and drain")

        success_count = production["captureSuccessCount"]
        require(success_count > 0 and success_count % 4 == 0, "production result count is not round-aligned")
        require(production["captureCount"] == success_count, "production counted a frame before successful storage")
        require(production["captureFailureCount"] == 0, "simulated production storage failed")
        require(
            production["nextCaptureSequence"] == success_count // 4 + 1,
            "production sequence reservation is inconsistent with completed rounds",
        )
        production_metadata = [
            path
            for path in Path(root).rglob("*.json")
            if path.parent.name == "metadata" and "MAT-PIPELINE" in path.parts
        ]
        require(len(production_metadata) == success_count, "production metadata count differs from success count")
        for path in production_metadata:
            frame = json.loads(path.read_text(encoding="utf-8"))
            require(frame.get("metadataCommit") == "last", "production metadata was not committed last")
        service.stop()
    finally:
        service.kill()


def shutdown_drains_accepted_frames(executable, root):
    service = CaptureService(executable, root, delay_ms=80)
    request_error = []

    def run_request():
        try:
            service.request(
                "/api/capture/continuous-test",
                capture_body(Path(root) / "shutdown", rounds=2),
                timeout=20,
            )
        except Exception as error:
            # The control event may close the client socket after the route has
            # finished; artifact completion and process exit are authoritative.
            request_error.append(error)

    worker = threading.Thread(target=run_request)
    worker.start()
    deadline = time.monotonic() + 10
    while time.monotonic() < deadline:
        if list((Path(root) / "shutdown").rglob("*.png")):
            break
        require(service.process.poll() is None, "service exited before shutdown signal")
        time.sleep(0.02)
    else:
        raise AssertionError("capture route did not enqueue storage before shutdown")

    service.stop(timeout=10)
    worker.join(timeout=5)
    require(not worker.is_alive(), "capture request thread did not finish")
    metadata = list((Path(root) / "shutdown").rglob("*_metadata.json"))
    require(len(metadata) == 8, "shutdown did not drain every accepted frame transaction")
    for path in metadata:
        frame = json.loads(path.read_text(encoding="utf-8"))
        require(frame.get("completeFrame") is True, "shutdown left an incomplete committed frame")


def timed_out_workers_remain_owned_until_reaped(executable, root):
    service = CaptureService(executable, root, delay_ms=1100, queue_items=1)
    try:
        body = capture_body(Path(root) / "owned-timeout", rounds=1)
        body["ips"] = body["ips"][:3]
        body["expectedCameras"] = 3
        body["width"] = 64
        body["lines"] = 48
        body["workerTimeoutMs"] = 1000
        summary = service.request("/api/capture/continuous-test", body, timeout=15)
        require(summary.get("attempts") == 3, "owned-timeout test lost a worker result")
        require(summary.get("failures", 0) >= 1, "test did not force a bounded worker timeout")

        deadline = time.monotonic() + 10
        observed_owned = False
        while time.monotonic() < deadline:
            health = service.request("/health")
            state = health["sdkCaptureState"]
            workers = state["ownedWorkers"]
            observed_owned = observed_owned or workers["adopted"] > 0
            queue = health["storageQueue"]
            if workers["owned"] == 0 and queue["pendingItems"] == 0:
                break
            time.sleep(0.05)
        else:
            raise AssertionError("owned timed-out workers or their storage tasks did not drain")
        require(observed_owned, "timed-out worker handle was not adopted by the runtime")
        require(state.get("poisoned") is False, "simulated worker timeout must not poison the SDK")
        require(workers["adopted"] == workers["reaped"], "owned workers were not joined after completion")
        service.stop()
    finally:
        service.kill()


def calibration_partial_failure_rolls_back(executable, root):
    failing_ip = "192.168.200.102"
    service = CaptureService(
        executable, root, delay_ms=0, calibration_fail_ip=failing_ip
    )
    try:
        ips = ["192.168.200.101", failing_ip]
        connected = service.request(
            "/api/cameras/connect-all", {"ips": ips, "expectedCameras": 2}
        )
        require(connected.get("code") == 0 and connected.get("connected") == 2,
                "calibration rollback test cameras did not connect")
        result = service.request(
            "/api/calibration/apply-all", calibration_apply_body(root, dry_run=False)
        )
        require(result.get("code") != 0, "simulated calibration failure was not injected")
        require(result.get("rollbackPerformed") is True and result.get("rollbackComplete") is True,
                "atomic calibration failure did not complete automatic rollback")
        require(result.get("applied") == 0 and result.get("rolledBack") == 2,
                "automatic rollback left a camera marked applied")
        by_ip = {item["ip"]: item for item in result["results"]}
        require(by_ip[ips[0]].get("applied") is True and by_ip[ips[0]].get("rolledBack") is True,
                "successful camera was not rolled back after peer failure")
        require(by_ip[ips[1]].get("applyCode") != 0 and by_ip[ips[1]].get("rolledBack") is True,
                "failing camera rollback outcome is incomplete")
        consumed = service.request(
            "/api/calibration/rollback",
            {
                "rollbackToken": result["rollbackToken"],
                "confirmation": "ROLLBACK CAMERA CALIBRATION",
            },
        )
        require(consumed.get("code") == 409,
                "automatically consumed rollback token was reusable")
        for ip in ips:
            status = service.request(f"/api/calibration/status?ip={ip}")
            require(status.get("calibrationPath") == "" and status.get("rollbackCode") == 0,
                    "camera process state was not restored after atomic rollback")
        service.stop()
    finally:
        service.kill()


def calibration_manifest_failure_blocks_sdk_writes(executable, root):
    blocker = Path(root) / "config" / "calibration-rollbacks"
    service = CaptureService(executable, root, delay_ms=0)
    try:
        blocker.parent.mkdir(parents=True, exist_ok=True)
        blocker.write_text("not-a-directory", encoding="utf-8")
        body = calibration_apply_body(root, dry_run=False)
        body["operationId"] = "calop-manifest-write-barrier-001"
        for mapping in body["cameraCalibrations"]:
            mapping["rollbackPath"] = mapping["path"]
        connected = service.request(
            "/api/cameras/connect-all",
            {"ips": body["ips"], "expectedCameras": 2},
        )
        require(connected.get("code") == 0 and connected.get("connected") == 2,
                "manifest write-barrier cameras did not connect")
        rejected = service.request("/api/calibration/apply-all", body)
        require(rejected.get("code") == 49010
                and rejected.get("rollbackToken") == ""
                and rejected.get("applied") == 0,
                "manifest publication failure did not reject calibration apply")
        require(all(item.get("attempted") is False
                    and item.get("rollbackRecordCode") == 49010
                    for item in rejected.get("results", [])),
                "manifest publication failure crossed the SDK write barrier")
        for ip in body["ips"]:
            status = service.request(f"/api/calibration/status?ip={ip}")
            require(status.get("calibrationPath") == "",
                    "camera calibration changed despite manifest publication failure")
        require(blocker.is_file(),
                "failed manifest publication unexpectedly replaced its blocking path")
        disconnected = service.request("/api/cameras/disconnect-all", {})
        require(disconnected.get("code") == 0
                and disconnected.get("requested") == 2
                and disconnected.get("disconnected") == 2
                and disconnected.get("failed") == 0
                and disconnected.get("connected") is False,
                "disconnect-all aggregate counters are incomplete")
        require(len(disconnected.get("results", [])) == 2
                and all(item.get("ip") in body["ips"]
                        and item.get("code") == 0
                        and item.get("errorName") == "CORRECT"
                        and "operatorHint" in item
                        and item.get("connected") is False
                        and item.get("disconnected") is True
                        for item in disconnected["results"]),
                "disconnect-all lost per-camera operator evidence")
        service.stop()
        service = CaptureService(executable, root, delay_ms=0)
        invalid_health = service.request("/health")
        require(invalid_health.get("recoveryRequired") is True
                and invalid_health.get("invalidManifest") is True
                and invalid_health.get("sdkReady") is False,
                "invalid manifest root did not fail provider readiness closed")
        invalid_block = rejected_json(
            service, "/api/calibration/apply-all", body, 423
        )
        require(invalid_block.get("invalidManifest") is True,
                "invalid manifest fence exposed a write override")
        service.stop()
    finally:
        service.kill()


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--exe", required=True, type=Path)
    arguments = parser.parse_args()
    require(arguments.exe.is_file(), "capture service executable is missing")
    with tempfile.TemporaryDirectory(prefix="steel-capture-frame-pipeline-") as temp:
        frame_transaction_and_overlap(arguments.exe, Path(temp) / "first")
        shutdown_drains_accepted_frames(arguments.exe, Path(temp) / "second")
        timed_out_workers_remain_owned_until_reaped(arguments.exe, Path(temp) / "third")
        calibration_partial_failure_rolls_back(arguments.exe, Path(temp) / "fourth")
        calibration_manifest_failure_blocks_sdk_writes(arguments.exe, Path(temp) / "fifth")
    print("frame_pipeline_test passed")


if __name__ == "__main__":
    main()
