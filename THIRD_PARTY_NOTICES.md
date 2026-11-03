# 第三方许可与来源

DSH Projects 自有代码采用根目录 [MIT License](LICENSE)。以下复用源码和依赖继续适用各自的许可证；根许可证不改变第三方的版权声明或许可条件。

| 来源 | 许可 | 本仓库记录 |
| --- | --- | --- |
| [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 的部分运行、模型适配与界面代码，Copyright (c) 2026 DeepSeek | MIT | `workspace/packages/projects/src/stock/` 各复用目录保留 `LICENSE`、`LICENSE.DSH` 及 `SOURCES.md`／`SOURCES.json`，记录实际来源与本地修改。 |
| [pi](https://github.com/earendil-works/pi) 的 `@earendil-works/pi-ai` 0.87.1，Copyright (c) 2025 Mario Zechner | MIT | [许可证](workspace/packages/projects/src/stock/model/provider-sdk/LICENSE)、[上游说明](workspace/packages/projects/src/stock/model/provider-sdk/UPSTREAM-NOTICE.md)及同目录来源记录。 |

Client 构建会把 Lexical 编辑器家族（MIT，Copyright (c) Meta Platforms, Inc. and affiliates.）、clsx（MIT，Copyright (c) Luke Edwards）等实际使用的代码内联到插件中；实际内联的 TanStack 库及 DSH 重命名的 cosmokit／schemastery 等 vendor 库也继续保留各自原始许可与版权，不能仅由本项目或 DSH 的根 MIT 许可替代。构建按实际发射的 Client／Host 模块收集这些包的完整 LICENSE／NOTICE 和包元数据，分别放在安装包的 `lib/notices/client-bundled/` 与 `lib/notices/host-bundled/`；各目录的 `SOURCES.json` 记录实际包名、版本、许可证和输入哈希。Host 未内联第三方包时，其清单为空。原始依赖源码由公开依赖清单和固定 DSH 源码提供，不把整个 node_modules 复制进本仓库。

预构建插件还包含 Google GenAI Node 运行代码及所需依赖。安装包内的 `lib/notices/bundled/SOURCES.json` 逐项列出实际包名、版本、许可证和输入来源；同目录下保留对应的原始许可证、NOTICE 与包元数据。它们包含 Apache-2.0、MIT 和 BSD-3-Clause 等许可，不能统一视为本项目的 MIT 代码。

发行包中的 `NOTICE.md` 与 `lib/notices/` 同时保留 DSH 许可和复用源码的来源记录。未打入包内、由宿主或包管理器提供的运行依赖，继续保留其各自的许可证。重新分发对应源码或二进制时，请一并保留适用的版权、许可与通知文件。
