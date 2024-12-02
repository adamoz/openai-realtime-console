import { WebSocketServer } from 'ws';
import { RealtimeClient } from '@openai/realtime-api-beta';
import fs from 'fs';
import path from 'path';
import { v4 as uuidv4 } from 'uuid';

/**
 * Encode raw PCM data into a WAV file
 * @param {Buffer[]} audioChunks - Array of PCM audio chunks
 * @param {number} sampleRate - Sampling rate of the audio
 * @returns {Buffer} - Encoded WAV file as a buffer
 */
const encodeWavFile = (audioChunks, sampleRate) => {
  const combinedBuffer = Buffer.concat(audioChunks);
  const numChannels = 1; // Mono audio
  const bytesPerSample = 2; // 16-bit PCM
  const byteRate = sampleRate * numChannels * bytesPerSample;
  const blockAlign = numChannels * bytesPerSample;
  const header = Buffer.alloc(44);

  // RIFF chunk descriptor
  header.write('RIFF', 0); // ChunkID
  header.writeUInt32LE(36 + combinedBuffer.length, 4); // ChunkSize
  header.write('WAVE', 8); // Format

  // fmt sub-chunk
  header.write('fmt ', 12); // Subchunk1ID
  header.writeUInt32LE(16, 16); // Subchunk1Size (16 for PCM)
  header.writeUInt16LE(1, 20); // AudioFormat (1 for PCM)
  header.writeUInt16LE(numChannels, 22); // NumChannels
  header.writeUInt32LE(sampleRate, 24); // SampleRate
  header.writeUInt32LE(byteRate, 28); // ByteRate
  header.writeUInt16LE(blockAlign, 32); // BlockAlign
  header.writeUInt16LE(bytesPerSample * 8, 34); // BitsPerSample

  // data sub-chunk
  header.write('data', 36); // Subchunk2ID
  header.writeUInt32LE(combinedBuffer.length, 40); // Subchunk2Size

  // Combine header and PCM data
  return Buffer.concat([header, combinedBuffer]);
};


// Directory to save audio files
const AUDIO_DIR = path.join('/home/adam/Downloads', 'audio_chunks');
if (!fs.existsSync(AUDIO_DIR)) fs.mkdirSync(AUDIO_DIR);


export class RealtimeRelay {
  constructor(apiKey) {
    this.apiKey = apiKey;
    this.sockets = new WeakMap();
    this.wss = null;
    this.audioBuffers = new Map();
    this.fileCounter = 0;
  }

  listen(port) {
    this.wss = new WebSocketServer({ port });
    this.wss.on('connection', this.connectionHandler.bind(this));
    this.log(`Listening on ws://localhost:${port}`);
  }

  async connectionHandler(ws, req) {
    if (!req.url) {
      this.log('No URL provided, closing connection.');
      ws.close();
      return;
    }

    const url = new URL(req.url, `http://${req.headers.host}`);
    const pathname = url.pathname;

    if (pathname !== '/') {
      this.log(`Invalid pathname: "${pathname}"`);
      ws.close();
      return;
    }

    // Instantiate new client
    this.log(`Connecting with key "${this.apiKey.slice(0, 3)}..."`);
    const client = new RealtimeClient({ apiKey: this.apiKey });
    const sessionId = uuidv4(); // Unique session ID for this connection
    this.audioBuffers.set(sessionId, []); // Initialize audio buffer for the session


    // Relay: OpenAI Realtime API Event -> Browser Event
    client.realtime.on('server.*', (event) => {
      //this.log(`Relaying "${event.type}" to Client`);
      if(event.type === 'response.audio_transcript.done'){
        this.fileCounter += 1;
        // Generate a unique filename with the incremental counter
        const textFilename = `${sessionId}_${this.fileCounter}_text.json`;
        // Generate a unique filename for the audio file
        const filePath = path.join(AUDIO_DIR, textFilename);
        fs.writeFileSync(filePath, JSON.stringify(event, null, 2));
      }
      ws.send(JSON.stringify(event));
      //this.log(event);
    });
    client.realtime.on('close', () => ws.close());

    // Relay: Browser Event -> OpenAI Realtime API Event
    // We need to queue data waiting for the OpenAI connection
    const messageQueue = [];
    const messageHandler = (data) => {
      try {
        const event = JSON.parse(data);
        /*
         * Saving audio from browser
         * ******************************************************
         */
        if (event.type === 'input_audio_buffer.append') {
          // Decode the base64-encoded audio chunk
          const buffer = Buffer.from(event.audio, 'base64');

          // Append to the session's buffer array
          if (!this.audioBuffers.has(sessionId)) {
            this.audioBuffers.set(sessionId, []);
          }
          this.audioBuffers.get(sessionId).push(buffer);

          console.log(`[Session ${sessionId}] Appended audio chunk of size ${buffer.length}`);
        } else if (event.type === 'input_audio_buffer.commit') {
          // Concatenate all chunks into a single buffer
          const chunks = this.audioBuffers.get(sessionId) || [];
          this.log(`[Session ${sessionId}] Composing audio from ${chunks.length} chunks`);
          if (chunks.length === 0) {
            console.error(`[Session ${sessionId}] No audio chunks available to compose`);
            return;
          }
          
          const combinedBuffer = encodeWavFile(chunks, 24000); // Use 24kHz as the sample rate (match client's rate)
          this.fileCounter += 1;

          // Generate a unique filename with the incremental counter
          const audioFilename = `${sessionId}_${this.fileCounter}_audio.wav`;
          
          // Generate a unique filename for the audio file
          const filePath = path.join(AUDIO_DIR, audioFilename);

          // Write the combined buffer to a file
          fs.writeFileSync(filePath, combinedBuffer);
          console.log(`[Session ${sessionId}] Composed audio saved to ${filePath}`);

          // Clear the buffer for the session
          this.audioBuffers.delete(sessionId);
        }
        /*
         * *******************************************************
         */

        //this.log(`Relaying "${event.type}" to OpenAI`);
        client.realtime.send(event.type, event);
        //this.log(event);
      } catch (e) {
        console.error(e.message);
        this.log(`Error parsing event from client: ${data}`);
      }
    };
    ws.on('message', (data) => {
      if (!client.isConnected()) {
        messageQueue.push(data);
      } else {
        messageHandler(data);
      }
    });
    ws.on('close', () => client.disconnect());

    // Connect to OpenAI Realtime API
    try {
      this.log(`Connecting to OpenAI...`);
      await client.connect();
    } catch (e) {
      this.log(`Error connecting to OpenAI: ${e.message}`);
      ws.close();
      return;
    }
    this.log(`Connected to OpenAI successfully!`);
    while (messageQueue.length) {
      messageHandler(messageQueue.shift());
    }
  }

  log(...args) {
    console.log(`[RealtimeRelay]`, ...args);
  }
}
