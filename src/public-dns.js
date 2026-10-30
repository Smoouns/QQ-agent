// Fake-IP 兼容：绕过本机 DNS，仅查询固定公共解析器，再由 safe-fetch 校验并固定目标 IP。
import https from 'node:https';
import net from 'node:net';

export function isFakeIp(ip) {
  if (net.isIP(ip) !== 4) return false;
  const [a, b] = ip.split('.').map(Number);
  return a === 198 && (b === 18 || b === 19);
}

function query(hostname, type) {
  return new Promise((resolve, reject) => {
    let req;
    let settled = false;
    const finish = (error, result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error) { reject(error); req?.destroy(); }
      else resolve(result);
    };
    const timer = setTimeout(() => finish(new Error('公共 DNS 查询超时')), 5000);
    try {
      req = https.request({
        // 固定解析器 IP，避免解析器域名也被本机 Fake-IP 接管。
        hostname: '1.1.1.1', port: 443, servername: 'cloudflare-dns.com',
        rejectUnauthorized: true, method: 'GET',
        path: `/dns-query?${new URLSearchParams({ name: hostname, type })}`,
        headers: { host: 'cloudflare-dns.com', accept: 'application/dns-json' }
      }, (res) => {
        if (res.statusCode !== 200) {
          res.destroy();
          finish(new Error(`公共 DNS HTTP ${res.statusCode}`));
          return;
        }
        let size = 0;
        const chunks = [];
        res.on('data', (chunk) => {
          if (settled) return;
          size += chunk.length;
          if (size > 65536) {
            finish(new Error('公共 DNS 响应过大'));
            res.destroy();
          } else chunks.push(chunk);
        });
        res.on('error', (error) => finish(error));
        res.on('aborted', () => finish(new Error('公共 DNS 响应中断')));
        res.on('end', () => {
          if (settled) return;
          try {
            const data = JSON.parse(Buffer.concat(chunks).toString('utf8'));
            if (data.Status !== 0 || data.TC === true) throw new Error('公共 DNS 返回失败或不完整结果');
            if (data.Answer !== undefined && !Array.isArray(data.Answer)) throw new Error('公共 DNS 结果格式无效');
            const addresses = (data.Answer || []).filter((r) => r.type === 1 || r.type === 28).map((r) => {
              const family = r.type === 1 ? 4 : 6;
              if (typeof r.data !== 'string' || net.isIP(r.data) !== family) throw new Error('公共 DNS 返回无效 IP');
              return { address: r.data, family };
            });
            finish(null, addresses);
          } catch (error) { finish(error); }
        });
      });
      req.on('error', (error) => finish(error));
      req.end();
    } catch (error) { finish(error); }
  });
}

export async function lookupPublicHost(hostname) {
  // A 和 AAAA 都检查，不能忽略另一族中的内网地址。优先使用 IPv4 连接。
  const results = await Promise.all([query(hostname, 'A'), query(hostname, 'AAAA')]);
  const addresses = results.flat().sort((a, b) => a.family - b.family);
  if (!addresses.length) throw new Error('公共 DNS 没有解析结果');
  return addresses;
}
