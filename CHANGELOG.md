# Changelog

## 0.1.1

- 将 Codex App Server 默认客户端名称从 `tavlo_dsh` 改为 `codex_dsh`，并增加 `clientName` 配置，以适配供应商对 `originator` 和 `User-Agent` 的接入要求。
- 统一会话、模型发现和本机协议检查的初始化逻辑，客户端版本读取插件的实际版本。
- 将供应商客户端拒绝与凭据认证失败分别诊断，避免将 `unauthorized client detected` 提示为需要重新登录。
- 使用彩色 Codex SVG 图标，并保留图标许可。
- 增加 GitHub Actions 验证与 npm OIDC 发布工作流。
