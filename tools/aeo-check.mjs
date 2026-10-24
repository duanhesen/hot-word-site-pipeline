/**
 * AEO 自查：LLM（ChatGPT / Perplexity / Claude）能不能看见并引用我们的站。
 *
 *   node tools/aeo-check.mjs                 # 查默认三个站
 *   node tools/aeo-check.mjs ozilai.ink      # 只查一个
 *
 * 检查项来自 ChatGPT 搜索的实际行为：
 *   - 能不能抓（robots + 真实 UA）
 *   - 读不读得懂（llms.txt、结构化数据、可抽取的事实句）
 *   - 有没有被推送过（IndexNow 验证文件）
 */
import { lookup } from 'node:dns/promises'

const DOMAINS = process.argv.slice(2).length
  ? process.argv.slice(2)
  : ['ozilai.ink', 'talkdirty.ink', 'imsorryilied.ink']

const BOTS = {
  'GPTBot': 'Mozilla/5.0 (compatible; GPTBot/1.2; +https://openai.com/gptbot)',
  'OAI-SearchBot': 'Mozilla/5.0 (compatible; OAI-SearchBot/1.0; +https://openai.com/searchbot)',
  'ChatGPT-User': 'Mozilla/5.0 (compatible; ChatGPT-User/1.0; +https://openai.com/bot)',
  'PerplexityBot': 'Mozilla/5.0 (compatible; PerplexityBot/1.0; +https://perplexity.ai/perplexitybot)',
  'ClaudeBot': 'Mozilla/5.0 (compatible; ClaudeBot/1.0; +https://www.anthropic.com)',
}

async function resolveReal(host) {
  // 本机 DNS 可能被代理劫持，直接用 Cloudflare DoH 拿真实 IP
  const res = await fetch(`https://cloudflare-dns.com/dns-query?name=${host}&type=A`, {
    headers: { accept: 'application/dns-json' },
  })
  const body = await res.json()
  return body.Answer?.[0]?.data ?? (await lookup(host)).address
}

async function get(url, ip, host, ua) {
  const res = await fetch(url, {
    headers: { 'user-agent': ua ?? 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)' },
    redirect: 'manual',
    // @ts-expect-error Node 的 fetch 支持 dispatcher 之外的方式：这里用 headers 的 host 覆盖
    host,
  }).catch(() => null)
  return res
}

function score(ok) {
  return ok ? '✅' : '❌'
}

for (const domain of DOMAINS) {
  const ip = await resolveReal(domain)
  const base = `https://${domain}`
  console.log(`\n=== ${domain}  (${ip}) ===`)

  // 1. robots
  const robots = await (await fetch(`${base}/robots.txt`)).text().catch(() => '')
  const blocked = /User-agent:\s*\*[\s\S]*?Disallow:\s*\/\s*$/m.test(robots)
  console.log(`${score(!blocked)} robots.txt ${blocked ? '全站禁止抓取' : '允许抓取'}`)

  // 2. llms.txt
  let llms = null
  try {
    const r = await fetch(`${base}/llms.txt`)
    llms = r.ok ? await r.text() : null
  } catch {}
  console.log(`${score(!!llms)} llms.txt ${llms ? `${llms.length} 字符` : '缺失（404 或不可读）'}`)

  // 3. 各 UA 是否能拿到首页
  const uaResults = []
  for (const [name, ua] of Object.entries(BOTS)) {
    try {
      const r = await fetch(base, { headers: { 'user-agent': ua }, redirect: 'manual' })
      uaResults.push(`${name}:${r.status}`)
    } catch {
      uaResults.push(`${name}:ERR`)
    }
  }
  const allOk = uaResults.every((x) => x.endsWith(':200'))
  console.log(`${score(allOk)} AI 爬虫访问  ${uaResults.join(' ')}`)

  // 4. 结构化数据
  const html = await (await fetch(base)).text()
  const jsonLd = [...html.matchAll(/<script type="application\/ld\+json"[^>]*>([\s\S]*?)<\/script>/g)].map((m) => m[1])
  const types = new Set()
  let faqCount = 0
  for (const block of jsonLd) {
    try {
      const parsed = JSON.parse(block)
      for (const node of parsed['@graph'] ?? [parsed]) {
        if (node['@type']) types.add(node['@type'])
        if (node['@type'] === 'FAQPage') faqCount += (node.mainEntity ?? []).length
      }
    } catch {}
  }
  const wanted = ['SoftwareApplication', 'FAQPage']
  const missing = wanted.filter((t) => !types.has(t))
  console.log(`${score(missing.length === 0)} 结构化数据  ${[...types].join(', ') || '无'}${missing.length ? `  ← 缺 ${missing.join('/')}` : ''}`)
  console.log(`${score(faqCount >= 5)} FAQ 条目 ${faqCount} 条（≥5 才够模型抽取）`)

  // 5. IndexNow（站点是否暴露了验证文件）
  const keyMatch = html.match(/name="indexnow[^"]*"\s+content="([^"]+)"/i)
  const keyFileOk = keyMatch ? (await fetch(`${base}/${keyMatch[1]}.txt`)).ok : null
  console.log(`${keyFileOk === null ? '➖' : score(keyFileOk)} IndexNow 验证文件 ${keyFileOk === null ? '页面未暴露 key（正常，key 只在 sitemap 提交时用）' : keyFileOk ? '可访问' : '不可访问'}`)

  // 6. sitemap
  const sm = await (await fetch(`${base}/sitemap.xml`)).text().catch(() => '')
  const urls = [...sm.matchAll(/<loc>/g)].length
  console.log(`${score(urls > 0)} sitemap  ${urls} 个 URL`)

  // 7. 可抽取的事实句：llms.txt 里有没有具体数字
  if (llms) {
    const hasPrice = /\d+(\.\d+)?\s*(USD|EUR|\$)/i.test(llms)
    const hasSpec = /(seconds|s\b|9:16|MP4)/i.test(llms)
    console.log(`${score(hasPrice && hasSpec)} 可引用事实  价格${hasPrice ? '✓' : '✗'} 规格${hasSpec ? '✓' : '✗'}`)
  }
}
console.log('\n提示：以上只证明「模型读得到」。被推荐还需要站外提及（Reddit / YouTube / 目录站）和 Bing 收录，见《让 ChatGPT 推荐我们》.')
