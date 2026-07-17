#!/usr/bin/env python3
"""Authenticated example client for HTTP API, TCP, and UDP steel triggers.

Production uses HMAC-SHA256, a Unix timestamp, and a unique nonce. TCP uses one
authenticated envelope per line; UDP uses one envelope per datagram. HTTP puts
the same authentication values in X-Trigger-* headers.
"""

from __future__ import annotations

import argparse
import hashlib
import hmac
import json
import os
import socket
import time
import urllib.request
import uuid
from typing import Any


HTTP_PATHS = {
    "steel-info": "/api/trigger/steel-info",
    "steel-in": "/api/trigger/steel-in",
    "steel-out": "/api/trigger/steel-out",
}


def signature(secret: str, timestamp: str, nonce: str, transport: str, body: str) -> str:
    message = f"steel-trigger-v1\n{timestamp}\n{nonce}\n{transport}\n{body}"
    return hmac.new(secret.encode("utf-8"), message.encode("utf-8"), hashlib.sha256).hexdigest()


def canonical_json(payload: dict[str, Any]) -> str:
    return json.dumps(payload, separators=(",", ":"), sort_keys=True, ensure_ascii=False)


def http_post(url: str, payload: dict[str, Any], secret: str = "") -> dict[str, Any]:
    body = canonical_json(payload)
    headers = {"Content-Type": "application/json"}
    if secret:
        timestamp = str(int(time.time()))
        nonce = uuid.uuid4().hex
        headers.update({
            "X-Trigger-Timestamp": timestamp,
            "X-Trigger-Nonce": nonce,
            "X-Trigger-Signature": signature(secret, timestamp, nonce, "http", body),
        })
    request = urllib.request.Request(
        url,
        data=body.encode("utf-8"),
        headers=headers,
        method="POST",
    )
    with urllib.request.urlopen(request, timeout=15) as response:
        return json.loads(response.read().decode("utf-8"))


def set_gateway_mode(host: str, http_port: int, mode: str) -> None:
    response = http_post(
        f"http://{host}:{http_port}/api/trigger/mode", {"mode": mode}
    )
    if response.get("mode") != mode:
        raise RuntimeError(f"Gateway did not switch to {mode}: {response}")


class TriggerClient:
    def __init__(self, transport: str, host: str, http_port: int, tcp_port: int, udp_port: int, shared_secret: str):
        self.transport = transport
        self.host = host
        self.http_port = http_port
        self.tcp_port = tcp_port
        self.udp_port = udp_port
        self.shared_secret = shared_secret
        self.tcp: socket.socket | None = None
        self.tcp_reader = None
        self.udp: socket.socket | None = None

    def __enter__(self) -> "TriggerClient":
        if self.transport == "tcp":
            self.tcp = socket.create_connection((self.host, self.tcp_port), timeout=10)
            self.tcp_reader = self.tcp.makefile("rb")
        elif self.transport == "udp":
            self.udp = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
            self.udp.settimeout(15)
        return self

    def __exit__(self, *_: object) -> None:
        if self.tcp_reader is not None:
            self.tcp_reader.close()
        if self.tcp is not None:
            self.tcp.close()
        if self.udp is not None:
            self.udp.close()

    def send(self, event: str, payload: dict[str, Any]) -> dict[str, Any]:
        message = {"event": event, **payload}
        if self.transport == "api":
            return http_post(
                f"http://{self.host}:{self.http_port}{HTTP_PATHS[event]}",
                message,
                self.shared_secret,
            )
        if self.shared_secret:
            timestamp = str(int(time.time()))
            nonce = uuid.uuid4().hex
            body = canonical_json(message)
            envelope = {
                "auth": {
                    "timestamp": timestamp,
                    "nonce": nonce,
                    "signature": signature(
                        self.shared_secret, timestamp, nonce, self.transport, body
                    ),
                },
                "payload": message,
            }
            encoded = canonical_json(envelope).encode("utf-8")
        else:
            encoded = canonical_json(message).encode("utf-8")
        if self.transport == "tcp":
            assert self.tcp is not None and self.tcp_reader is not None
            self.tcp.sendall(encoded + b"\n")
            line = self.tcp_reader.readline()
            if not line:
                raise ConnectionError("TCP gateway closed without a response")
            return json.loads(line.decode("utf-8"))
        assert self.udp is not None
        self.udp.sendto(encoded, (self.host, self.udp_port))
        response, _ = self.udp.recvfrom(65507)
        return json.loads(response.decode("utf-8"))


def print_response(event: str, response: dict[str, Any]) -> None:
    print(f"\n{event} response:")
    print(json.dumps(response, indent=2, ensure_ascii=False))
    if int(response.get("code", 500)) >= 400:
        raise RuntimeError(f"{event} was rejected")


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--transport", choices=("api", "tcp", "udp"), default="api")
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--http-port", type=int, default=4881)
    parser.add_argument("--tcp-port", type=int, default=4882)
    parser.add_argument("--udp-port", type=int, default=4883)
    parser.add_argument("--material-id", default=f"DEMO-{time.strftime('%Y%m%d-%H%M%S')}")
    parser.add_argument("--hold-seconds", type=float, default=3.0)
    parser.add_argument("--grade", default="Q355B")
    parser.add_argument("--diameter-mm", type=float, default=120.0)
    parser.add_argument("--length-mm", type=float, default=12000.0)
    parser.add_argument("--skip-mode-switch", action="store_true")
    parser.add_argument(
        "--shared-secret",
        default=os.environ.get("TRIGGER_SHARED_SECRET", ""),
        help="HMAC secret; defaults to TRIGGER_SHARED_SECRET and is required by production",
    )
    args = parser.parse_args()

    if not args.skip_mode_switch:
        set_gateway_mode(args.host, args.http_port, args.transport)

    common = {
        "materialId": args.material_id,
        "steelId": args.material_id,
        "grade": args.grade,
        "diameterMm": args.diameter_mm,
        "lengthMm": args.length_mm,
        "source": f"python-demo-{args.transport}",
    }

    with TriggerClient(
        args.transport,
        args.host,
        args.http_port,
        args.tcp_port,
        args.udp_port,
        args.shared_secret,
    ) as client:
        info = client.send(
            "steel-info", {**common, "requestId": f"info-{uuid.uuid4()}"}
        )
        print_response("steel-info", info)

        steel_in = client.send(
            "steel-in",
            {**common, "requestId": f"in-{uuid.uuid4()}", "present": True, "value": 1},
        )
        print_response("steel-in", steel_in)

        print(f"\nSteel is present; waiting {args.hold_seconds:.1f} seconds...")
        time.sleep(max(0.0, args.hold_seconds))

        steel_out = client.send(
            "steel-out",
            {**common, "requestId": f"out-{uuid.uuid4()}", "present": False, "value": 0},
        )
        print_response("steel-out", steel_out)


if __name__ == "__main__":
    main()
