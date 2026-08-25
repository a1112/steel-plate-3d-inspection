# 检测系统边界与响应式缩略图决策

> 状态：Accepted
> 日期：2026-08-25
> 来源：`D:\project\deep-research-report (3).md` 的架构建议与当前代码审计

## 决策

系统按“采集事实 → 不可变算法产物 → 业务编排 → 媒体派生 → 展示”单向流动。在线与回放只改变数据时效，不改变模块所有权。新代码不得通过共享目录、数据库表或 UI 计算绕过正式契约。

| 边界 | 拥有的职责 | 明确不负责 |
| --- | --- | --- |
| Acquisition | 相机发现、连接、触发、原始帧落盘、健康与 committed-frame 事件 | 对齐、测径、区域、表面、缺陷、回放金字塔 |
| Image / Geometry Pipeline | 对齐、有效区、几何、直径序列、表面及版本化产物 | 相机生命周期、业务判定、UI 状态 |
| Defect Detection | 只消费不可变图像/几何产物并输出缺陷证据 | 直接控制相机或回写 UI |
| Inspection Service | 记录、权限、状态机、业务编排及公共 API | 解码、缩放、拼图、算法计算 |
| Media / Artifact Service | 产物目录解析、缩略图/ROI/兼容瓦片、编码与缓存 | 业务流程、缺陷判定、相机控制 |
| Desktop UI | 显示服务端产物、选择实时/回放、滚动与交互 | 读取共享目录、拟合测径、拼原图、推导业务真值 |

允许的依赖方向：

```text
Acquisition -> committed-frame contract -> Pipeline -> immutable artifact catalog
                                                        |-> Defect Detection
                                                        |-> Media Service -> Inspection API -> UI
Inspection Service -------------------------------------^
```

## 采集与算法交接

采集完成一轮后只发布 durable committed-frame 事件。事件至少包含 `recordId/materialId`、相机、序号、原始对象身份、尺寸、时间和提交修订号。算法 Worker 只读取该事件和已提交原始对象；不能调用 provider 内部状态获取“半提交”帧。

当前 `scripts/sick_capture/provider.py` 仍包含历史算法/回放桥接代码，属于显式迁移债务。新的派生能力只允许进入 `scripts/sick_flow_analysis_service.py` 或独立 Pipeline Worker，不得继续扩大 provider 的算法依赖。

## 响应式缩略图契约

媒体服务的正式内部入口为：

```http
GET /internal/v1/preview
  ?recordId=<id>
  &cameraId=<id>
  &sequenceNo=<n>
  &revision=<source-revision>
  &profile=xs|sm|md|lg|xl
  &colorMode=gray|jet
```

也可提交 `slotWidth`、`slotHeight`，由服务端映射到有限档位。档位是缓存键的一部分，CSS 像素抖动不会生成无限缓存对象。

| 档位 | 最大输出 |
| --- | --- |
| `xs` | 512 × 128 |
| `sm` | 768 × 192 |
| `md` | 1024 × 256 |
| `lg` | 1536 × 384 |
| `xl` | 2048 × 512 |

缩放使用 `contain`，保持纵横比并禁止放大小图。缩略图失败时返回明确错误，绝不回退发送原始大图。灰度和 JET 是不同源产物：`colorMode=jet` 只能读取已处理的 `kind=jet` 产物，不能把灰度图在媒体服务或 UI 中临时伪彩化；原灰度显示保持原样。

历史修订响应使用 `ETag` 和 `Cache-Control: public, max-age=31536000, immutable`。`live=1` 使用 `no-store`。缓存键必须包含源对象身份、源修订、记录、相机、序号、源类型、颜色模式、档位、契约版本和编码器版本。

缓存分两层：内存按总字节数 LRU 淘汰；磁盘位于 `renditions/thumbnail-v1`，临时文件编码成功后原子改名。同一键只允许一个构建者，其他请求等待并复用结果。

## UI 规则

主监测区使用可滚动的裁剪/拼接预览，不再把完整 Inspection World 瓦片视口当作默认首页。组件使用 `ResizeObserver` 选择档位；同档位内尺寸变化不重新请求。实时和回放入口属于页脚状态控制，切换记录只改变服务端记录身份和修订号。

世界坐标、相机边界和缺陷坐标仍由 Inspection World 元数据拥有，不能从缩略图显示尺寸反推。需要精确定位时使用元数据加 ROI/证据接口。

## 兼容与迁移

- `/api/tile` 与 `/internal/v1/tile` 暂时保留，只用于旧客户端；响应带弃用 Warning。
- 新 `/api/preview` 与 `/internal/v1/preview` 已独立实现，不得转调 tile。
- 旧瓦片设计文档标记为 Superseded，仅作为兼容历史。
- Inspection Service 中现存的图像合成逻辑是下一阶段迁移对象；迁移完成前不删除旧入口。
- 每次边界变更运行 `scripts/verify-source-boundaries.ps1`，同时执行媒体服务测试。

## 验收

- `main.rs` 只做配置和启动，不包含 SQL、HTTP 路由或图像处理。
- catalog、HTTP、codec、rendition、cache、legacy tile 分文件且单向依赖。
- preview 的档位选择、禁止放大、修订/颜色缓存隔离、字节 LRU 有自动测试。
- JET 请求找不到已处理 JET 产物时明确失败，不使用灰度替代。
