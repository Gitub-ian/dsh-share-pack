# 发布到 GitHub 与 npm

包已经准备好（元数据、LICENSE、CI、测试全绿）。下面两步需要你自己的账号凭证，命令在本目录执行。

## 0. 本地提交

```bash
git init -b main
git add -A
git commit -m "feat: dsh-share-pack 0.2.0"
```

## 1. GitHub

### 有 gh CLI

```bash
gh auth login
gh repo create dsh-share-pack --public --source=. --remote=origin --push
```

### 没有 gh（网页建库后推送）

1. https://github.com/new 建空仓库 `dsh-share-pack`（不要勾 README / .gitignore / license）
2. 推送：

```bash
git remote add origin https://github.com/<你的用户名>/dsh-share-pack.git
git push -u origin main
```

3. 把仓库地址写回 `package.json`：

```json
"repository": { "type": "git", "url": "git+https://github.com/<用户名>/dsh-share-pack.git" },
"homepage": "https://github.com/<用户名>/dsh-share-pack#readme",
"bugs": { "url": "https://github.com/<用户名>/dsh-share-pack/issues" },
```

4. 打标签：

```bash
git add package.json && git commit -m "chore: repo links"
git tag v0.2.0 && git push --follow-tags
```

## 2. npm

先去 https://www.npmjs.com/signup 注册（用户名会决定 `npm whoami`）。然后二选一：

### 交互登录（本机有浏览器）

```bash
npm login
npm whoami
npm publish --access public
```

### 用令牌（无人值守 / CI）

在 https://www.npmjs.com/settings/<用户名>/tokens 建一个 **Automation** token：

```bash
npm config set //registry.npmjs.org/:_authToken=<token>
npm publish --access public
```

开了 2FA 的账号会要求一次性验证码：`npm publish --access public --otp=123456`。

> 本机当前没有 npm CLI（DSH 自带的 node 里没装），可以 `corepack enable npm` 或直接用 DSH 自带 pnpm：`node <pnpm路径> publish --access public`。

## 3. 发布后验证

```bash
npm view dsh-share-pack version
npm view dsh-share-pack dist.tarball
npx dsh-share-pack-install --dry-run
```

## 名字占用情况（已查）

| 名字 | 状态 |
| --- | --- |
| `dsh-share-pack` | 空闲（registry 404），可用 |
| `dsh-share` | 已被占（0.5.0），所以 CLI 的 bin 名用 `dsh-share-pack` 避免冲突 |
| `dsh-session-share` | 已被占（0.1.1） |

## 发版流程（以后）

```bash
npm version patch   # 或 minor / major
git push --follow-tags
npm publish
```
