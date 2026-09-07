# dsh-code-search

本地代码/文件智能检索：封装系统 rg（ripgrep），默认排除 node_modules/.pnpm/dist 等噪音，支持多路径锚点/文件类型过滤/快速定位文件（code_search + code_locate）

## 工具
- `code_search`：智能全文检索（rg 封装）：默认排除 node_modules/.pnpm/dist/build/coverage/.git 噪音目录。可指定根路径（缺省 E:/alice）、glob 过滤、正则模式。比通用 grep 更适合搜大仓源码（排除噪音+输出精简）。
- `code_locate`：按概念/符号定位文件：搜哪些文件包含某词（rg -l 语义），排除噪音后返回文件清单——用于「X 在哪个文件」的快速定位。

## 构建与挂载

```sh
pnpm build
# 挂载到 web profile（dsh plugin-manager 或 plugin_mount）
```

组合行 id：`agent-code-search`
