# BKV 调试样本数据

## 2560 卷 JPG 原始图像

`2560-jpg/` 仅包含一卷 BKV 六相机 2D 原始图像的 JPG 版本。

- 相机目录：`camera-1` 至 `camera-6`
- 每路帧数：19
- JPG 总数：114
- 分辨率：2560 × 1024
- 色彩模式：灰度
- 转换质量：JPEG quality 100
- JPG 总大小：81,103,086 字节
- 原始数据包：`2560图像.zip`

本目录不包含原始 BMP、`.d3img`、ZIP 或 Git LFS 分片，仅用于离线联调和图像回放。

## D3IMG 转换 NPZ

`d3img-npz/CamImageSource1/18000/3D/0000.npz` 是由真实
`18000/3D/0000.d3img` 转换得到的单帧远端调试样本，不包含原始
`.d3img`。

- 格式：`bkv-depth-v1`
- 流水号：`18000`
- 相机：`CamImageSource1`（D3IMG 头部相机号 `0`）
- 帧号：`0000`
- 矩阵：`1024 × 731`，`float32`
- 有效点：`318,417`
- 无效值：`-1000000.0`
- 深度单位：`legacy-unknown`
- 原始 D3IMG SHA-256：`1144ed82a87e1395ab955204350e80b633f8faa1d8ac02a76edd1db367b411f8`
- NPZ SHA-256：`afa47f438a36b361d9aee38d2d9f5a2df8cc6bca2baa11a2b944e89a65deab5b`

加载时必须使用 `numpy.load(path, allow_pickle=False)`；不要把未标定深度值解释为毫米。
