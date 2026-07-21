# BKV `.d3img` 格式取证记录

## 结论

当前实现只提供有界探针，不解码旧 `.d3img`，状态为
`unsupported/no_evidenced_decoder`。六路真实样本给出了很强的“84 字节前缀 +
二维 float32 数组”候选布局，但没有文档化的旧格式 reader，也没有能证明版本、字段语义、
无效值、单位和 uint16 量化规则的契约。根据迁移设计的硬门槛，这些观察不能被提升为生产
解码器，工具不会仅因结果看起来像深度图就生成深度 PNG 或点云。

## 数据来源与方法

取证日期为 2026-07-21。源文件为用户提供的
`image_copy.part1.rar`、`image_copy.part2.rar`，使用本机
`C:\Program Files\WinRAR\UnRAR.exe` 7.22 的结构化列表和显式成员解压。
探针最多保留前 256 字节并流式计算整个文件的 SHA-256，不修改源归档。

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
有限值随相机变化。这里只记录可重复字节事实；`84` 是否正式头长、两个整数是否宽高、
float 的单位和 `-1000000.0` 是否无效哨兵均未得到供应商契约证明。

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

## 安全门槛与后续解锁条件

由于缺少以下任一项，当前不生成 synthetic “valid” 文件，不实现自定义 decoder，也不
输出 16-bit depth PNG/preview：

1. 能成功读取真实 `.d3img` 的供应商 API 及其版本/内存释放契约；或
2. 旧系统源码/格式说明，明确 magic、版本、头长、宽高、数据类型、字节序、单位、无效值、
   量化和校验规则；或
3. 等价的可审计格式夹具，能证明上述语义而不只是数组边界。

若取得这些证据，应新增一个明确 `contractId` 的适配器，先用真实文件和截断/越界夹具
验证，再输出 `steel.bkv-depth-metadata.v1`、16-bit 深度 PNG 和有界预览。坐标系在
`.dat` 语义未证明前必须保持 `raw-camera`。

当前 `scripts/bkv_d3img.py probe` 对已观察 magic 返回稳定结构化证据；未知 magic
返回 `unsupported_magic`，截断输入返回 `invalid/truncated_header`。迁移 manifest 对
每个 `.d3img` 保存 `depthDecode.status`、reason、探针 schema/parser 和原文件哈希，
批次复验会校验这些字段，因而不会把 unsupported 文件误报为 decoded。`unsupported`
保留原件并按既定兼容策略处理；`invalid` 则强制批次为 `partial`、要求复核且不可直接导入。
