<script context="module" lang="ts">
    import { EventStreamContentType, fetchEventSource } from '@microsoft/fetch-event-source'
    import { ChatCompletionResponse } from '../../ChatCompletionResponse.svelte'
    import { ChatRequest } from '../../ChatRequest.svelte'
    import { getImage } from '../../ImageStore.svelte'
    import { getEndpoint, getModelDetail } from '../../Models.svelte'
    import { getApiKey } from '../../Storage.svelte'
    import type { ChatCompletionOpts, Request } from '../../Types.svelte'

const isResponsesEndpoint = (endpoint: string): boolean => {
  // Typical values:
  // - https://api.openai.com/v1/chat/completions
  // - https://api.openai.com/v1/responses
  try {
    const url = new URL(endpoint, window.location.origin)
    return url.pathname.endsWith('/v1/responses') || url.pathname.endsWith('/responses')
  } catch {
    return endpoint.includes('/v1/responses') || endpoint.endsWith('/responses')
  }
}

type ResponsesUsage = {
  input_tokens?: number;
  output_tokens?: number;
  total_tokens?: number;
}

type ChatCompletionsUsage = {
  prompt_tokens: number;
  completion_tokens: number;
  total_tokens: number;
}

const toChatCompletionsUsage = (usage?: ResponsesUsage): ChatCompletionsUsage|undefined => {
  if (!usage) return undefined
  const promptTokens = usage.input_tokens ?? 0
  const completionTokens = usage.output_tokens ?? 0
  const totalTokens = usage.total_tokens ?? (promptTokens + completionTokens)
  return { prompt_tokens: promptTokens, completion_tokens: completionTokens, total_tokens: totalTokens }
}

const extractResponsesOutputText = (responses: any): string => {
  const output = responses?.output
  if (!Array.isArray(output)) return ''

  const textChunks: string[] = []
  for (const item of output) {
    // Prefer assistant message output text
    if (item?.type !== 'message') continue
    const content = item?.content
    if (!Array.isArray(content)) continue
    for (const part of content) {
      if (part?.type === 'output_text' && typeof part?.text === 'string') textChunks.push(part.text)
    }
  }
  return textChunks.join('')
}

const toChatCompletionsSyncResponse = (responses: any, fallbackModel: string): any => {
  const content = extractResponsesOutputText(responses)
  return {
    model: responses?.model || fallbackModel,
    choices: [
      {
        index: 0,
        finish_reason: 'stop',
        message: { role: 'assistant', content }
      }
    ],
    usage: toChatCompletionsUsage(responses?.usage as ResponsesUsage)
  }
}

export const chatRequest = async (
  request: Request,
  chatRequest: ChatRequest,
  chatResponse: ChatCompletionResponse,
  opts: ChatCompletionOpts): Promise<ChatCompletionResponse> => {
    // OpenAI Request (Chat Completions + Responses)
      const model = await chatRequest.getModel()
      const endpoint = getEndpoint(model)
      const signal = chatRequest.controller.signal
      const abortListener = (e:Event) => {
        chatRequest.updating = false
        chatRequest.updatingMessage = ''
        chatResponse.updateFromError('User aborted request.')
        signal.removeEventListener('abort', abortListener)
      }
      signal.addEventListener('abort', abortListener)
      const fetchOptions = {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${getApiKey()}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify(request),
        signal
      }

      // OpenAI "Responses" API support: if the endpoint is /v1/responses, we must transform the payload
      // and parse a different streaming shape.
      if (isResponsesEndpoint(endpoint)) {
        const responsesBody: any = {
          model: request.model,
          // OpenAI Responses API format (content parts)
          input: await Promise.all((request.messages || []).map(async (m: any) => {
            const parts: any[] = []
            // Responses API expects assistant-history content parts to use output types.
            // Using `input_text` for assistant messages triggers:
            // "Invalid value: 'input_text'. Supported values are: 'output_text' and 'refusal'."
            const role = m?.role
            const textPartType = role === 'assistant' ? 'output_text' : 'input_text'
            if (m?.content) parts.push({ type: textPartType, text: m.content })
            if (m?.image?.id) {
              const stored = await getImage(m.image.id)
              const mime = stored?.mime || m?.image?.mime || 'image/png'
              const url = `data:${mime};base64,${stored?.b64image || ''}`
              parts.push({ type: 'input_image', image_url: url })
            }
            return { role, content: parts }
          })),
          stream: !!request.stream
        }

        // Best-effort mapping of commonly used parameters
        const reqAny: any = request
        if (typeof reqAny.temperature === 'number') responsesBody.temperature = reqAny.temperature
        if (typeof reqAny.top_p === 'number') responsesBody.top_p = reqAny.top_p
        if (typeof reqAny.presence_penalty === 'number') responsesBody.presence_penalty = reqAny.presence_penalty
        if (typeof reqAny.frequency_penalty === 'number') responsesBody.frequency_penalty = reqAny.frequency_penalty
        if (typeof reqAny.max_completion_tokens === 'number') responsesBody.max_output_tokens = reqAny.max_completion_tokens
        if (reqAny.stop != null) responsesBody.stop = reqAny.stop

        const responsesFetchOptions = {
          ...fetchOptions,
          body: JSON.stringify(responsesBody)
        }

        // Some OpenAI-compatible "Responses" endpoints always return SSE (text/event-stream),
        // even when `stream` is false. To stay compatible, always parse as SSE.
        {
          let sentRole = false
          const pushDelta = (deltaText: string) => {
            const delta: any = { content: deltaText }
            if (!sentRole) {
              delta.role = 'assistant'
              sentRole = true
            }
            chatResponse.updateFromAsyncResponse({
              model: request.model,
              choices: [{ index: 0, delta }]
            } as any)
          }

          const pushFinish = (finishReason: string = 'stop') => {
            chatResponse.updateFromAsyncResponse({
              model: request.model,
              choices: [{ index: 0, delta: {}, finish_reason: finishReason }]
            } as any)
          }

          fetchEventSource(endpoint, {
            ...responsesFetchOptions,
            openWhenHidden: true,
            onmessage (ev) {
              chatRequest.updating = 1
              chatRequest.updatingMessage = ''

              if (chatResponse.hasFinished()) return
              if (ev.data === '[DONE]') return pushFinish('stop')

              let data: any
              try {
                data = JSON.parse(ev.data)
              } catch {
                return
              }

              // Error frames (best-effort)
              if (data?.error?.message) return chatResponse.updateFromError(data.error.message)

              if (data?.type === 'response.output_text.delta' && typeof data?.delta === 'string') {
                return pushDelta(data.delta)
              }

              // Some servers may send a terminal frame
              if (data?.type === 'response.completed') return pushFinish('stop')
            },
            onclose () {
              chatResponse.updateFromClose()
            },
            onerror (err) {
              console.error(err)
              throw err
            },
            async onopen (response) {
              if (response.ok && response.headers.get('content-type').startsWith(EventStreamContentType)) {
                // ok
              } else {
                await chatRequest.handleError(response)
              }
            }
          }).catch(err => {
            chatResponse.updateFromError(err.message)
          })

          return chatResponse
        }
      }

      if (opts.streaming) {
      /**
             * Streaming request/response
             * We'll get the response a token at a time, as soon as they are ready
            */
        chatResponse.onFinish(() => {
          // chatRequest.updating = false
          // chatRequest.updatingMessage = ''
        })
        fetchEventSource(getEndpoint(model), {
          ...fetchOptions,
          openWhenHidden: true,
          onmessage (ev) {
          // Remove updating indicator
            chatRequest.updating = 1 // hide indicator, but still signal we're updating
            chatRequest.updatingMessage = ''
            // console.log('ev.data', ev.data)
            if (!chatResponse.hasFinished()) {
              if (ev.data === '[DONE]') {
              // ?? anything to do when "[DONE]"?
              } else {
                const data = JSON.parse(ev.data)
                // console.log('data', data)
                window.setTimeout(() => { chatResponse.updateFromAsyncResponse(data) }, 1)
              }
            }
          },
          onclose () {
            chatResponse.updateFromClose()
          },
          onerror (err) {
            console.error(err)
            throw err
          },
          async onopen (response) {
            if (response.ok && response.headers.get('content-type').startsWith(EventStreamContentType)) {
            // everything's good
            } else {
            // client-side errors are usually non-retriable:
              await chatRequest.handleError(response)
            }
          }
        }).catch(err => {
          chatResponse.updateFromError(err.message)
        })
      } else {
      /**
             * Non-streaming request/response
             * We'll get the response all at once, after a long delay
             */
        const response = await fetch(getEndpoint(model), fetchOptions)
        if (!response.ok) {
          await chatRequest.handleError(response)
        } else {
          const json = await response.json()
          chatResponse.updateFromSyncResponse(json)
        }
      }
      return chatResponse
}

type ResponseImageDetail = {
    url: string;
    b64_json: string;
  }

type RequestImageGeneration = {
    prompt: string;
    n?: number;
    size?: string;
    response_format?: keyof ResponseImageDetail;
    model?: string;
    quality?: string;
    style?: string;
  }

export const imageRequest = async (
  na: Request,
  chatRequest: ChatRequest,
  chatResponse: ChatCompletionResponse,
  opts: ChatCompletionOpts): Promise<ChatCompletionResponse> => {
  const chat = chatRequest.getChat()
  const chatSettings = chat.settings
  const count = opts.count || 1
  const prompt = opts.prompt || ''
  chatRequest.updating = true
  chatRequest.updatingMessage = 'Generating Image...'
  const imageModel = chatSettings.imageGenerationModel
  const imageModelDetail = getModelDetail(imageModel)
  const size = imageModelDetail.opt?.size || '256x256'
  const model = imageModelDetail.opt?.model
  const style = imageModelDetail.opt?.style
  const quality = imageModelDetail.opt?.quality
  const request: RequestImageGeneration = {
        prompt,
        response_format: 'b64_json',
        size,
        n: count,
        ...(model ? { model } : {}),
        ...(style ? { style } : {}),
        ...(quality ? { quality } : {})
  }
  // fetchEventSource doesn't seem to throw on abort,
  // so we deal with it ourselves
  const signal = chatRequest.controller.signal
  const abortListener = (e:Event) => {
        chatResponse.updateFromError('User aborted request.')
        signal.removeEventListener('abort', abortListener)
  }
  signal.addEventListener('abort', abortListener)
  // Create request
  const fetchOptions = {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${getApiKey()}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify(request),
        signal
  }

  try {
        const response = await fetch(getEndpoint(imageModel), fetchOptions)
        if (!response.ok) {
          await chatRequest.handleError(response)
        } else {
          const json = await response.json()
          // console.log('image json', json, json?.data[0])
          const images = json?.data.map(d => d.b64_json)
          chatResponse.updateImageFromSyncResponse(images, prompt, imageModel)
        }
  } catch (e) {
        chatResponse.updateFromError(e)
        throw e
  }
  return chatResponse
}

</script>
