# BKV `.d3img` 格式取证记录

## 结论

用户于 2026-07-27 提供的旧系统 `DAT3DHEADER` 定义和 `Write3DFile` 源码，确认了
`.d3img` 使用 MSVC 默认对齐的 84 字节小端文件头，后接
`width * height` 个连续 float32。真实样本的 magic、头长、宽高、像素尺寸和文件长度
均与源码契约一致。

当前 Python 转换器和 Rust 在线预览据此执行严格结构解析，并把载荷保留为
`legacy-camera-raw`。源码仍未说明 float32 的物理单位、`datatype` 枚举含义或
`-1000000.0` 的正式无效值契约，因此转换结果继续使用 `unit=legacy-unknown`，不得直接
用于带物理单位的质量结论。

## 数据来源与方法

取证日期为 2026-07-21。源文件为用户提供的
`image_copy.part1.rar`、`image_copy.part2.rar`，使用本机
`C:\Program Files\WinRAR\UnRAR.exe` 7.22 的结构化列表和显式成员解压。
探针最多保留前 256 字节并流式计算整个文件的 SHA-256，不修改源归档。

## 旧系统写入契约

旧系统通过 Win32 `WriteFile` 先写入 `sizeof(DAT3DHEADER)`，再写入
`height * width * sizeof(float)` 字节。按 Windows/MSVC 默认对齐，等价小端布局为
`<6sh5if5i3B29s`：

| 偏移 | 字段 | 类型 |
| ---: | --- | --- |
| 0 | `tag` | `char[6]`，固定 `3DImg\0` |
| 6 | `headSize` | `short`，固定 84 |
| 8 | `steelno` | `int` |
| 12 | `imgindex` | `int` |
| 16 | `imgseq` | `int` |
| 20 | `width` | `int` |
| 24 | `height` | `int` |
| 28 | `scaleX` | `float` |
| 32–48 | `left/right/starlen/endllen/startPos` | 5 个 `int` |
| 52–54 | `camno/datatype/pixelSize` | 3 个 `char` |
| 55–83 | `reserve` | `char[29]` |

写入源码确认 `pixelSize=4` 对应实际 float32 载荷。`scaleX` 注释为水平分辨率，但未给出
单位；其它位置字段的业务含义按原字段名保留，不推导坐标变换。

目标范围 `1893700-1893710` 的 RAR 列表出现 1,297 个 `.d3img` 成员记录和
132 个 `.dat` 成员记录（该数字是两卷列表出现次数，不等同于去重后的发布清单）。六路
`.dat` 均为 8 字节；例如 Cam1/1893700/2D/num.dat 为
`44 e5 1c 00 15 00 00 00`，SHA-256
`b9a772e52c847fba8c1f53d7051f292db53437f876078399f726d3f9bfd52f2e`。
按 little-endian 读取的两个整数恰为 `1893700` 和 `21`，但没有资料证明其字段名称或
语义，因此实现不把它当作标定或坐标变换参数。

## 六路真实样本

以下均为 `1893700/3D/0000.d3img`：

| 相机 | 字节数 | SHA-256 | 偏移 20 的 u32 | 偏移 24 的 u32 |
| --- | ---: | --- | ---: | ---: |
| 1 | 2,793,556 | `8f07f22e83925ef55a49f9a233bba46b42bae508dfe535c140b73dff9c7bb902` | 682 | 1024 |
| 2 | 2,646,100 | `6170b7e23ce6c5be3327f864a96bced27955242033e5ce0b750f6a654a4d0729` | 646 | 1024 |
| 3 | 2,588,756 | `00e4980399bd8db46ff66581ac24ce179582748329ab87c669db6b7cd2b725da` | 632 | 1024 |
| 4 | 2,216,020 | `a3fd75f0152c64e5168b8da8b153e8a6c1c5162555e71283fdd100c0223df297` | 541 | 1024 |
| 5 | 2,834,516 | `454cd80b3e36d087da43ec94b653d953b28dfccdec23a0474e02ebd68044f558` | 692 | 1024 |
| 6 | 2,773,076 | `3624cb6ed9ee3de196d6c379eec432be8a35413a4158194e1096bdb3745b55c2` | 677 | 1024 |

每个样本的前 6 字节都是 `33 44 49 6d 67 00`（ASCII `3DImg\0`），字节
6-7 都是 `54 00`。偏移 8 的 little-endian u32 都等于 `1893700`。对这六个
样本，文件长度都精确满足：

```text
84 + (offset20_u32 * offset24_u32 * 4)
```

偏移 84 后按 little-endian float32 观察时，六个样本都出现 `-1000000.0`，其余
有限值随相机变化。源码已经确认 `84`、宽高位置和 float32 载荷，但 float 的物理单位和
`-1000000.0` 是否为正式无效哨兵仍未得到说明。

各相机在目标范围内存在多个固定大小组，而不是唯一尺寸：Cam1 8 组、Cam2 11 组、
Cam3 10 组、Cam4 11 组、Cam5 7 组、Cam6 11 组。所有列出的真实文件大小均可由
上述候选算式解释，但重复算式只能证明边界候选，不能证明深度语义和转换精度。

## Capture 6.7 离线 reader 检查

本机安装了 `Capture 6.7.0.8`。在
`LVM_NVT_SDK/LVM_C++_SDK/x64/Include/lvm_sdk.h` 中找到文档化接口：

- `lvm_load_depth_map(const char *, lvm_depth_map_t *)`：加载本地深度图；
- `lvm_offline_save_depthMap(const char *, lvm_depth_map_t *)`：离线保存 PNG；
- `LVM_FreeDepthMap(lvm_depth_map_t *)`：释放 SDK 深度数据。

同一 SDK 的 `lvm_basic.h` 文档化了深度格式 0 为 unsigned short、格式 2 为 float。
但头文件、示例和可搜索文本中没有 `.d3img` 或 `3DImg` 契约。使用 x64 SDK DLL
按文档初始化结构并调用 `lvm_load_depth_map` 读取上述 Cam1 文件，返回 `40091`，SDK
同时报告 `libpng error: Not a PNG file`，且没有返回尺寸或数据。这证明找到的 reader
面向 PNG，而不是这批旧容器，不能作为 `.d3img` 解码边界。

## 已解锁范围与剩余安全门槛

旧系统写入源码已经解锁容器头、矩阵边界和 float32 载荷解析。实现可以：

- 严格解析完整头部，并拒绝未知头长、非 4 字节像素、越界尺寸、截断或尾随载荷；
- 输出无 pickle 的 `bkv-depth-v1` NPZ；
- 对有限且不等于观测哨兵 `-1000000.0` 的值生成有界预览。

以下行为仍不允许：

- 把 raw float 值声明为毫米、微米或其它物理单位；
- 未经标定解释 `scaleX`、位置字段或 `.dat` 为世界坐标；
- 根据预览签发生产质量结论或生成带物理量化声明的 16-bit 深度产品。

当前 `scripts/bkv_d3img.py probe` 对已观察 magic 返回稳定结构化证据；未知 magic
返回 `unsupported_magic`，截断输入返回 `invalid/truncated_header`。迁移 manifest 对
每个 `.d3img` 保存 `depthDecode.status`、reason、探针 schema/parser 和原文件哈希，
批次复验仍按原 schema 校验这些字段。该保守迁移探针不等同于显式调用
`convert_bkv_d3img.py` 的结构转换路径；`unsupported` 继续保留原件，`invalid` 继续强制
批次为 `partial`、要求复核且不可直接导入。

## 在线转换、存储与显示

BKV 在线服务按流水号读取六路 `3D/*.d3img`，使用上述 84 字节契约完成严格解析，并将
抽样后的相机相对残差重建为闭合圆柱表面网格。产物写入：

```text
<algorithm.outputRoot>/runs/<流水号>/inspection-world-v1/surface-mesh.json
<algorithm.outputRoot>/runs/<流水号>/inspection-world-v1/surface-mesh.bsmesh
<algorithm.outputRoot>/runs/<流水号>/inspection-world-v1/reconstruction-parameters.json
```

`manifest.json` 的 `depthSurface` 节点记录可用状态、来源帧数、网格及参数路径、坐标单位和错误
信息。网格 schema 为 `steel.bkv-depth-surface.v1`，包含 positions、indices、
validMask、相机来源和显示缩放依据；HTTP 读取入口为
`GET /api/inspection-world/surface?recordId=<流水号>`。前端 3D 与点云视图使用同一份
记录绑定产物，不回退到模拟网格。

前端优先请求 `format=binary` 的 `BSMESH01` 二进制网格，服务端保留 JSON 作为兼容回退。
二进制按 float32/uint32/uint8 连续存储 positions、UV、颜色、索引及掩码，避免传输和解析
大体积数字 JSON；前端对最近 8 条记录保存解析后的类型化数组缓存。

在线 2D BMP 与 D3IMG 深度预览使用带源文件大小和修改时间校验的进程内 LRU 缓存，容量
上限为 64 项或 256 MiB。源文件版本变化会立即失效对应项；HTTP 响应同时允许浏览器
缓存 300 秒，并通过 `X-BKV-Image-Cache` 暴露服务端 `HIT/MISS` 状态。

参数文件 schema 为 `steel.bkv-depth-reconstruction-parameters.v1`，独立保存输入格式、
帧选择、网格采样、圆柱几何、相机中位数基线、残差 P95、径向显示比例、单位和标定状态，
可用于重现本次显示级重建。

该网格只用于未标定的形态预览：每路相机先减去自身有效样本中位数，再以全局残差 P95
生成有界显示比例。`coordinateUnit` 固定为 `legacy-unknown`，`calibrated=false`；
因此它不改变上文关于物理单位、外参和质量结论的安全门槛。
