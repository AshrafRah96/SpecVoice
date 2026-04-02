/**
 * Verifies ElevenLabs agent WebSocket audio delivery.
 * Connects with silent PCM input and checks whether audio frames arrive back.
 * Usage: npx tsx src/scripts/test-audio.ts
 */
import { WebSocket } from 'ws'

const AGENT_ID = process.env.ELEVENLABS_AGENT_ID
if (!AGENT_ID) {
  console.error('ELEVENLABS_AGENT_ID not set')
  process.exit(1)
}

const ws = new WebSocket(
  `wss://api.elevenlabs.io/v1/convai/conversation?agent_id=${AGENT_ID}`
)

let audioFrames = 0
const jsonMessages: string[] = []
let initReceived = false
let timer: ReturnType<typeof setTimeout> | undefined
let audioInterval: ReturnType<typeof setInterval> | undefined

function sendSilentPCMAsBase64() {
  const chunk = Buffer.alloc(3200, 0) // 100ms @ 16kHz 16-bit silent PCM
  audioInterval = setInterval(() => {
    if (ws.readyState === ws.OPEN) {
      ws.send(JSON.stringify({ user_audio_chunk: chunk.toString('base64') }))
    } else {
      clearInterval(audioInterval)
    }
  }, 100)
}

ws.on('open', () => {
  console.log('[WS] opened')
  ws.send(JSON.stringify({
    type: 'conversation_initiation_client_data',
    dynamic_variables: { session_id: 'test-123' },
    conversation_config_override: { conversation: { text_only: false } },
  }))
})

ws.on('message', (data: Buffer, isBinary: boolean) => {
  if (isBinary) {
    audioFrames++
    if (audioFrames === 1) console.log('[AUDIO] binary audio frame received!')
    return
  }

  try {
    const msg = JSON.parse(data.toString()) as { type: string; [k: string]: unknown }
    console.log(`[MSG] type=${msg.type}${msg.type === 'audio' ? ' (audio!)' : ''}`)
    if (msg.type === 'audio') audioFrames++
    jsonMessages.push(msg.type)

    if (msg.type === 'conversation_initiation_metadata' && !initReceived) {
      initReceived = true
      const meta = msg.conversation_initiation_metadata_event as { agent_output_audio_format?: string } | undefined
      console.log(`[INIT] agent_output_audio_format=${JSON.stringify(meta?.agent_output_audio_format)}`)
      sendSilentPCMAsBase64()
      timer = setTimeout(() => {
        clearInterval(audioInterval)
        console.log(`\n=== RESULT: ${audioFrames} audio frames | msgs: ${jsonMessages.join(', ')} ===`)
        ws.close()
      }, 10000)
    }

    if (msg.type === 'agent_response') {
      const ev = msg.agent_response_event as { agent_response?: string } | undefined
      console.log(`[AGENT] "${ev?.agent_response?.slice(0, 80)}"`)
    }
  } catch {
    console.log('[RAW]', data.toString().slice(0, 100))
  }
})

ws.on('error', (e: Error) => console.error('[ERR]', e.message))
ws.on('close', (code: number, reason: Buffer) => {
  clearTimeout(timer)
  clearInterval(audioInterval)
  console.log(`[CLOSE] code=${code} reason=${reason}`)
  console.log(`=== FINAL: ${audioFrames} audio frames | msgs: ${jsonMessages.join(', ')} ===`)
})

setTimeout(() => { if (ws.readyState !== ws.CLOSED) ws.close() }, 25000)
