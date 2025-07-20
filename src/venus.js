const express = require('express');
const axios = require('axios');
const cors = require('cors');
const helmet = require('helmet');
const dotenv = require('dotenv');
const morgan = require('morgan');
const winston = require('winston');
const { v4: uuidv4 } = require('uuid');

dotenv.config();

const app = express();

// 配置参数
// 读取配置文件.config-venus.js
const config = require('../config-venus.js');
const {
  targetApiBaseUrl,
  targetApiKeyPrefix,
  apiKeyPrefix,
  port,
  host,
  token,
  enableStream,
  chatCompletionsPath,
  modelsPath,
  workspaceId,
  modelName
} = config;

// 日志配置
const logger = winston.createLogger({
  level: 'info',
  format: winston.format.combine(
    winston.format.timestamp(),
    winston.format.json()
  ),
  transports: [
    new winston.transports.Console(),
    new winston.transports.File({ filename: 'venus.log' })
  ]
});

// 安全中间件
app.use(helmet());
app.use(cors());
// 设置请求体大小限制，支持大文件上传
app.use(express.json({ limit: '50mb' }));
// app.use(express.urlencoded({ limit: '50mb', extended: true }));

// 请求日志中间件
app.use(morgan(':method :url :status :res[content-length] - :response-time ms', {
  stream: {
    write: message => logger.info(message.trim())
  }
}));

// 创建axios实例，用于复用连接
const httpClient = axios.create({
  timeout: 60000,
  maxRedirects: 5
});

// 辅助函数：处理认证头
function processAuthHeader (authHeader) {
  let apiKey = authHeader || '';

  if (apiKey.startsWith(apiKeyPrefix)) {
    apiKey = apiKey.substring(apiKeyPrefix.length);
  }
  return `${targetApiKeyPrefix}${token}`;
}

// 辅助函数：构建请求头
function buildHeaders (authHeader, contentType = 'application/json') {
  let headers = { Authorization: processAuthHeader(authHeader), 'Content-Type': contentType };
  if (workspaceId) {
    headers = { ...headers, Wsid: workspaceId };
  }
  return headers;
}

// 辅助函数：处理非流式响应
async function handleNonStreaming (targetUrl, headers, body) {
  try {
    const response = await httpClient.post(targetUrl, body, {
      headers,
      timeout: 60000
    });
    return {
      data: response.data,
      status: response.status,
      headers: { 'Content-Type': 'application/json' }
    };
  } catch (error) {
    throw new Error(`Error forwarding request: ${error}`);
  }
}

// 辅助函数：处理流式响应
async function handleStreaming (targetUrl, headers, body, res) {
  try {
    // 确保stream参数为true
    body.stream = true;

    const response = await httpClient.post(targetUrl, body, {
      headers,
      responseType: 'stream',
      timeout: 0 // 流式请求不设置超时
    });

    if (response.status !== 200) {
      res.status(response.status);
      res.write(`data: ${JSON.stringify({ error: { message: `Error from target API: ${response.statusText}` } })}\n\n`);
      res.end();
      return;
    }

    // 设置SSE响应头
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive'
    });

    // 转发流式数据
    response.data.on('data', (chunk) => {
      res.write(chunk);
    });

    response.data.on('end', () => {
      res.end();
    });

    response.data.on('error', (error) => {
      res.write(`data: ${JSON.stringify({ error: { message: `Streaming error: ${error.message}` } })}\n\n`);
      res.write('data: [DONE]\n\n');
      res.end();
    });
  } catch (error) {
    res.status(500);
    res.write(`data: ${JSON.stringify({ error: { message: `Streaming error: ${error.message}` } })}\n\n`);
    res.write('data: [DONE]\n\n');
    res.end();
  }
}

// POST /v1/chat/completions
app.post(`/v1/${chatCompletionsPath}`, async (req, res) => {
  console.log(`----------------开始处理/请求 ${chatCompletionsPath}------------`);
  try {
    const body = req.body;

    // 检查是否缺失query_id
    if (!body.query_id) {
      body.query_id = `query_${uuidv4()}`;
    }

    // 检查是否只有一条消息
    if (body.messages && body.messages.length === 1) {
      body.messages = [{ content: '', role: 'system' }, ...body.messages];
    }

    if (!body.model) {
      body.model = modelName;
    }
    if (!body.stream) {
      body.stream = enableStream;
    }

    const authHeader = req.headers.authorization || '';
    const headers = buildHeaders(authHeader);
    const stream = body.stream;
    const targetUrl = `${targetApiBaseUrl}/${chatCompletionsPath}`;

    console.log(`Forwarding request to target API: ${targetUrl}`, headers, body);

    if (stream) {
      // 流式处理
      console.log('==================进入流式处理==================');
      await handleStreaming(targetUrl, headers, body, res);
    } else {
      // 非流式处理
      console.log('==================进入非流式处理==================');
      const result = await handleNonStreaming(targetUrl, headers, body);
      console.log(`Response from target API: ${JSON.stringify(result.data)}`);
      res.status(result.status).set(result.headers).json(result.data);
    }
  } catch (error) {
    logger.error(`Error in /${chatCompletionsPath}:`, error);
    res.status(500).json({
      error: {
        message: error.message,
        type: 'server_error'
      }
    });
  }
});

// POST /v1/completions
app.post('/v1/completions', async (req, res) => {
  console.log('----------------开始处理/v1/completions请求------------');
  try {
    const body = req.body;
    const authHeader = req.headers.authorization || '';
    const headers = buildHeaders(authHeader);
    const stream = body.stream || false;
    const targetUrl = `${targetApiBaseUrl}/v1/completions`;

    if (stream) {
      // 流式处理
      await handleStreaming(targetUrl, headers, body, res);
    } else {
      // 非流式处理
      const result = await handleNonStreaming(targetUrl, headers, body);
      res.status(result.status).set(result.headers).json(result.data);
    }
  } catch (error) {
    logger.error('Error in /v1/completions:', error);
    res.status(500).json({
      error: {
        message: error.message,
        type: 'server_error'
      }
    });
  }
});

// GET /v1/models
app.get(`/v1/${modelsPath}`, async (req, res) => {
  console.log('----------------开始处理/v1/models请求------------');
  try {
    const authHeader = req.headers.authorization || '';
    const headers = buildHeaders(authHeader);
    delete headers['Content-Type']; // GET请求不需要Content-Type

    const targetUrl = `${targetApiBaseUrl}/v1/models`;

    const response = await httpClient.get(targetUrl, {
      headers
    });

    res.status(response.status).set({ 'Content-Type': 'application/json' }).json(response.data);
  } catch (error) {
    logger.error('Error in /v1/models:', error);
    res.status(500).json({
      error: {
        message: `Error forwarding request: ${error.message}`,
        type: 'server_error'
      }
    });
  }
});

// 通用路由，用于处理未专门实现的其他端点
app.all('*', async (req, res) => {
  console.log('----------------开始处理通用路由请求------------');
  try {
    const path = req.path.startsWith('/') ? req.path.substring(1) : req.path;
    const authHeader = req.headers.authorization || '';

    // 构建新的请求头，保留原始请求的其他头
    const headers = { ...req.headers };
    headers.authorization = processAuthHeader(authHeader);
    if (workspaceId) {
      headers.wsid = workspaceId;
    }

    // 移除host头，因为它会被axios自动设置
    delete headers.host;

    const targetUrl = `${targetApiBaseUrl}/${path}`;

    // 获取请求体
    let data = null;
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      data = req.body;
    }

    console.log(`Forwarding request to: ${targetUrl}`, req.method, headers, data, req.query);
    const response = await httpClient.request({
      method: req.method,
      url: targetUrl,
      headers,
      data,
      params: req.query
    });

    // 返回目标API的响应
    res.status(response.status).set(response.headers).send(response.data);
  } catch (error) {
    logger.error('Error in catch-all route:', error);
    res.status(500).json({
      error: {
        message: `Error forwarding request: ${error.message}`,
        type: 'server_error'
      }
    });
  }
});

// 启动服务器
app.listen(port, host, () => {
  console.log(`Starting OpenAI API proxy server at http://${host}:${port}`);
  console.log(`Forwarding requests to ${targetApiBaseUrl}`);
  workspaceId && console.log(`Using WorkSpaceID: ${workspaceId}`);

  logger.info(`Server running on ${host}:${port}`);
  console.log(`
  ╔══════════════════════════════════════════════════════════╗
  ║                                                          ║
  ║   OpenAI API Proxy Service (Node.js)                    ║
  ║   Listening on: ${host}:${port}                          ║
  ║   Target API: ${targetApiBaseUrl}                     ║
  ║                                                          ║
  ║   Endpoints:                                             ║
  ║   POST /v1/chat/completions  - Chat completions          ║
  ║   POST /v1/completions       - Text completions          ║
  ║   GET  /v1/models            - List available models     ║
  ║   ALL  /*                    - Catch-all proxy           ║
  ║                                                          ║
  ╚══════════════════════════════════════════════════════════╝
  `);
});

// 优雅关闭
process.on('SIGTERM', () => {
  console.log('SIGTERM received, shutting down gracefully');
  process.exit(0);
});

process.on('SIGINT', () => {
  console.log('SIGINT received, shutting down gracefully');
  process.exit(0);
});
