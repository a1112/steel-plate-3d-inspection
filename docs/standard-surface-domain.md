# 标准表面域与在线处理基线

本项目以 `cylinder`（当前棒材生产路径）和 `plate`（钢板扩展路径）作为显式 `GeometryProfile`。两种几何共用采集完整性、校准引用、有效掩码、标准表面瓦片、缺陷候选和结果发布契约；只有从世界坐标投影到 `(u,v,h)` 的步骤不同。

- `plate`：`u` 为输送方向毫米，`v` 为横向毫米，`h` 为参考平面或低阶形貌面的残差。
- `cylinder`：`u` 为轴向毫米，`v` 为周向弧长/角度，`h` 为拟合圆柱的径向残差，`v` 周期闭合。

Rust 权威类型位于 `app/result-contract/src/surface.rs`，固定了以下契约：

- `steel.frame-chunk.v1`：原始 C16、可选强度、逐像素 bit-packed validity、设备/主机时钟、编码器位置和不可变校准引用；`complete=false` 的帧不得进入重建。
- `steel.calibration.v2`：修订号与 SHA-256 是所有中间产物的必备引用。
- `steel.surface-tile.v1`：毫米单位的规则 `(u,v)` 栅格、完整分辨率残差、强度和 validity 二进制平面。
- `steel.surface.tiles.v1`：材料、几何模式、校准哈希、artifact 哈希、物理边界和瓦片目录。

原始坏数据不允许被零矩阵、均值或插值静默替代。滤波只可用于配准副本或基准估计，缺陷 residual 始终保留原始有效样点。当前 SICK 缺陷处理明确输出 `validityPolicy=invalid-depth-preserved-never-zero-filled`。

## 当前实时实现

当前相机仍以 PNG/NPZ 作为不可变兼容归档。在线缺陷任务采用：

1. 头尾对齐范围和灰度有效 ROI；
2. 原分辨率 validity 与深度残差；
3. 仅对慢变基准中值做有界抽样，不对残差降采样；
4. 两个预处理线程、批量为 8 的动态 ONNX 推理；
5. 候选边界伪影过滤、二级类别识别和人工复核语义；
6. 分离记录等待采集、源解码、预处理、GPU 检出、分类和后处理耗时。

该路径仍是 Python 生产原型。后续 C++ 迁移必须使用同一冻结数据集双跑，并在显式数值容差内保持候选、尺寸和 validity 结果一致；在 C++ oracle 对比通过前不删除 Python 实现。

## 显示与缓存

检测图像世界已经使用按需瓦片而不是整根巨图。前端队列现在同时限制请求数量和预计解码字节，支持优先级、去重、抢占、过期范围取消及 telemetry；图像缓存继续按解码后的 RGBA 字节实施 LRU。所有 cache key 必须包含材料/记录、source revision、相机、LOD 和瓦片坐标。

## 尚未满足的正式门禁

以下项目依赖外部输入，不能由软件默认值替代：测速仪/编码器或硬触发、经批准的 Calibration v2、最小缺陷尺寸、冻结的 Golden/Defect/Hard-Negative/Fault-Injection 数据集、质量部门双人复核、模型 acceptance、正式签名证书及 72 小时硬件 FAT。缺少任一正式门禁时，模型结果保持 `reviewRequired=true`，不得直接判废。
