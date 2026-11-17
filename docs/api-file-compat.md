# 自定义 API 文件适配（测试分支）

原有 DeepSeek 模式保持不变：上传文件使用 `/anthropic/v1/files`，请求中使用 DeepSeek `file_id`。

OpenAI 兼容模式 **不会因为不是 DeepSeek 而禁止选择附件**。附件原件先写入当前浏览器的 IndexedDB，随后随每次对话请求转换为服务商支持的输入格式：

| 本地文件 | 优先发送方式 | 自动回退 |
| --- | --- | --- |
| TXT、Markdown、JSON、CSV、代码等文本 | 作为有文件边界标记的文本拼入 Chat Completions | 服务商明确拒绝相应端点/格式时尝试 Responses |
| JPG、PNG、WebP 等图片 | Chat Completions 的 `image_url`（base64 data URL） | Responses 的 `input_image` |
| PDF | Chat Completions 的 `file.file_data`（base64 data URL） | Responses 的 `input_file` |
| DOCX、PPTX、XLSX 等其他文件 | Responses 的 `input_file` | 如果 Responses 不可用，再尝试 Chat Completions 文件内容块（取决于厂商扩展实现） |

## 注意

- **这不是承诺所有第三方都支持任意文件**。Chat Completions 和 Responses 的文件协议不同，部分中转服务仅支持文字或部分多模态功能。模型是否能够真正读取文档由服务商决定。
- 回退只在 HTTP 明确不支持端点/格式时进行，且在收到任何生成内容前进行，以避免自动重复生成付费。
- 若两种模式都不支持，显示实际 API 错误而不是伪装成成功。
- 大文件采用 base64 内联传输时可能超过提供商 HTTP 请求大小或模型上下文限制；文本文件会直接消耗输入 Token。
- 第三方模式不把 DeepSeek 的 `file_id` 复用于其他服务商；若本地原件缺失，会要求重新上传。
- 原件保存在浏览器 IndexedDB；更换浏览器、清理站点数据或从不含原件的历史备份导入时，不能保证重新发送旧附件。
- 浏览器直接请求自定义 API，需要目标服务开启 CORS。不要把 API Key 硬编码到仓库。
- 第三方联网工具与语音功能仍未适配，相关按钮依然禁用。

## 验证建议

1. 先用 TXT/JSON 测试文件内容能被准确复述。
2. 测试图片识别与 PDF 摘要，再用 DOCX 或 XLSX 测试 Responses 文件输入。
3. 切回 DeepSeek 模式，在新对话里测试原有 Files API 是否仍然可用。
4. 观察开发者工具 Network 中发送到 `/chat/completions` 或 `/responses` 的请求与服务端实际错误；**不要分享含密钥的请求头**。

这是面向通用 OpenAI 兼容提供商的尽力适配，不能把某个模型的能力（上下文、图片、文档解析）自动扩展给其他模型。
