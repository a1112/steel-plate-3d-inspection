# BKV 流水号 1908500 调试样本

`1908500/` 是一组来源一致的六相机完整数据。每路相机均包含同一流水号、同一帧号范围的 2D JPG 与 3D NPZ，并附带该流水号的数据库快照。

```text
1908500/
  database.json
  manifest.json
  camera-1/
    2D/0000.jpg ... 0018.jpg
    3D/0000.npz ... 0018.npz
  ...
  camera-6/
    2D/0000.jpg ... 0018.jpg
    3D/0000.npz ... 0018.npz
```

- 流水号：`1908500`
- 相机：`camera-1` 至 `camera-6`
- 每路帧数：19，帧号 `0000` 至 `0018`
- JPG：114 个，灰度，JPEG quality 100
- NPZ：114 个，格式 `bkv-depth-v1`，`float32`
- 图像高度：全部为 1024 像素
- 各相机宽度：921、897、809、929、941、799 像素
- 无效值：`-1000000.0`
- 深度单位：`legacy-unknown`
- 数据库记录：1 条已完成检测记录、1 条检测详情、1 个真实缺陷
- 数据库来源：通过代理接口 `/api/inspection/snapshot` 导出的 `bkv-online-mysql` 数据

JPG 与 NPZ 均来自流水号 `1908500` 的同相机、同帧原始 BMP/D3IMG。仓库不提交原始 BMP 和 D3IMG。

`manifest.json` 记录每帧的相机、帧号、D3IMG 完整头字段、图像形状、有效点数、源 D3IMG SHA-256、JPG SHA-256 和 NPZ SHA-256，远端可据此逐帧校验。`database.json` 只保留本流水号对应的记录、检测详情、被引用的缺陷类型和同步来源信息。

加载 NPZ 时必须使用 `numpy.load(path, allow_pickle=False)`；不要把尚未标定的深度值解释为毫米。
