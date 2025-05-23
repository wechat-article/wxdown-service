import fs from 'node:fs'
import path from 'node:path'
import http from 'node:http'
import osProxy from 'cross-os-proxy'
import puppeteer, { Browser } from 'puppeteer'
import { MitmproxyManager } from './mitmproxy-manager'
import { log } from './logger'
import { CredentialWatcher } from './credential-watcher'
import { getSystemProxy } from 'os-proxy-config'
import { HttpsProxyAgent } from 'https-proxy-agent'
import { exec } from 'node:child_process'
import { shell } from 'electron'
import dayjs from 'dayjs'
import { credentialJsonPath } from './mitmproxy-manager'

interface Resource {
  fileServer: Map<string, http.Server>
  browser: Browser | null
}

const _resource: Resource = {
  fileServer: new Map<string, http.Server>(),
  browser: null
}

// 查询指定目录下的 index.html 文件路径
export function findIndexHtmlFiles(dir: string, baseDir = dir, fileList: string[] = []): string[] {
  const files = fs.readdirSync(dir)

  files.forEach((file) => {
    const fullPath = path.join(dir, file)
    const stat = fs.statSync(fullPath)

    if (stat.isDirectory()) {
      // Recursively search in subdirectories
      findIndexHtmlFiles(fullPath, baseDir, fileList)
    } else if (file === 'index.html') {
      // Add index.html file to the list
      fileList.push(path.relative(baseDir, fullPath))
    }
  })

  return fileList
}

// 启动文件服务器
export function startFileServer(rootDirectory: string): Promise<http.Server> {
  if (_resource.fileServer.has(rootDirectory)) {
    return Promise.resolve(_resource.fileServer.get(rootDirectory)!)
  }

  // 创建HTTP服务器
  const server = http.createServer((req, res) => {
    // 解析请求路径，确保不会逃出 baseDirectory
    const safePath = path.normalize(path.join(rootDirectory, req.url!))
    if (!safePath.startsWith(rootDirectory)) {
      res.writeHead(403, { 'Content-Type': 'text/html' })
      res.end('<h1>403 Forbidden</h1>', 'utf-8')
      return
    }

    let filePath = decodeURIComponent(safePath)

    // 如果请求的是目录，默认返回 index.html
    if (fs.existsSync(filePath) && fs.statSync(filePath).isDirectory()) {
      filePath = path.join(filePath, 'index.html')
    }

    // 获取文件的扩展名并设置内容类型
    const extname = String(path.extname(filePath)).toLowerCase()
    const mimeTypes = {
      '.html': 'text/html',
      '.js': 'text/javascript',
      '.css': 'text/css',
      '.json': 'application/json',
      '.png': 'image/png',
      '.jpg': 'image/jpg',
      '.gif': 'image/gif',
      '.wav': 'audio/wav',
      '.mp4': 'video/mp4',
      '.woff': 'application/font-woff',
      '.ttf': 'application/font-ttf',
      '.eot': 'application/vnd.ms-fontobject',
      '.otf': 'application/font-otf',
      '.svg': 'application/image/svg+xml'
    }

    const contentType = mimeTypes[extname] || 'application/octet-stream'

    // 读取文件
    fs.readFile(filePath, (error, content) => {
      if (error) {
        if (error.code === 'ENOENT') {
          // 文件不存在，返回 404
          res.writeHead(404, { 'Content-Type': 'text/html' })
          res.end('<h1>404 Not Found</h1>', 'utf-8')
        } else {
          // 其他错误，返回 500
          res.writeHead(500)
          res.end(`Sorry, there was an error: ${error.code} ..\n`)
        }
      } else {
        // 成功读取文件，返回内容
        res.writeHead(200, { 'Content-Type': contentType })
        res.end(content, 'utf-8')
      }
    })
  })

  return new Promise((resolve, reject) => {
    // 启动服务器，监听端口 8080
    server.listen(0, () => {
      const port = (server.address() as { port: number }).port
      console.log(`文件服务器运行在 http://127.0.0.1:${port}/`)
      _resource.fileServer.set(rootDirectory, server)
      resolve(server)
    })
    server.on('error', reject)
    server.on('close', () => {
      console.log('文件服务器被关闭')
    })
  })
}

async function ensureBrowserLaunched(): Promise<void> {
  if (_resource.browser) {
    return
  }
  _resource.browser = await puppeteer.launch()
}

export async function generatePDf(url: string, outDir: string): Promise<void> {
  await ensureBrowserLaunched()

  const page = await _resource.browser!.newPage()
  await page.goto(url)

  const filename =
    url
      .replace(/\/index.html/, '')
      .split('/')
      .at(-1)! + '.pdf'
  await page.pdf({
    path: path.join(outDir, filename)
  })
}

export async function cleanup(): Promise<void> {
  log('开始清理资源...')
  await MitmproxyManager.close()
  await osProxy.closeProxy()
  if (_resource.browser) {
    log('关闭浏览器')
    await _resource.browser.close()
  }

  for (const server of _resource.fileServer.values()) {
    log('关闭文件服务器')
    await new Promise((resolve) => {
      server.close(resolve)
    })
  }
  log('资源清理完毕.')
}

export async function startMitmProxy(): Promise<number> {
  const port = await MitmproxyManager.startup()
  await osProxy.setProxy('127.0.0.1', port)
  await CredentialWatcher.listen()
  return port
}

export async function stopMitmProxy() {
  await osProxy.closeProxy()
  return MitmproxyManager.close()
}

// 验证 mitmproxy 代理设置是否正确
export async function verifyMitmproxy(): Promise<boolean> {
  const proxy = await getSystemProxy()
  if (!proxy || !proxy.proxyUrl) {
    return Promise.resolve(false)
  }

  return new Promise((resolve) => {
    const agent = new HttpsProxyAgent(proxy.proxyUrl)
    http.get('http://mitm.it', { agent }, (res) => {
      let data = ''
      res.on('data', (chunk) => {
        data += chunk
      })
      res.on('end', () => {
        if (/If you can see this, traffic is not passing through mitmproxy/.test(data)) {
          resolve(false)
        } else {
          resolve(true)
        }
      })
    })
  })
}

// 检查 mitmproxy 证书是否已经安装
export function checkCertificateExists(): Promise<boolean> {
  return new Promise((resolve) => {
    exec(
      `security find-certificate -a -c "mitmproxy" /Library/Keychains/System.keychain`,
      (error, stdout, stderr) => {
        resolve(!error && !stderr && !!stdout)
      }
    )
  })
}

// 打开指定目录
export function openDirectory(directory: string): Promise<string> {
  return shell.openPath(directory)
}

export interface ParsedCredential {
  nickname: string
  round_head_img: string
  biz: string
  uin: string
  key: string
  pass_ticket: string
  wap_sid2: string
  time: string
  valid: boolean
}
export interface Credential {
  biz: string
  url: string
  set_cookie: string
  timestamp: number
  nickname: string
  round_head_img: string
}

// 解析原始 credentials 数据
export function parseCredentialData(data: string): ParsedCredential[] {
  let result: ParsedCredential[] = []
  let list: Credential[] = []
  try {
    list = JSON.parse(data)
  } catch (e) {
    log('解析原始 Credentials 数据失败: ', e as Error)
    return result
  }

  for (const item of list.sort((a, b) => b.timestamp - a.timestamp)) {
    const searchParams = new URL(item.url).searchParams
    const __biz = searchParams.get('__biz')!
    const uin = searchParams.get('uin')!
    const key = searchParams.get('key')!
    const pass_ticket = searchParams.get('pass_ticket')!

    let wap_sid2: string | null = null
    const matchResult = item.set_cookie.match(/wap_sid2=(?<wap_sid2>.+?);/)
    if (matchResult && matchResult.groups && matchResult.groups.wap_sid2) {
      wap_sid2 = matchResult.groups.wap_sid2
    }
    // 验证完整性
    if (!__biz || !uin || !key || !pass_ticket || !wap_sid2) {
      continue
    }

    result.push({
      nickname: item.nickname,
      round_head_img: item.round_head_img
        ? 'https://thirsty-alligator-94.deno.dev?url=' + encodeURIComponent(item.round_head_img)
        : item.round_head_img,
      biz: __biz,
      uin: uin,
      key: key,
      pass_ticket: pass_ticket,
      wap_sid2: wap_sid2,
      time: dayjs(item.timestamp).format('YYYY-MM-DD HH:mm:ss'),
      valid: Date.now() < item.timestamp + 1000 * 60 * 25 // 25分钟有效时间
    })
  }

  return result
}

// 删除指定 biz 数据
export async function removeBizCredential(biz: string): Promise<boolean> {
  try {
    const data = await readFileContent(credentialJsonPath)

    let list: Credential[] = []
    try {
      list = JSON.parse(data)
    } catch (e) {
      log('解析原始 Credentials 数据失败: ', e as Error)
      return false
    }

    list = list.filter((item) => item.biz !== biz)
    await writeFileContent(credentialJsonPath, JSON.stringify(list))
    return true
  } catch (e) {
    return false
  }
}

// 读取文件内容
export function readFileContent(filepath: string): Promise<string> {
  return new Promise((resolve, reject) => {
    fs.readFile(filepath, 'utf8', (err, data) => {
      if (err) {
        log(`Error reading ${filepath}:`, err)
        reject(err)
        return
      }
      resolve(data)
    })
  })
}

// 写入文件内容
export function writeFileContent(filepath: string, content: string): Promise<void> {
  return new Promise((resolve, reject) => {
    fs.writeFile(filepath, content, 'utf-8', (err) => {
      if (err) {
        log(`Error writing ${filepath}:`, err)
        reject(err)
      }
      resolve()
    })
  })
}
