# Runtime Boundaries V2

The formal production route has exactly one physical source: the configured SICK GenTL camera array. Simulation, LVM compatibility, file replay, and BKV history are not allowed to contribute to a production PASS/FAIL decision.

## Formal process route

```text
Windows SCM
└─ steel-runtime-supervisor.exe
   ├─ steel-image-service.exe       Artifact and display adaptation, :4874
   ├─ steel-image-worker.exe        Alignment, ROI, measurement and surface, :4875
   ├─ steel-defect-worker.exe       Actual-camera defect inference, :4876
   ├─ steel-capture-service.exe     Only SICK GenTL camera owner, :4317
   ├─ steel-inspection-service.exe  Business DB and final decision, :4873
   └─ steel-trigger-gateway.exe     PLC/L2 ingress, :4881/:4882/:4883
```

The formal always-on backend therefore contains seven EXEs: one Supervisor and six managed children. The desktop UI and tray companion are user-session programs, while `steel_bar_surface_core.exe` is an on-demand native compute helper rather than another service.

`steel-image-worker-bkv.exe` is an independently built compatibility project on port 4877. It may import and display historical BKV facts, but it is not started by the formal Supervisor, receives no camera role, performs no defect re-inference, and cannot affect the actual-camera production decision.

## Durable hand-off

```text
steel.acquisition-manifest.v1
        ↓
steel.image-result.v1
        ↓
steel.defect-report.v1
        ↓
Business-owned final result
```

Raw capture is immutable. Image and defect outputs are replaceable derived artifacts. Only Business can produce the final production state.

## Site hand-off

The installer requires a reviewed absolute-path SICK profile and Python executable. The profile must name an existing CTI, calibration, model manifest, four ONNX detector/classifier files, and one existing storage root per camera. This validation is code-complete locally; camera connectivity, SDK/CTI behavior, CUDA qualification, timing, and soak evidence must be completed on the hardware server.
