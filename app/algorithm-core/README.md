# Bar Surface Algorithm Core

This C++ project is the high-speed algorithm boundary for bar-surface reconstruction.

The current implementation consumes the Python prototype output:

```powershell
target/algorithm-core/Release/steel_bar_surface_core.exe `
  --manifest G:\bar-surface-algorithm\runs\<material>\<run>\manifest.json
```

It reads `mesh/bar_surface_mesh.json` from the manifest and writes:

```text
mesh/bar_surface.bsmesh
mesh/bar_surface_core_summary.json
```

`bar_surface.bsmesh` is a compact binary model for later C++ fusion and real-time consumers:

```text
magic[8] = BSMESH01
uint32 version = 1
uint32 vertexCount
uint32 indexCount
uint32 flags
uint32 rows
uint32 colsPerCamera
uint32 cameraCount
uint32 calibratedCameraCount
float32 positions[vertexCount * 3]
float32 uvs[vertexCount * 2]
float32 colors[vertexCount * 3]
uint32 indices[indexCount]
uint8 validMask[vertexCount]       when flags & 0x02
uint8 calibratedMask[vertexCount]  when flags & 0x04
```

The Python prototype remains responsible for stitching validation, calibration fitting,
and parameter exploration. This C++ core is the handoff point for final high-speed
stitching, point-cloud fusion, and model generation.
