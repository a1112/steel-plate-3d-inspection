# SICK 六相机简化存储与局域网共享

现场六相机原始数据使用相机专属根目录，根目录已经表达相机身份，流水目录下不再重复 `capture/Cx`：

```text
D:\C1\<流水号>\2d|3d|json
E:\C2\<流水号>\2d|3d|json
F:\C3\<流水号>\2d|3d|json
G:\C4\<流水号>\2d|3d|json
H:\C5\<流水号>\2d|3d|json
D:\C6\<流水号>\2d|3d|json
```

例如 C5 的 4018 流水为 `H:\C5\4018`。中央流程清单、事件、派生结果和回放索引仍位于 `D:\steel-sick-data\<流水号>`，避免在六块相机数据盘之间复制控制面数据。

离线迁移与索引重建要求 4317、4873、4875 服务均已停止：

```powershell
D:\project\py312\python.exe scripts\rebuild_sick_flow_storage.py `
  --profile config\sites\sick-array-6\capture.json `
  --env-file config\env\sick-postgres.local.env `
  --execute
```

先省略 `--execute` 可查看迁移计划。迁移只在原磁盘内重排原始目录，并写入 `D:\steel-sick-data\rebuild\camera-storage-v3-*.json` 日志；已存在的目标目录只允许按文件大小和 SHA-256 一致的方式合并。

确认新数据、数据库路径和历史回放均正常后，可清理同盘旧根、`obsolete-*` 归档及旧迁移日志。命令默认只输出精确目标；显式应用后只保留最新成功的 v3 重建日志：

```powershell
scripts\purge-sick-legacy-storage.ps1
scripts\purge-sick-legacy-storage.ps1 -Apply
```

清理脚本从当前采集配置计算活动路径，拒绝删除活动根、活动根的父目录或包含目录重解析点的旧树。`-Apply` 删除不可恢复，必须在迁移验证完成后使用。

局域网共享默认只读。用管理员 PowerShell 执行：

```powershell
scripts\configure-sick-data-shares.ps1 -Apply
```

其他电脑可访问 `\\<工控机名>\Steel-C1` 至 `\\<工控机名>\Steel-C6`。只有明确需要远程写入时才使用 `-ReadWrite`；采集验证和算法回放应保持只读。
