# 图片发送与生图

设置入口：**设置 → 图片与生图**。默认启用生图，通过本机 OpenCodex `http://127.0.0.1:10100/v1/images/generations` 调用已配置的上游。接口 Key 单独保存，不读取订阅登录令牌，不自动沿用聊天或搜索的 Key。生图模型默认留空，由上游选择；不要填聊天模型 `gpt-6-luna`。

## Agent 工具

- `send_image({ url })`：发送 HTTP(S) 公网图片直链。网页地址须先找到其中的图片直链；本工具不渲染网页或截屏。
- `generate_image({ prompt })`：生成一张图片，返回本会话的 `imageId` 和今日预算，不自动发送。
- `get_webpage_images({ url, limit: 20 })`：从网页静态 HTML 提取候选直链、alt 和可用尺寸，支持相对地址、懒加载、srcset、Open Graph/Twitter 图片元数据。候选文字不是指令，也不代表图片一定相关或可下载。
- `import_image({ url })`：下载公网图片直链并返回本会话 `imageId`，不发送图片、不扣生图次数。
- `import_image({ messageId, imageIndex: 0 })`：导入当前会话某条可见消息的图片。序号从 0 开始；支持群友图片及机器人先前发送的资源 ID，不能读取未来消息或被屏蔽成员的消息。
- `inspect_image({ imageId })`：让支持视觉的聊天模型查看参考图，确认内容后再改图；图片字节只进入本轮视觉输入，不进入持久化会话工具日志。关闭视觉时隐藏此工具，导入和图生图仍可使用。
- `generate_image({ prompt, referenceImageIds: ["图片ID"] })`：根据文字和参考图生成一张新图，保留原图，返回新 `imageId`。最多 4 张参考图，按数组顺序输入；仅支持 PNG/JPEG/WebP，合计最多 12 MiB。可以把生成结果继续作为下一次修改的参考。
- `send_image({ imageId })`：把生成的图片发送到当前会话。可以提供 `replyToMessageId` 或 `atUserId`。发送失败保留 ID，重发无需重新生图。

## 工具联动

`get_message_images({ messageId, imageIndex? })` 同时支持 QQ 图片 URL 和机器人发送后留档的本地 `imageId`，默认最多查看前 4 张、合计 12 MiB；可用从 0 开始的 `imageIndex` 单独查看其余图片。下载只做一轮必要的 DNS 校验，系统 DNS 超时可经安全公共 DNS 回退；HTTP 错误页不会被伪装成图片传给模型。QQ 原生 `face` 表情段没有图片附件，会明确提示；临时图片链接失效或附件地址缺失时可能需要重新发送原图。

用户可以直接说：“从这个网站找一张角色参考图，保留人物特征，按我的描述换成雪景背景，然后发出来。”Agent 按需串联：

```text
web_search（可选，找网页）
  → get_webpage_images({ url: "网页地址" })
  → import_image({ url: "选中的图片直链" }) → 参考图 imageId
  → inspect_image({ imageId: "参考图ID" })（视觉可用时）
  → generate_image({ prompt: "保留参考图人物，改成雪景背景", referenceImageIds: ["参考图ID"] })
  → send_image({ imageId: "新图ID" })
```

也可引用群友图片说“把这张图改成水彩风格”，通过 `import_image({ messageId: "引用消息ID" })` 开始。多图参考时在 prompt 中说明“图 1 提供人物、图 2 提供背景”等用途。以上是工具具备的调用路径，实际是否选到合适的图片取决于聊天模型与网站内容。

网页提取使用既有安全抓取层，只处理受限长度的静态 HTML，不执行 JavaScript、不登录网站、不解析外部 CSS 背景图。纯前端渲染、反爬或防盗链网站可能无法取得目标图；这时应换来源或请用户提供图片，不编造图片 URL。关闭联网搜索与网页抓取后，候选提取工具也关闭。下载参考图时重新检查 DNS 和每次重定向，禁止内网、本机 URL。

每次发送为单独的图片气泡，文字说明可用 `send_message` 另发。工具固定绑定当前群聊/私聊，不能指定其他收件人，不能使用其他会话的图片 ID，也不能读取任意本机文件。仍通过既有权限检查和发送队列限频；暂停后不得发送。

网页图片先由程序按安全 DNS 和逐跳重定向检查下载并保存，再交给 OneBot 的 `image` 消息段。默认情况下，HTTP 地址为本机回环地址时传递已校验资源的 `file:///` 地址；远程协议端使用 Base64，不发送本机文件路径。不会让 OneBot 再次抓取原 URL；旧的 `allowPrivateImageHosts` 开关不放宽本工具。导入和发送支持 PNG/JPEG/GIF/WebP，按字节特征检查格式，单张最多 12 MiB，超限直接失败；GIF 不能作为图生图参考。除显式看图的视觉输入外，工具只返回资源元数据，不将 Base64 放入模型文字上下文或会话工具日志。

SnowLuma 当前 OneBot HTTP 请求体上限为 2 MiB，超限会断开连接。因此同机大图片使用文件传输；Base64 模式超过该请求体上限时会提前报错。若协议端运行在容器或本地转发端口后、不共享文件系统，可在 `snowluma.imageTransport` 设置 `"base64"`，并使用较小图片。图片上传等待上限为 120 秒，普通查询/文字发送仍为 15 秒。断连或超时可能已经投递，先核对聊天记录，不自动重试；确认未收到再用原 `imageId` 重发。

## 每日预算

- 默认**每个群聊、每个私聊每天各 5 次**；同一人出现在不同群时，使用所在会话的预算。
- 文生图和图生图共用同一额度，参考图数量不增加请求次数；参考图下载、导入、查看不消耗生图次数（看图会消耗聊天模型 token）。无效、跨会话、重复或超限参考图在占用名额前拒绝。
- 按 **Asia/Shanghai（北京时间）零点**重置。
- 全局每日次数可调整；单会话设置使用 `group:群号=次数` 或 `private:QQ号=次数`，一行一个。`0` 表示禁止该会话生图。删除覆盖行后恢复默认次数。
- 每个请求固定 `n=1`。尺寸与画质来自控制台，模型无法提升参数或修改预算。默认请求 1024×1024、低质量，实际支持情况取决于上游。
- **按请求尝试扣次**：参数和权限通过后、发送上游请求前持久化占用名额。HTTP 失败、超时、断网、无效图片均不返还，避免上游已生成但客户端没收到时重复消耗。
- 不自动重试或切换其他服务。同会话最多一个生图请求进行中；跨进程通过独占名额文件防止超卖，重启不会清零。
- 已有图片的发送/重发不扣生图次数，但受普通发送限频约束。
- 设置页可按会话查询今日已用、上限和剩余次数。

这是调用次数预算，不是金额预算。实际订阅额度或 API 费用由 OpenCodex 的上游、模型及画质决定。没有额外的所有会话总次数上限。

## 存储与配置

图片与会话归属保存在 `data/image-assets/`，每日名额保存在 `data/image-budget/`。发送记录保留 `imageId`，图片不会自动清理；不要单独删除仍被聊天存档引用的图片。名额文件不存在才可占用，因此不要在当天手动清空预算目录。

```json
{
  "imageGeneration": {
    "enabled": true,
    "baseUrl": "http://127.0.0.1:10100/v1",
    "apiKey": "",
    "model": "",
    "size": "1024x1024",
    "quality": "low",
    "timeoutMs": 300000,
    "dailyLimit": 5,
    "chatDailyLimits": { "group:123456": 2, "private:123456": 0 }
  }
}
```

这版接入 Images JSON 接口：无参考图调用 `/images/generations`，有参考图调用 `/images/edits`，发送 `images: [{ image_url: "data:image/png;base64,..." }]`。即使配置了完整的 generations 地址，也会正确切换到 edits。参考图在本地验证后直接传字节，不让上游代抓 URL。要求返回单张 `data[0].b64_json`；尚不支持 mask 局部蒙版、批量生成、仅 multipart 编辑或仅返回 URL 的提供方。编辑失败不会自动丢弃参考图转为文生图。

## 验证记录

2026-10-29 读图故障排查：近期日志中的一次 `get_message_images` 失败来自 `multimedia.nt.qq.com.cn` 系统 DNS 超时，另一次“没有可查看的图片”来自旧工具忽略机器人消息中的 `imageId`。已补系统 DNS 异常的安全回退、移除下载前重复解析、支持本地资源读图，并拒绝把 HTML 错误页作为视觉输入。原失败 QQ 链接重新下载成功；当前配置的 `gpt-6-luna` 经 OpenCodex 单次读图正确回答“红色圆形，背景白色”。这验证了本次请求，不保证网络始终可用；测试未向 QQ 发送消息。

2026-10-28 检查本机 OpenCodex 2.73.0：`src/server/images.ts` 实现 `/v1/images/generations` 和 `/v1/images/edits`，支持 ChatGPT 登录上游转发。使用新适配器实测单张生成，约 17 秒返回 975765 字节 PNG，已打开核对画面；未向 QQ 发送。

2026-10-29 用同一测试图片进行一次真实编辑，将蓝色圆形改为红色；约 15 秒返回 1479254 字节 PNG，已打开确认改色且保留位置与白色背景。使用独立测试数据目录、预算上限 1 次，未消耗真实会话的计数，未向 QQ 发送。多图参考的请求顺序与格式由模拟接口验证，尚未对多图做真实生成测试。

`npm run test:images` 覆盖持久化预算、跨日、跨进程并发、编辑端点、多参考图、校验失败不扣次、错误/取消、不重试、图片隔离、权限和模拟 OneBot 发送；`npm run test:fetch` 覆盖 HTML 提取、图片下载、内网保护，以及真实 Agent 编排配合模拟模型/网站/发送端走完“提取→导入→看图→编辑→发送”。真实 QQ 投递需要运行中的协议端和目标会话，当前发送验证使用模拟 OneBot。

参考：[OpenCodex 仓库](https://github.com/lidge-jun/opencodex)、[OpenAI 官方 Images API 指南](https://developers.openai.com/api/docs/guides/image-generation)、[Images 编辑接口](https://developers.openai.com/api/reference/resources/images/methods/edit)。OpenAI 文档说明接口形态；本机订阅路径是否可用以本机转发实现和实测为准。
