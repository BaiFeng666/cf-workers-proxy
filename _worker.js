function logError(request, message) {
  console.error(
    `${message}, clientIp: ${request.headers.get(
      "cf-connecting-ip"
    )}, user-agent: ${request.headers.get("user-agent")}, url: ${request.url}`
  );
}

/**
 * 判断是否为 GitHub API 路径
 * @param pathname 请求路径
 * @returns {boolean}
 */
function isGitHubAPIPath(pathname) {
  // GitHub API 的典型路径模式
  const apiPaths = [
    '/repos/',
    '/user',
    '/users/',
    '/orgs/',
    '/organizations/',
    '/gists/',
    '/search/',
    '/rate_limit',
    '/emojis',
    '/events',
    '/feeds',
    '/notifications',
    '/meta',
    '/octocat',
    '/zen',
    '/marketplace_listing/',
    '/installation/',
    '/app/',
    '/applications/',
  ];
  
  return apiPaths.some(path => pathname.startsWith(path));
}

/**
 * 获取 GitHub 代理目标主机
 * @param baseHostname 基础主机名（如 github.com）
 * @param pathname 请求路径
 * @returns {string}
 */
function getGitHubProxyHost(baseHostname, pathname) {
  // 如果配置的是 github.com，根据路径智能判断
  if (baseHostname === 'github.com' && isGitHubAPIPath(pathname)) {
    return 'api.github.com';
  }
  return baseHostname;
}

function createNewRequest(request, url, proxyHostname, originHostname) {
  const newRequestHeaders = new Headers(request.headers);
  for (const [key, value] of newRequestHeaders) {
    if (value.includes(originHostname)) {
      newRequestHeaders.set(
        key,
        value.replace(
          new RegExp(`(?<!\\.)\\b${originHostname}\\b`, "g"),
          proxyHostname
        )
      );
    }
  }
  
  // 为 GitHub API 添加必要的请求头
  if (proxyHostname === 'api.github.com') {
    // GitHub API 要求必须有 User-Agent
    if (!newRequestHeaders.has('user-agent')) {
      newRequestHeaders.set('user-agent', 'Cloudflare-Workers-Proxy');
    }
    // 设置 GitHub API 推荐的 Accept 头
    if (!newRequestHeaders.has('accept')) {
      newRequestHeaders.set('accept', 'application/vnd.github+json');
    }
  }
  
  return new Request(url.toString(), {
    method: request.method,
    headers: newRequestHeaders,
    body: request.body,
    redirect: 'follow'
  });
}

function setResponseHeaders(
  originalResponse,
  proxyHostname,
  originHostname,
  DEBUG
) {
  const newResponseHeaders = new Headers(originalResponse.headers);
  for (const [key, value] of newResponseHeaders) {
    if (value.includes(proxyHostname)) {
      newResponseHeaders.set(
        key,
        value.replace(
          new RegExp(`(?<!\\.)\\b${proxyHostname}\\b`, "g"),
          originHostname
        )
      );
    }
  }
  if (DEBUG) {
    newResponseHeaders.delete("content-security-policy");
  }
  return newResponseHeaders;
}

/**
 * 替换内容
 * @param originalResponse 响应
 * @param proxyHostname 代理地址 hostname
 * @param pathnameRegex 代理地址路径匹配的正则表达式
 * @param originHostname 替换的字符串
 * @param baseHostname 基础主机名（用于 GitHub 双域名替换）
 * @returns {Promise<*>}
 */
async function replaceResponseText(
  originalResponse,
  proxyHostname,
  pathnameRegex,
  originHostname,
  baseHostname = null
) {
  let text = await originalResponse.text();
  
  // 替换实际的代理主机名
  if (pathnameRegex) {
    pathnameRegex = pathnameRegex.replace(/^\^/, "");
    text = text.replace(
      new RegExp(`((?<!\\.)\\b${proxyHostname}\\b)(${pathnameRegex})`, "g"),
      `${originHostname}$2`
    );
  } else {
    text = text.replace(
      new RegExp(`(?<!\\.)\\b${proxyHostname}\\b`, "g"),
      originHostname
    );
  }
  
  // 如果是 GitHub 代理，还需要替换另一个域名
  if (baseHostname === 'github.com') {
    const otherHost = proxyHostname === 'api.github.com' ? 'github.com' : 'api.github.com';
    text = text.replace(
      new RegExp(`(?<!\\.)\\b${otherHost}\\b`, "g"),
      originHostname
    );
  }
  
  return text;
}

async function nginx() {
  return `<!DOCTYPE html>
<html>
<head>
<title>Welcome to nginx!</title>
<style>
html { color-scheme: light dark; }
body { width: 35em; margin: 0 auto;
font-family: Tahoma, Verdana, Arial, sans-serif; }
</style>
</head>
<body>
<h1>Welcome to nginx!</h1>
<p>If you see this page, the nginx web server is successfully installed and
working. Further configuration is required.</p>

<p>For online documentation and support please refer to
<a href="http://nginx.org/">nginx.org</a>.<br/>
Commercial support is available at
<a href="http://nginx.com/">nginx.com</a>.</p>

<p><em>Thank you for using nginx.</em></p>
</body>
</html>`;
}

export default {
  async fetch(request, env, ctx) {
    try {
      const {
        PROXY_HOSTNAME,
        PROXY_PROTOCOL = "https",
        PATHNAME_REGEX,
        UA_WHITELIST_REGEX,
        UA_BLACKLIST_REGEX,
        URL302,
        IP_WHITELIST_REGEX,
        IP_BLACKLIST_REGEX,
        REGION_WHITELIST_REGEX,
        REGION_BLACKLIST_REGEX,
        DEBUG = false,
      } = env;
      const url = new URL(request.url);
      const originHostname = url.hostname;
      if (
        !PROXY_HOSTNAME ||
        (PATHNAME_REGEX && !new RegExp(PATHNAME_REGEX).test(url.pathname)) ||
        (UA_WHITELIST_REGEX &&
          !new RegExp(UA_WHITELIST_REGEX).test(
            request.headers.get("user-agent").toLowerCase()
          )) ||
        (UA_BLACKLIST_REGEX &&
          new RegExp(UA_BLACKLIST_REGEX).test(
            request.headers.get("user-agent").toLowerCase()
          )) ||
        (IP_WHITELIST_REGEX &&
          !new RegExp(IP_WHITELIST_REGEX).test(
            request.headers.get("cf-connecting-ip")
          )) ||
        (IP_BLACKLIST_REGEX &&
          new RegExp(IP_BLACKLIST_REGEX).test(
            request.headers.get("cf-connecting-ip")
          )) ||
        (REGION_WHITELIST_REGEX &&
          !new RegExp(REGION_WHITELIST_REGEX).test(
            request.headers.get("cf-ipcountry")
          )) ||
        (REGION_BLACKLIST_REGEX &&
          new RegExp(REGION_BLACKLIST_REGEX).test(
            request.headers.get("cf-ipcountry")
          ))
      ) {
        logError(request, "Invalid");
        return URL302
          ? Response.redirect(URL302, 302)
          : new Response(await nginx(), {
              headers: {
                "Content-Type": "text/html; charset=utf-8",
              },
            });
      }
      // 智能判断 GitHub 代理目标主机
      const actualProxyHost = getGitHubProxyHost(PROXY_HOSTNAME, url.pathname);
      
      url.host = actualProxyHost;
      url.protocol = PROXY_PROTOCOL;
      const newRequest = createNewRequest(
        request,
        url,
        actualProxyHost,
        originHostname
      );
      const originalResponse = await fetch(newRequest);
      const newResponseHeaders = setResponseHeaders(
        originalResponse,
        actualProxyHost,
        originHostname,
        DEBUG
      );
      const contentType = newResponseHeaders.get("content-type") || "";
      let body;
      // 处理文本类型和 JSON 类型的响应（GitHub API 返回 JSON）
      if (contentType.includes("text/") || contentType.includes("application/json")) {
        body = await replaceResponseText(
          originalResponse,
          actualProxyHost,
          PATHNAME_REGEX,
          originHostname,
          PROXY_HOSTNAME
        );
      } else {
        body = originalResponse.body;
      }
      return new Response(body, {
        status: originalResponse.status,
        headers: newResponseHeaders,
      });
    } catch (error) {
      logError(request, `Fetch error: ${error.message}`);
      return new Response("Internal Server Error", { status: 500 });
    }
  },
};
