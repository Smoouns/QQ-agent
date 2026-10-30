# 网页抓取与代理 DNS

`web_fetch` 支持 HTTP(S) URL 和完整的单个 Markdown 链接，例如 `[页面](https://example.org/page)`。

某些代理的 Fake-IP 模式会把公网域名解析成 `198.18.0.0/15` 中的虚拟地址。遇到系统 DNS 的全部结果都在这个范围，或系统 DNS 查询失败/超过 5 秒时，抓取器默认向 Cloudflare 的固定 HTTPS DNS 端点查询真实 A/AAAA 地址。只发送域名和记录类型，不发送网页路径、聊天内容或凭据。系统 DNS 已返回私网或公私混合结果时仍直接拒绝，不借回退放行。启用旧图片内网例外的下载不使用 DNS 失败回退。

公共 DNS 结果仍需全部通过内网检查，实际连接固定到校验后的 IP，并保留网站的 Host、SNI 和证书验证；每次重定向重新检查。直接输入私网或 Fake-IP 地址不会获得放行。公共 DNS 不可用时明确报错，不退回连接虚拟地址。

如需禁用这个兼容行为，可在 `data/config.json` 的 `security` 中设置 `"fakeIpDnsFallback": false` 后重启。不要通过开启 `allowPrivateImageHosts` 处理网页抓取问题：该开关只用于图片内网例外。

抓取器读取服务器返回的 HTML，不运行网页 JavaScript；依赖脚本渲染的页面可能只返回页面外壳。这与 DNS 拦截是不同问题。

验证：`npm run test:fetch`（离线模拟 DNS、HTTPS 和重定向，不访问真实网站）。
