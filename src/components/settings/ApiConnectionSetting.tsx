import { useState, type CSSProperties } from 'react'
import { listModels } from '../../services/api/client.js'
import { setApiConnection, setSelectedModel, useSettings, type ApiProtocol } from '../../services/settings.js'

const fieldStyle: CSSProperties = {
  boxSizing: 'border-box',
  width: '100%',
  padding: '10px 12px',
  border: '1px solid var(--dsw-alias-border-l2)',
  borderRadius: 10,
  backgroundColor: 'transparent',
  color: 'inherit',
  font: 'inherit',
  fontSize: 14,
}
const buttonStyle: CSSProperties = {
  ...fieldStyle,
  width: 'auto',
  cursor: 'pointer',
  padding: '9px 14px',
}

export const ApiConnectionSetting = () => {
  const { apiBaseUrl, apiProtocol, selectedModel, apiKey, locale } = useSettings()
  const zh = locale === 'zh-CN'
  const [url, setUrl] = useState(apiBaseUrl)
  const [protocol, setProtocol] = useState<ApiProtocol>(apiProtocol)
  const [model, setModel] = useState(selectedModel)
  const [models, setModels] = useState<string[]>([])
  const [busy, setBusy] = useState(false)
  const [status, setStatus] = useState('')
  const [isError, setIsError] = useState(false)
  const notify = (value: string, error = false) => { setStatus(value); setIsError(error) }

  const saveConnection = () => {
    try {
      setApiConnection(url, protocol)
      notify(zh ? '地址已保存。切换服务商后请使用对应的 API Key，并选择模型。' : 'Endpoint saved. Use the matching API key and select a model.')
      return true
    } catch (error) {
      notify(error instanceof Error ? error.message : String(error), true)
      return false
    }
  }

  const loadModels = async () => {
    if (!saveConnection()) return
    if (!apiKey) {
      notify(zh ? '请先在上方保存 API Key。' : 'Save your API key above first.', true)
      return
    }
    setBusy(true)
    try {
      const found = await listModels(apiKey)
      setModels(found)
      notify(found.length
        ? (zh ? `已获取 ${found.length} 个模型，请选择后保存。` : `Found ${found.length} models. Choose one and save.`)
        : (zh ? '接口返回空列表，可以手动填写模型 ID。' : 'No models returned; enter an ID manually.'))
    } catch (error) {
      notify(error instanceof Error ? error.message : String(error), true)
    } finally {
      setBusy(false)
    }
  }

  const saveModel = () => {
    if (!model.trim()) {
      notify(zh ? '请先选择或输入模型 ID。' : 'Select or enter a model ID first.', true)
      return
    }
    if (!saveConnection()) return
    setSelectedModel(model)
    notify(zh ? `已保存模型：${model.trim()}` : `Saved model: ${model.trim()}`)
  }

  return (
    <div style={{display:'flex', flexDirection:'column', gap:10, padding:'18px 0', borderBottom:'1px solid var(--dsw-alias-border-l2)'}}>
      <strong>{zh ? 'API 连接与模型' : 'API Connection & Model'}</strong>
      <label htmlFor="api-protocol">{zh ? '协议' : 'Protocol'}</label>
      <select id="api-protocol" style={fieldStyle} value={protocol} onChange={event => {
        const next = event.target.value as ApiProtocol
        setProtocol(next)
        setUrl(next === 'deepseek' ? 'https://api.deepseek.com' : 'https://api.openai.com/v1')
        setModel(next === 'deepseek' ? 'deepseek-flash' : '')
        setModels([])
        setStatus('')
      }}>
        <option value="deepseek">{zh ? 'DeepSeek 原生（Files API）' : 'DeepSeek native (Files API)'}</option>
        <option value="openai">{zh ? 'OpenAI 兼容（文件自适应）' : 'OpenAI-compatible (adaptive files)'}</option>
      </select>
      <label htmlFor="api-base-url">{zh ? 'API 地址' : 'API Base URL'}</label>
      <input id="api-base-url" style={fieldStyle} type="url" value={url} placeholder="https://api.example.com/v1" autoCapitalize="none" spellCheck={false} onChange={event => setUrl(event.target.value)} />
      <small style={{opacity:0.7}}>
        {zh ? 'DeepSeek 模式填写服务根地址；OpenAI 兼容模式一般填写带 /v1 的地址。服务商必须允许浏览器跨域调用。' : 'DeepSeek mode uses the service root. OpenAI-compatible endpoints normally include /v1. The provider must allow browser CORS.'}
      </small>
      <div style={{display:'flex',gap:8,flexWrap:'wrap'}}>
        <button type="button" style={buttonStyle} disabled={busy} onClick={saveConnection}>{zh ? '保存地址' : 'Save endpoint'}</button>
        <button type="button" style={buttonStyle} disabled={busy} onClick={() => void loadModels()}>{busy ? (zh ? '拉取中…' : 'Loading…') : (zh ? '拉取模型' : 'Fetch models')}</button>
      </div>
      <label htmlFor="api-model-id">{zh ? '当前模型 ID' : 'Model ID'}</label>
      {models.length > 0 ? (
        <select aria-label={zh ? '从列表选择模型' : 'Choose a model'} style={fieldStyle}
          value={models.includes(model) ? model : ''}
          onChange={event => setModel(event.target.value)}
        >
          {!models.includes(model) ? <option value="">{zh ? '选择模型…' : 'Choose model…'}</option> : null}
          {models.map(id => <option key={id} value={id}>{id}</option>)}
        </select>
      ) : null}
      <input id="api-model-id" style={fieldStyle} value={model} placeholder={zh ? '也可以手动填写模型 ID' : 'Or enter model ID manually'}
        autoCapitalize="none" spellCheck={false} onChange={event => setModel(event.target.value)} />
      <button type="button" style={buttonStyle} onClick={saveModel}>{zh ? '保存模型' : 'Save model'}</button>
      {protocol === 'openai' ? <small style={{opacity:0.7}}>
        {zh ? '兼容模式支持按接口能力发送文本、图片、PDF 和其他文档；文件能否被解析取决于服务商及模型。联网工具、语音和专有深度思考参数暂不通用。' : 'Compatible mode adapts text, image, PDF and other files to provider endpoints. Processing depends on the API and model. Search, speech and provider-specific reasoning options are not portable.'}
      </small> : null}
      {status ? <small role="status" style={{color: isError ? 'var(--dsw-alias-state-error-primary)' : 'inherit'}}>{status}</small> : null}
    </div>
  )
}
