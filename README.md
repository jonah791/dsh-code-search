# dsh-code-search


<p align="center">
  <a href="https://github.com/jonah791/dsh-code-search"><img src="https://img.shields.io/badge/version-0.1.0-blue" alt="version"></a>
  <img src="https://img.shields.io/badge/License-MIT-green" alt="license">
  <img src="https://img.shields.io/badge/TypeScript-3178C6" alt="TypeScript">
</p>
> 本地代码/文件智能检索：封装系统 rg（ripgrep），排除噪音，精准定位。
> DeepSeek Harness 自研插件 · v0.1.0

## 定位

给智能体一个「懂大仓」的检索工具——封装系统 rg，默认排除 node_modules/.pnpm/dist 等噪音目录，输出精简可读，比通用 grep 更适合搜源码大仓。

## 功能特性

- **智能全文检索**：`code_search`（rg 封装）——默认排除 node_modules/.pnpm/dist/build/coverage/.git 噪音；支持根路径（缺省 E:/alice）、include/exclude glob 过滤、正则模式
- **快速定位文件**：`code_locate`——按概念/符号搜「哪些文件包含某词」（rg -l 语义），返回文件清单，用于「X 在哪个文件」
- **Windows 盘符支持**：正确处理 Windows 路径（盘符解析坑已规避）

## 安装

```bash
git clone https://github.com/jonah791/dsh-code-search.git self-plugins/dsh-code-search
cd self-plugins/dsh-code-search && pnpm install && pnpm build
```

挂载到 web profile。组合行 id：`agent-code-search`。

## 使用（工具面）

| 工具 | 用途 |
|------|------|
| `code_search` | 智能全文检索（正则/glob/路径过滤，默认排噪音） |
| `code_locate` | 按概念定位文件（「X 在哪个文件」） |

## 配置

| 字段 | 默认 | 说明 |
|------|------|------|
| `defaultPath` | E:/alice | 检索根路径 |

## 技术要点

- 基于系统 rg（ripgrep），--json 结构化输出
- 噪音排除设计：默认剔除 node_modules/.pnpm/dist/build/coverage/.git——大仓检索的关键
- 依赖系统 rg 可用

## License

MIT