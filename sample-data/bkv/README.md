# BKV 流水号 250525 调试样本

`250525/` 是一组来源一致的六相机完整数据。每路相机均包含同一流水号、同一帧号范围的
2D JPG 与 3D NPZ：

```text
250525/
  manifest.json
  camera-1/
    2D/0000.jpg ... 0018.jpg
    3D/0000.npz ... 0018.npz
  ...
  camera-6/
    2D/0000.jpg ... 0018.jpg
    3D/0000.npz ... 0018.npz
```

- 流水号：`250525`，由全部 114 个 D3IMG 头部的 `steelno` 字段确认
- 相机：`camera-1` 至 `camera-6`
- 每路帧数：19，帧号 `0000` 至 `0018`
- JPG：114 个，灰度，`2560 × 1024`，JPEG quality 100
- NPZ：114 个，`bkv-depth-v1`，矩阵形状 `(1024, 2560)`，`float32`
- JPG 总大小：81,103,086 字节
- NPZ 总大小：179,985,614 字节
- 无效值：`-1000000.0`
- 深度单位：`legacy-unknown`
- 原始数据包：`2560图像.zip`
- 原始数据包 SHA-256：`8cc1f6a7b3384166866af1f0d184dd2a8f1ec9f90ad8e8b70f54149c23075be0`

JPG 与 NPZ 均来自上述同一个原始数据包。仓库不提交原始 BMP、D3IMG 或 ZIP。
`manifest.json` 记录每帧的相机、帧号、形状、有效点数、源 D3IMG SHA-256 和 NPZ
SHA-256，远端可据此逐帧校验。

加载 NPZ 时必须使用 `numpy.load(path, allow_pickle=False)`；不要把未标定的深度值解释为毫米。
