# SICK 临时缺陷检出与识别

当前实现复用了北满小棒旧程序的两级模型，但在线服务不加载旧程序源码，也不依赖 TensorFlow 或 PyTorch：

1. YOLOv5 2D/3D 模型检出表面缺陷候选框；
2. EfficientNetB3 2D/3D 模型对候选框进行类别识别；
3. 跨越裁剪图完整宽度或高度、且贴近裁剪边缘的候选按黑边/拼接边界伪影过滤；
4. 识别置信度不低于 `0.55` 且被两个可用模态一致判定为伪缺陷时，候选被过滤；任何低置信度结果都会保留为待复核候选；
5. 所有保留结果仍标记为 `review`，在完成 SICK 数据集 FAT 验证前不得直接触发质量判废。

模型位于 `models/beiman-temporary/legacy-yolov5`。`model-set.json` 保存旧文件位置、源文件及 ONNX SHA-256、类别映射和使用限制。运行时使用四个 ONNX 文件；旧 YOLO 权重也作为可追溯原件保留。H5 权重没有进入在线环境，离线转换脚本为 `scripts/export_legacy_efficientnet_onnx.py`。

## 运行环境

在线 Python 固定为 `D:\project\py312\python.exe`。当前机器已经实测：

- NVIDIA 驱动 `560.94`；
- CUDA Toolkit `12.6`；
- cuDNN `9.5.1`；
- ONNX Runtime GPU `1.21.1`；
- 两张 RTX 4090，缺陷推理固定使用 GPU 1；
- 四个 ONNX 会话均实际选择 `CUDAExecutionProvider`。

国内镜像安装命令：

```powershell
& 'D:\project\py312\python.exe' -m pip install `
  -i https://mirrors.aliyun.com/pypi/simple/ `
  --trusted-host mirrors.aliyun.com `
  -r scripts\requirements-sick-defect.txt
```

`torch 2.5.1+cpu` 只用于旧 YOLO 权重的一次性转换，不参与在线推理。运行时必须保证 `CUDA_PATH\bin` 可读；服务启动时会先加载 CUDA DLL，再加载 Python 环境里的 cuDNN 9 DLL。

## 调度与数据

缺陷算法只处理已经结束并完成落盘的流水。每处理一帧前都会检查 `/api/steel/status` 和 `/api/capture/health`；发现进钢会立即暂停。现场配置允许在无钢但写缓存仍在排空时，以独立的低优先级进程读取不同相机盘，从而利用棒材间隔推进任务；推理不会占用采集线程、对齐/测量进程或回放索引进程。

输出位置：

```text
D:\steel-sick-data\defects\FLOW-xxxxxxxxxx\manifest.json
D:\steel-sick-data\defects\FLOW-xxxxxxxxxx\review\*.png
```

原始 `2d/*.png`、`3d/*.npz` 和 `json/*.json` 均只读，不会被算法覆盖。结果接口为：

- `GET /api/capture/defects?materialId=FLOW-xxxxxxxxxx`
- `POST /api/capture/defects/rebuild`

回放页面会显示识别类别、检出置信度、识别置信度，以及被过滤的边界伪影和伪缺陷数量。

## 当前验证基线

使用 `D:\steel-sick-data\C5\FLOW-0000000056` 的 68 帧真实数据进行全帧验证：65 帧有效、130 次 YOLO 推理、41 个原始候选；二级识别过滤 34 个高置信伪缺陷，保留 7 个低置信候选供复核。全程命中 CUDA，耗时约 20.3 秒（单相机）。

六相机在线基线使用 `FLOW-0000001267` 的 404 帧完整流水进行全帧验证：808 次 YOLO 推理、6 次二级识别，6 个原始候选均命中裁剪边界伪影规则，最终保留 0 个待复核候选；四个 ONNX 会话均命中 `CUDAExecutionProvider`，总耗时约 306.4 秒。该结果只证明本流水中的明显边界误报已被抑制，不能作为“流水无真实缺陷”的人工复核结论。验证期间存储队列峰值 119/128，落盘丢弃、落盘失败和数据库提交失败均为 0；采集窗口 120 轮完整，但自由运行模式仍观测到极少量传输帧号跳变，正式同步能力仍依赖后续测速仪/硬触发接入。

这组模型来自旧棒材产线，类别能力包括断缝、划伤、麻面、凹坑、裂纹、烂钢、耳子、结疤、粘钢和压痕等。其统计精度不能直接外推到当前 SICK 光学、3D 展平和彩色映射条件；后续应从人工复核结果构建本项目数据集，重新标定阈值并训练正式模型。
