# dsh-share-pack

> 跨设备会话交接：把一台 DSH 的对话变成**一行短链接**，贴到另一台 DSH（手机 / 家里电脑 / 公司电脑），那边的会话读完就能接着干。

![npm](https://img.shields.io/npm/v/dsh-share-pack)
![license](https://img.shields.io/npm/l/dsh-share-pack)

## 解决什么问题

手机上和 DSH 聊到一半，回家想在电脑上继续——但两边是两个完全独立的会话，没有共享通道，只能靠人肉复述。这个插件给每个会话加一个**分享**动作，把当前进度压缩成一行链接；另一台设备上的 DSH 用 `read_session_pack` 工具读回，先复述目标和进度，再继续。

| 方式 | 谁写交接单 | 适合 |
| --- | --- | --- |
| 会话头部「分享」按钮 | 程序从会话存档里自动摘 | 一键、最快，摘的是实录 |
| 模型调用 `share_session_pack` 工具 | 模型自己写（目标 / 决定 / 事实 / 待办） | 要精准、要少噪声 |
| 接收端 `read_session_pack` 工具 | —— | 把链接粘进对话，说「读一下这个交接链接」 |

默认出的是 29 字符的短链接（令牌上传到公共粘贴站）；粘贴站不可用时自动退回自包含长链接（约 1300–1600 字符，`dshshare://open/DSHP1.…`）。

## 安装

### 方式一：公司 / 家里电脑（桌面版 DSH）

仓库或压缩包拿到本目录后：

```bash
node install.mjs                 # 装到 ~/.dsh/profiles/desktop
node install.mjs --profile /path/to/profile
node install.mjs --dry-run       # 只看会改什么
```

脚本会把插件复制进 `<profile>/node_modules/dsh-share-pack`，并在 profile 的 `package.json` 里登记依赖与 `dsh.profile.bundles`（改前备份 `package.json.bak`）。**装完完全退出并重开 DSH 桌面端**。

### 方式二：从 npm

已发布到 npm 后，在 profile 目录里：

```bash
npx dsh-share-pack-install        # 写入依赖并复制文件，装完重启 DSH
```

或者手动：在 `<profile>/package.json` 里加

```json
{
  "dependencies": { "dsh-share-pack": "^0.2.0" },
  "dsh": { "profile": { "bundles": ["dsh-share-pack"] } }
}
```

再在 profile 目录执行 `pnpm install`，然后重启桌面端。

### 配置（可选）

```json
// ~/.dsh/dsh-share-pack.json
{
  "secret": "三台设备相同的口令",
  "providers": ["pastes.dev", "paste.rs", "mclo.gs"],
  "timeoutMs": 15000
}
```

配置文件每次使用都会重读，改完不用重启。`secret` 为空 = 明文上传。

## 用法

### A. 按钮（一键）

1. 在要分享的会话里点标题栏右侧的「分享」；
2. 按钮变成「已复制 · N 字」，剪贴板里是短链接；
3. 微信 / 备忘录 / 邮件发到另一台设备；
4. 在另一台 DSH 里粘贴，说「读一下这个交接链接」；
5. 那边的模型调用 `read_session_pack`，拿到交接单先复述目标与进度，再继续干活。

浏览器不给剪贴板权限时会弹输入框，里面就是链接，手动复制。

### B. 模型工具（精准）

直接说「把当前进度整理成交接单发我」，模型调用 `share_session_pack` 自己填写：`goal`、`decisions`、`facts`、`todos`、`files`、`recent`、`note`。这条路噪声最小，因为它不整段搬原文。

### C. 命令行

```bash
node bin/dsh-share.mjs pack 交接单.md --title "千川计划复制" --machine phone
node bin/dsh-share.mjs read "dshshare://open/DSHP1...."
```

## 链接里有什么

默认紧凑模式（预算 2600 字符、单条消息截到 600 字）：会话标题、工作目录、目标 / 会话起点（第一条真人消息）、对话摘录（取尾部）、工具活动一行统计、最后一次待办、给接手会话的说明。系统注入的上下文提醒会被剔除，对话里已存在的 `dshshare://…` 会替换成占位符，避免链接滚雪球。

想要完整版：`GET /dsh-share/pack?session=<id>&mode=full`，或让模型用 `share_session_pack` 自己写。

实测：3160 条事件的会话 → 紧凑模式约 1000 字交接单 / 约 1300 字符长链接；`mode=full` 约 6100 字 / 约 5700 字符。

## 隐私与加密

- 默认**明文**上传到公共粘贴站：拿到链接的人能解出交接单内容。别把链接贴到公开群或公开仓库。
- 想要私密：每台设备 `~/.dsh/dsh-share-pack.json` 填同一个 `secret`，上传的就是 AES-256-GCM 密文（scrypt 派生密钥，`DSPE1.` 前缀），口令不进链接；对端口令不一致会明确报错。
- 短链接指向的粘贴站内容可能过期；插件在没有网络/粘贴站时自动退回自包含长链接，不依赖任何服务器。

## 局限

- **不是实时同步**：一次性快照，A 改了 B 不会自动更新。
- **不是端到端加密的聊天**：没有中转或 P2P，双向对讲尚未实现。
- 按钮读的是本机会话存档 `~/.dsh/sessions/*/session-<id>/session.v4.jsonl.zstd`；被清理的旧会话可能读不到。

## 排错

| 现象 | 原因 |
| --- | --- |
| 没有「分享」按钮 | 没重启桌面端，或 `dsh.profile.bundles` 里没登记 |
| 按钮显示「分享失败」 | 路由 500：会话文件找不到（太旧 / 被清理） |
| 对端读不了 | 链接被聊天软件截断（插了换行/省略号），重发纯文本 |
| `checksum mismatch` | 链接被改动过，重新分享 |

## 开发

```bash
node test/smoke.test.mjs   # 4 个用例：令牌往返 / 真实会话解码 / 宿主路由 / 浏览器按钮
```

```
lib/core.js     纯函数：交接单构建、brotli 打包解包、加密封装、会话 zstd 解码、实录渲染
lib/relay.js    短链接传输：上传粘贴站拿短 URL、再取回
lib/index.js    宿主插件：两个模型工具 + GET /dsh-share/pack 路由
lib/client.js   浏览器插件：会话头部「分享」按钮
```

零运行时依赖（只用 node 内置模块），Node >= 22.15（用到 `zlib.zstdDecompressSync`）。

## License

MIT
