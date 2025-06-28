# DeepSeek Proxy 项目架构说明

## 1. 项目概述
该项目是一个基于Node.js的API代理服务，作为DeepSeek API的OpenAI兼容代理（"deepseek-proxy"）。主要功能是将OpenAI格式的API请求转换为DeepSeek API格式，并提供安全、日志和流式响应支持。

## 2. 架构图
```mermaid
graph TD
    A[客户端] --> B(Express服务器)
    B --> C{路由分发}
    C --> D[POST /v1/chat/completions]
    C --> E[POST /v1/completions]
    C --> F[GET /v1/models]
    C --> G[通配路由]
    
    D --> H{流式请求?}
    H -->|是| I[流式处理]
    H -->|否| J[非流式处理]
    
    E --> K{流式请求?}
    K -->|是| I
    K -->|否| J
    
    I --> L[DeepSeek API]
    J --> L
    
    F --> L
    G --> L
    
    subgraph 安全层
        M[Helmet]
        N[CORS]
        O[请求限流]
        P[UUID认证]
    end
    
    subgraph 工具层
        Q[Winston日志]
        R[Morgan请求日志]
        S[Axios HTTP客户端]
    end
    
    B --> 安全层
    B --> 工具层
```

## 3. 架构说明
1. **入口层**：Express服务器监听端口，处理所有传入请求
2. **路由层**：将请求分发到特定端点处理器
3. **业务逻辑层**：
   - 专门端点处理OpenAI兼容API
   - 流式/非流式响应处理
   - 请求预处理（添加query_id等）
4. **代理层**：通过Axios将请求转发到DeepSeek API
5. **安全层**：多层安全防护机制
6. **工具层**：日志记录和HTTP客户端

## 4. 关键设计特点
- **流式响应处理**：支持Server-Sent Events(SSE)
- **认证转换**：自动转换API密钥格式
- **错误处理**：统一错误日志和响应格式
- **配置驱动**：通过环境变量控制服务行为
- **模块化设计**：核心功能封装为独立函数