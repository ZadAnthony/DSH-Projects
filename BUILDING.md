# 从源码构建

安装预构建插件请看 [README](README.md)。下面的步骤用于修改源码和重新生成普通 `.tgz` 插件包；不替换 DSH 宿主。

## 环境

- Node.js 24，带与该 Node 版本匹配的开发头文件；当前验证使用 24.21.0。
- Git、npm，以及可运行固定 pnpm 版本的 Corepack。上游 SDK 固定使用 pnpm 11.28.5。
- macOS 构建需要 Xcode Command Line Tools。当前公开候选的验证环境为 macOS arm64；其他平台尚未验证。
- 能访问 GitHub 和 npm 公共源。首次准备会下载完整上游 SDK 及其依赖，需要数 GB 磁盘空间。

## 准备固定上游 SDK

在本仓库根目录执行。SDK 独立放在被 Git 忽略的 `.vendor/` 中：

```sh
mkdir -p .vendor
git init .vendor/deepseek-harness
git -C .vendor/deepseek-harness fetch --depth=1 https://github.com/deepseek-ai/deepseek-harness.git b830ec950faba0a46dda564be3e2d854afed94f1
git -C .vendor/deepseek-harness checkout --detach FETCH_HEAD
```

进入 SDK 目录，安装其锁定依赖并使用上游正常构建命令：

```sh
cd .vendor/deepseek-harness
corepack pnpm install --frozen-lockfile
corepack pnpm run build:artifacts
cd ../..
```

这是 DeepSeek Harness `0.2.1-rc.5` 的固定公开提交。仅有下载后的源码不够，插件需要 SDK 已生成的类型、构建工具和 Remote 生成器。不要用日常运行中的宿主目录作构建工作区。

如果已在其他位置准备了同一固定提交的独立 SDK，可在当前终端设置 `DSH_PROJECTS_STOCK_ROOT` 为其绝对路径；否则使用上面的默认目录。构建会临时在该 SDK 内放入插件类型投影，并在完成或报错时清理，不修改宿主源码。

## 构建插件

回到本仓库根目录执行：

```sh
npm run deps:install
npm run prepare:workspace
npm run prompts:check
npm run test:records
npm run test:prompts
npm run build
```

`deps:install` 通过 `scripts/plugin-dependencies/package-lock.json` 安装插件自己的普通依赖。构建时需要 Google SDK 的 JavaScript 与类型，其安装生命周期脚本不属于构建输入，因此这里使用 `--ignore-scripts`；最终用户安装 `.tgz` 使用正常插件管理器，不需要该选项。

完成后，插件包位于：

```text
.build/dsh-projects-0.1.0-beta.3.tgz
```

通过 README 中的正常插件管理器安装该文件。`.build/` 同时包含本次生成物及构建记录，不提交到源码仓库。构建过程包含 Host/Client 类型检查、官方 Remote 生成、界面资源装配以及 macOS 原生组件编译。

## 修改与检查

- 实现入口在 `workspace/packages/projects/src/`，正常宿主插件入口为 `src/stock/index.ts`。
- Agent 运行提示词在 `workspace/packages/projects/prompts/`。修改正文后运行 `npm run prompts:sync`，再运行 `npm run prompts:check`；不要手改生成的 `src/prompts/catalog.generated.ts`。
- `test:records` 检查记录保存和读取；`test:prompts` 检查正式提示词及其消费者。两项是本仓库提供的定向检查，不代表全产品或模型效果验证。
- `npm run typecheck:host` 和 `npm run typecheck:client` 均执行完整 Host/Remote/Client 类型检查，不启动业务。
- 对构建或类型检查命令追加 `-- --plan`，可以只查看所选 SDK、命令及输出位置。

构建输出默认在 `.build/`，可用 `DSH_PROJECTS_BUILD_ROOT` 指定另一个独立输出目录。macOS 上 Node 头文件位于非标准位置时，可用 `DSH_PROJECTS_NODE_INCLUDE` 指定包含 `node_api.h` 的目录。测试资料仅放在本次构建输出内的临时目录，不使用日常项目资料。

SDK 输入和插件依赖分别锁定；实际安装测试仍需使用对应包。重新构建不承诺与已有发行包逐字节相同。
