# 软件版本更新发布说明

桌面客户端使用 Tauri v2 updater。客户端仅接受由内置公钥验证通过的更新包；更新源不可用、清单格式错误、版本未提升或签名不匹配时均不会安装。

## 一次性建立签名信任

在受控发布机生成 updater 密钥，私钥不得进入仓库：

```powershell
cd app/client
npm run tauri signer generate -- -w D:\release-secrets\steel-inspection-updater.key
```

将私钥和密码备份到组织的发布密钥库。把生成的公钥内容作为正式构建环境变量 `STEEL_UPDATE_PUBLIC_KEY`。默认更新清单地址为：

```text
https://github.com/a1112/steel-plate-3d-inspection/releases/latest/download/latest.json
```

如需使用企业内部 HTTPS 更新服务，在构建时设置 `STEEL_UPDATE_ENDPOINT`。该变量会编译进客户端；不要使用 HTTP 更新源。

## 构建签名更新包

发布前同步以下四处的 SemVer 版本，并创建同版本 Git 标签：

- `app/client/package.json`
- `app/client/package-lock.json`
- `app/client/src-tauri/tauri.conf.json`
- `app/client/src-tauri/Cargo.toml`

正式构建环境必须同时提供：

```powershell
$env:STEEL_UPDATE_PUBLIC_KEY = Get-Content D:\release-secrets\steel-inspection-updater.key.pub -Raw
$env:TAURI_SIGNING_PRIVATE_KEY = Get-Content D:\release-secrets\steel-inspection-updater.key -Raw
$env:TAURI_SIGNING_PRIVATE_KEY_PASSWORD = '<从发布密钥库读取>'
```

现有正式打包流程会继续执行 Authenticode、发布策略、SBOM 和离线依赖检查；Tauri 另外生成 Windows updater `.zip` 与 `.sig` 文件。两套签名用途不同，均不可省略。

## 生成并发布 latest.json

把 updater `.zip` 和 `.sig` 上传到同一 GitHub Release，再生成静态更新清单：

```powershell
.\scripts\generate-tauri-update-manifest.ps1 `
  -Version '1.5.0' `
  -BundleUrl 'https://github.com/a1112/steel-plate-3d-inspection/releases/download/v1.5.0/client.nsis.zip' `
  -SignaturePath 'D:\release\client.nsis.zip.sig' `
  -Notes '本版本的变更说明' `
  -OutputPath 'D:\release\latest.json'
```

将 `latest.json` 上传到该 Release，并确保它成为仓库最新的非预发布版本。客户端通过“更多 → 软件更新”检查、下载并安装；Windows 安装阶段会自动关闭客户端。

## 验证

```powershell
.\scripts\test-tauri-update-manifest.ps1
cargo check --locked --manifest-path app/client/src-tauri/Cargo.toml
cd app/client
npm test -- --run src/components/SoftwareUpdateDialog.test.tsx src/components/AppFooter.test.tsx
npm run build
```

工程浏览器预览和未绑定 `STEEL_UPDATE_PUBLIC_KEY` 的桌面构建只展示当前版本及配置提示，不能下载安装。
