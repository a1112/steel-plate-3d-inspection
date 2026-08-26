# Ranger3 六相机软同步与测量

当前采集数据使用每相机独立盘：`<cameraRoot>/<FLOW>/2d/*.png`、`3d/*.npz`、`json/*.json`。

每次出钢后，采集服务会依次生成：

- `D:\steel-sick-data\<FLOW>\sync\alignment.json`：头尾、FrameID 缺口、设备时钟归一、周期软同步锚点和锚点行号；
- `D:\steel-sick-data\<FLOW>\derived\geometry\measurement.json`：2D 裁剪框、六相机截面曲线、鲁棒圆拟合、外径和多截面圆柱拟合门禁。

头尾检测只使用与在线进出钢相同的灰度占比判据，先在配置的帧窗口内搜索稳定边沿，未命中时按倍增窗口扩展到该流水的完整边界数据；固定夹具、氧化皮或粉尘产生的稀疏深度点不会再被当成整帧有钢。周期锚点只建立在六台相机头尾之间的共同有效钢段中，先用每台相机的头部将设备时钟归零，再按帧时间定位到具体扫描行。`alignment.json` 同时记录每台相机的 `captureRound + 帧内行比例` 头部位置、相对参考相机的帧偏移和只用于显示的补偿量；灰度历史平铺以补空白的方式对齐头部，不移动或重写原始图像，JET 与 3D 则直接使用距头同步锚点。

`captureDefaults.frameTriggerMode` 支持 `free-run` 和 `software`。`software` 会在服务重启连接相机时设置 `TriggerSelector=FrameStart`、`TriggerMode=On`、`TriggerSource=Software`，并在每帧元数据中记录软件触发命令时间。现场目前保持 `free-run`，切换前必须确认无钢、写队列清空，并核对 `/api/cameras` 中 `softwareTriggerCapable=true`。

外径采用关闭门禁：只有流水同步通过、六路序列号完全匹配、外参文件 `approved=true`、所有截面行未裁边且圆拟合残差达标时，`metricValid` 才为 `true`。缺外参时仍可查看 2D 裁剪和各相机局部截面，但界面只显示“仅预览”。

3D 质量报告把误差拆成两类：每相机去除径向中值偏差后的 `depthPrecisionP95Mm` 表示深度重复精度；`calibrationRadialBiasMedianMm`、每一对相机重叠区的 `p95AbsRadialDifferenceMm` 表示标定与拼接准确性。任一相机或任一重叠相机对超过配置毫米门限时，只允许预览，不批准公制重建结果。

标定时复制 `config/capture/sick-array-calibration.template.json`，使用有证书的标准棒拟合每台相机的 `localToArray` 4×4 矩阵，复核序列号和残差后再签署 `approved`。旧的 3G/YF 六相机 XML 不属于当前 254400xx Ranger3 阵列，不得复用。

没有编码器/测速输入时，截面外径仍可在同步和外参合格后计量，但纵向坐标只能使用“相对头部时间”；系统不会把它伪装成毫米。接入编码器或可靠线速度后，才能批准棒材长度、缺陷纵向尺寸和完整 3D 轴向计量。

## 回放索引、裁剪与图像金字塔

每根钢完成分析后，低优先级独立进程会生成以下派生数据，原始 PNG/NPZ 始终保持不变：

- `D:\steel-sick-data\<FLOW>\derived\playback\index.json`：按 `captureRound` 对齐的六相机回放索引，避免各相机丢弃黑帧后按本地文件编号错配；
- `D:\steel-sick-data\<FLOW>\derived\playback\roi.json`：同一流、同一相机共用的稳定横向有效窗口；
- `<相机根>\<FLOW>\cache\*.jpg`：该相机流水每张有效 2D 图的持久化渐进 JPEG 缩略瓦片，状态写在同目录 `status.json`；缓存不再跨相机集中存放。
- `<相机根>\<FLOW>\defect\*.jpg`：该相机流水的缺陷复核小图；流水级缺陷清单仍位于中央派生数据目录，图像路径指向这里。
- `<相机根>\<FLOW>\jet\surface.jpg`：该相机的高质量 JPEG JET 图；参考相机同目录的 `surface-all.jpg` 保存六相机展开图。中央 `surface.json` 只记录这些图像路径和几何数据。

裁剪先使用灰度连通占比排除孤立亮点，再组合“流级稳定左右边界”和“当前帧头尾边界”。缓存目录中的指纹 JSON 清单保存 `originalSize`、`validRoi`、`frameDetectedRoi` 和 `flowHorizontalRoi`，算法测量结果中的 `sourceCoordinateOffset` 可将裁剪坐标还原到原始相机坐标。

回放前端根据 2×3 网格单元的实际 CSS 像素、裁剪后宽高比和设备像素比请求最小够用层级。拖动时间轴时先合并 70 ms 内的连续选择，只预载最终目标的六路图像；六路加载完成或达到保护超时后再整体切换，并在空闲时预取相邻帧。
